/** 训练对手池（审计整改：训练对手过于单一）。
 *
 * 此前候选只在"候选 vs 冠军"混战中评估，容易得到擅长击败自身版本、
 * 却不一定能应对不同风格对手的参数。本模块构造多样化对手池：
 * - 冠军本体（晋级语义的基准）；
 * - 中立基线参数（与冠军不同行为时提供参照）；
 * - 冠军的风格变体（tempo/contest/engine 加权扰动，仍走同一决策核心）；
 * - 历史冠军档案（training/champions/candidates/ 下的晋级归档），
 *   实现跨版本对抗，防止"只在最新版本之间内卷"。
 *   P1 复审修复：历史冠军享保底席位（此前按填充顺序排在末尾，
 *   默认池容量 5 时永远无法入池）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PARAMETER_BOUNDS, validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';

const clampBound = (key, value) => {
  const [low, high] = PARAMETER_BOUNDS[key];
  return Math.min(high, Math.max(low, value));
};

const ADAPTER_FIELDS = ['adapter', 'jointVersion', 'budgetMs'];

/** 束搜索基座归一化（2026-10-24 audit 修复）：剥离适配器字段 + 补齐缺省权重 1.0。
 *
 * 背景：适配器冠军（CHAMPION_PARAMETERS.adapter='champion-guided'，AI6 第五阶段）
 * 的权重乘子不参与决策且归档常缺省权重键。任何从当前冠军**浅拷贝**派生的风格
 * 变体都会携带 adapter 字段，被 web-v1/src/ai/decision.ts 静默分派到联合搜索——
 * 权重 100% 失效，变体行为 ≡ 冠军本体（行为探针：携带 adapter 变体与冠军行动
 * 逐位一致 48/48）。本函数强制变体/历史归档走束搜索核心且权重真实生效：
 * - 剥离 adapter/jointVersion/budgetMs；
 * - 缺省权重键补 1.0（与适配器口径的隐含缺省一致）；
 * - 结构：原参数携带 adapter 时缺省 beam-rollout（冠军引导核心的束搜索基座，
 *   与 training/adversarial/registry.mjs championBaseParameters 同口径）；
 *   非适配器冠军原样保留 structure（不改变既有行为）。
 */
export function beamBaseParameters(params) {
  const wasAdapter = params?.adapter !== undefined;
  const base = { ...params };
  for (const key of ADAPTER_FIELDS) delete base[key];
  for (const key of Object.keys(PARAMETER_BOUNDS)) {
    if (base[key] === undefined) base[key] = 1;
  }
  if (wasAdapter && base.structure === undefined) base.structure = 'beam-rollout';
  return base;
}

/** 由冠军参数派生 3 个风格化对手（束搜索基座 + 权重扰动，决策核心不随冠军分派）。
 * audit 修复：基座经 beamBaseParameters 归一化——适配器冠军派生不再携带 adapter，
 * 权重扰动真实生效。 */
export function styleVariants(champion) {
  const base = beamBaseParameters(champion);
  const raw = [
    { ...base, id: `${champion.id}@tempo`, tempoWeight: base.tempoWeight * 1.35, restWeight: base.restWeight * 0.8 },
    { ...base, id: `${champion.id}@contest`, contestWeight: base.contestWeight * 1.4, goalWeight: base.goalWeight * 1.15 },
    { ...base, id: `${champion.id}@engine`, engineWeight: base.engineWeight * 1.3, endgameWeight: base.endgameWeight * 1.1 },
  ];
  return raw.map(p => validateAIParameters({
    ...p,
    tempoWeight: clampBound('tempoWeight', p.tempoWeight),
    restWeight: clampBound('restWeight', p.restWeight),
    contestWeight: clampBound('contestWeight', p.contestWeight),
    goalWeight: clampBound('goalWeight', p.goalWeight),
    engineWeight: clampBound('engineWeight', p.engineWeight),
    endgameWeight: clampBound('endgameWeight', p.endgameWeight),
  }));
}

/** 历史冠军档案：读取归档目录下的晋级候选（按文件名排序取最近 limit 个）。 */
export function historicalChampions(archiveDir, { excludeId = null, limit = 3 } = {}) {
  let files = [];
  try {
    files = readdirSync(archiveDir).filter(f => f.endsWith('.json')).sort();
  } catch {
    return []; // 归档目录不存在（尚无晋级历史）不是错误
  }
  const versions = [];
  for (const file of files.slice(-limit)) {
    try {
      const data = JSON.parse(readFileSync(join(archiveDir, file), 'utf8'));
      const parameters = data.parameters ?? data;
      if (parameters?.id && parameters.id !== excludeId) {
        // audit 修复：历史归档统一归一化为束搜索基座（适配器冠军归档不再以
        // 适配器形态入场——历史对手的价值在行为差异，权重必须真实生效）。
        versions.push(validateAIParameters(beamBaseParameters(parameters)));
      }
    } catch {
      // 单个损坏档案跳过，不影响训练
    }
  }
  return versions;
}

/** 构建对手池：冠军 + 中立基线 + 风格变体 + 历史冠军（按 id 去重、限量）。
 * 席位分配（P1 复审修复）：归档中存在历史冠军时，为其保底 1 席——
 * 此前历史冠军排在填充顺序末尾，默认池容量 5 时永远轮不到，"跨版本防过拟合"
 * 名存实亡。剩余容量按 基线 → 风格变体 → 其余历史版本 顺序填充。
 * @param {object} options
 * @param {object} options.champion 冠军参数
 * @param {object} [options.baseline] 中立基线参数
 * @param {string} [options.archiveDir] 历史冠军归档目录
 * @param {number} [options.maxOpponents] 对手池上限（含冠军）
 */
export function buildOpponentPool({ champion, baseline = null, archiveDir = null, maxOpponents = 5 }) {
  const pool = [validateAIParameters(champion)];
  const push = p => {
    if (pool.length >= maxOpponents) return;
    if (pool.some(x => x.id === p.id)) return;
    pool.push(p);
  };
  const history = archiveDir ? historicalChampions(archiveDir, { excludeId: champion.id, limit: Math.max(maxOpponents, 3) }) : [];
  // 历史冠军保底席位：只要归档里有历史版本且池容量 ≥ 2，就至少保留 1 席。
  if (history.length > 0 && maxOpponents >= 2) push(history[history.length - 1]);
  if (baseline) push(validateAIParameters(baseline));
  for (const variant of styleVariants(champion)) push(variant);
  // 剩余容量继续补充更早的历史版本，让不同代际冠军都有机会进入对抗。
  for (const old of history.slice(0, -1)) push(old);
  return pool;
}
