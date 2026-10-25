/** 战术基准库·公开/私有数据层分离（AI6 合并后整改 P1-3）。
 *
 * 缺陷背景：data/scenarios.jsonl 的完整局面记录包含 engineState.position——
 * 其中存在研究侧使用的真实隐藏牌库序（merchantDeck/golemDeck）。虽有
 * containsHiddenInfo 标记，但未来 AI 训练工具直接读取整份 JSONL 就会接触
 * 隐藏信息（信息公平性风险）。
 *
 * 分层设计（两种数据、两个目录、稳定 scenarioId 关联）：
 * - Public Dataset（data/public/scenarios.public.jsonl）：只含当前席位合法可知
 *   信息（publicView）、合法行动、公开局面分类、决策分歧、允许公开的评测标签
 *   （oracle 结论 + exact-under-recorded-deck 诚实限定 + 监督使用警告）。
 *   绝不包含：隐藏牌库序（position）、gameSeed（种子 + 引擎 commit 可确定性
 *   重导出牌库序，同等隐藏）。AI 训练/搜索输入只允许经本层接口读取。
 * - Private Oracle Dataset（data/private/scenarios.private-oracle.jsonl）：
 *   正式引擎精确回放/复演所必需的完整状态（真实隐藏牌库 position + gameSeed）。
 *   只允许进入离线评估器（oracle 复算、重放验证），绝不进入 AI 决策输入。
 *
 * Oracle 语义（诚实限定，随公开层逐条披露）：exact-under-recorded-deck 只是
 * 在记录的实际牌库序列下的局部穷举结果，不是不完全信息博弈中的普适最优
 * 策略证明；不得将 oracle 返回值无条件作为神经网络监督学习的最优行动标签。
 *
 * 无损迁移：splitScenarioRecord + mergeScenarioRecords 保证 public+private ⇄
 * 原始记录逐字节等价（测试固化）；原始语料 scenarios.jsonl 保留不覆盖。
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

export const PUBLIC_SCHEMA = 'century-tactical-scenario-public-v1';
export const PRIVATE_SCHEMA = 'century-tactical-scenario-private-oracle-v1';

/** 公开层禁止出现的键（递归扫描口径）：隐藏牌库序与可重导出牌库序的种子。 */
export const PUBLIC_FORBIDDEN_KEYS = Object.freeze(['merchantDeck', 'golemDeck', 'position', 'gameSeed']);

const ORACLE_USAGE_NOTE = 'oracle 结论 = exact-under-recorded-deck 局部穷举（仅在记录的实际牌库序列下成立），不是不完全信息博弈的普适最优策略证明；不得无条件用作神经网络监督学习的最优行动标签。';

/** 拆分一条原始记录 → {publicRecord, privateRecord}（纯函数，不写盘）。 */
export function splitScenarioRecord(record) {
  const { engineState, ...rest } = record;
  if (!engineState?.position) throw new Error(`记录 ${record.id} 缺少 engineState.position（原始语料必须完整）`);
  const provenance = { ...rest.provenance };
  const gameSeed = provenance.gameSeed;
  if (typeof gameSeed !== 'number') throw new Error(`记录 ${record.id} 缺少 provenance.gameSeed`);
  delete provenance.gameSeed;

  const publicRecord = {
    ...rest,
    schema: PUBLIC_SCHEMA,
    provenance,
    // 隐藏状态指针：公开层只披露私有层位置，不披露内容。
    hiddenStateRef: {
      dataset: 'data/private/scenarios.private-oracle.jsonl',
      scenarioId: record.id,
      containsHiddenInfo: true,
      note: '真实隐藏牌库序（position）与 gameSeed 只存在于私有 oracle 层；AI 决策输入只允许本公开层。',
    },
    ...(record.oracle ? { oracleUsageNote: ORACLE_USAGE_NOTE } : {}),
  };

  const privateRecord = {
    schema: PRIVATE_SCHEMA,
    scenarioId: record.id,
    gameSeed,
    engineState,
    note: '仅供离线评估器（oracle 复算 / 正式引擎精确重放）使用；禁止进入任何 AI 决策/搜索输入。',
  };
  return { publicRecord, privateRecord };
}

/** 深度校验公开记录：任意层级不得出现禁止键。违规键列表返回（空 = 干净）。 */
export function assertPublicNoHiddenInfo(publicRecords) {
  const violations = [];
  const scan = (value, path, depth) => {
    if (depth > 8 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => scan(v, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (PUBLIC_FORBIDDEN_KEYS.includes(key)) violations.push(`${path}.${key}`);
      else scan(child, `${path}.${key}`, depth + 1);
    }
  };
  for (const record of publicRecords) scan(record, record.id ?? '?', 0);
  return violations;
}

/** 无损合并：public + private → 原始记录（逐字段还原；测试与复算工具共用）。 */
export function mergeScenarioRecords(publicRecord, privateRecord) {
  if (publicRecord.id !== privateRecord.scenarioId) {
    throw new Error(`scenarioId 不匹配：public=${publicRecord.id} private=${privateRecord.scenarioId}`);
  }
  const restored = {
    ...structuredClone(publicRecord),
    schema: 'century-tactical-scenario-v1',
    provenance: { ...structuredClone(publicRecord.provenance), gameSeed: privateRecord.gameSeed },
    engineState: structuredClone(privateRecord.engineState),
  };
  delete restored.hiddenStateRef;
  delete restored.oracleUsageNote;
  return restored;
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 从原始语料生成双层数据集（确定性；manifest 记录输入指纹与计数）。 */
export function writeSplitDataset(rawJsonlPath, scenariosRoot) {
  const raw = readFileSync(rawJsonlPath, 'utf8');
  const records = raw.trim().split('\n').map(line => JSON.parse(line));
  const pairs = records.map(splitScenarioRecord);
  const publicDir = join(scenariosRoot, 'data', 'public');
  const privateDir = join(scenariosRoot, 'data', 'private');
  mkdirSync(publicDir, { recursive: true });
  mkdirSync(privateDir, { recursive: true });
  const publicPath = join(publicDir, 'scenarios.public.jsonl');
  const privatePath = join(privateDir, 'scenarios.private-oracle.jsonl');
  writeFileSync(publicPath, pairs.map(p => JSON.stringify(p.publicRecord)).join('\n') + (pairs.length ? '\n' : ''));
  writeFileSync(privatePath, pairs.map(p => JSON.stringify(p.privateRecord)).join('\n') + (pairs.length ? '\n' : ''));

  // 生成后立即自检：公开层不得含禁止键（生成器自带泄漏门）。
  const violations = assertPublicNoHiddenInfo(pairs.map(p => p.publicRecord));
  if (violations.length) {
    throw new Error(`公开层数据泄漏（生成中止）：\n${violations.join('\n')}`);
  }

  const manifest = {
    schema: 'century-tactical-scenario-split-manifest-v1',
    rawSource: 'data/scenarios.jsonl（原始语料，保留不覆盖）',
    rawSha256: sha256File(rawJsonlPath),
    publicPath: 'data/public/scenarios.public.jsonl',
    publicSha256: sha256File(publicPath),
    privatePath: 'data/private/scenarios.private-oracle.jsonl',
    privateSha256: sha256File(privatePath),
    scenarioCount: records.length,
    publicForbiddenKeys: PUBLIC_FORBIDDEN_KEYS,
    oracleSemantics: ORACLE_USAGE_NOTE,
    layers: {
      public: 'AI 训练/搜索输入唯一合法数据接口（无隐藏牌库、无 gameSeed）',
      private: '仅限离线评估器（oracle 复算 / 引擎精确重放）',
    },
  };
  writeFileSync(join(scenariosRoot, 'data', 'split-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { publicPath, privatePath, manifest };
}

/** 公开层读取接口（AI 训练/搜索输入唯一合法入口）。
 * 读取后强制执行泄漏扫描——文件被误改/误写时 fail-closed。 */
export function loadPublicScenarios(scenariosRoot) {
  const path = join(scenariosRoot, 'data', 'public', 'scenarios.public.jsonl');
  if (!existsSync(path)) throw new Error(`公开层数据集不存在：${path}（先运行 scripts/split-dataset.mjs）`);
  const records = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  const violations = assertPublicNoHiddenInfo(records);
  if (violations.length) {
    throw new Error(`公开层数据集泄漏检查失败（fail-closed，禁止作为 AI 输入）：\n${violations.join('\n')}`);
  }
  return records;
}

/** 私有 oracle 层读取接口（仅限离线评估器；调用方必须自证用途）。 */
export function loadPrivateOracle(scenariosRoot, { purpose = null } = {}) {
  if (!purpose || !/oracle|replay|评估器|复算|重放/i.test(purpose)) {
    throw new Error('私有 oracle 层只允许离线评估器用途（必须显式声明 purpose=oracle/replay/评估器/复算/重放）');
  }
  const path = join(scenariosRoot, 'data', 'private', 'scenarios.private-oracle.jsonl');
  if (!existsSync(path)) throw new Error(`私有层数据集不存在：${path}`);
  return readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
