/** JS5 Goal 优化基线冻结（修改前一次性快照；可重跑但会覆盖本 manifest）。
 *
 * 纪律：
 * - 只读源码/build/config/输入；不修改冠军、账本、正式验证池。
 * - 配置身份以"实际 resolved options + 运行时分派探针"为准，不信版本名称。
 * - 探针使用 AI6 战术局面块种子 1_500_000_000（该块用于固定工作量测试，
 *   本脚本只做一次分派探针，不进入任何胜率统计）。
 *
 * 用法：node training/reports/js5-goal-optimization/run-20261025-01/scripts/freeze-baseline.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createGame, applyAction } from '../../../../../web-v1/dist/js/engine.js';
import { chooseAIAction, NEUTRAL_PROFILE } from '../../../../../web-v1/dist/js/ai.js';
import { chooseJointAction } from '../../../../../web-v1/dist/js/js/adapter.js';
import { CHAMPION_PARAMETERS } from '../../../../../web-v1/dist/js/ai/parameters.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');
const REPO = resolve(RUN, '../../../..');

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const fileHash = (rel) => sha256(readFileSync(join(REPO, rel)));
const stableStringify = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};
const configHash = (value) => sha256(stableStringify(value));

const legacy = JSON.parse(readFileSync(join(REPO, 'web-v1/tests/fixtures/legacy-champion.json'), 'utf8'));

/** 适配器默认解析（champion-guided.ts 缺省值的显式投影）。 */
const adapterDefaults = {
  gateMode: 'auto', contestThreshold: 0.85, candidateCap: 4,
  overrideMargin: 0.02, claimRanking: 'enumeration',
  championStructure: 'beam-rollout', worlds: 4, horizon: 48,
  opponentMode: 'rule', evaluator: 'L2',
};

const webProduction = {
  path: 'web-v1/src/app.ts scheduleBot → chooseAIAction(game)（无 options）',
  parametersId: CHAMPION_PARAMETERS.id,
  adapter: CHAMPION_PARAMETERS.adapter,
  jointVersion: CHAMPION_PARAMETERS.jointVersion,
  budgetMode: 'wall-clock',
  budgetMs: CHAMPION_PARAMETERS.budgetMs,
  workUnits: null,
  profileMode: 'omitted→NEUTRAL_PROFILE（app 不注入 profile）',
  simSeed: 0,
  acquisitionVariant: CHAMPION_PARAMETERS.acquisitionVariant,
  ...adapterDefaults,
  candidatePolicy: 'baseline',
};
const trainingDuel = {
  path: 'training/joint/duel.mjs runGame → chooseJointAction（按席位人格 + simSeed=seed）',
  parametersId: CHAMPION_PARAMETERS.id,
  adapter: CHAMPION_PARAMETERS.adapter,
  jointVersion: CHAMPION_PARAMETERS.jointVersion,
  budgetMode: 'caller (budgetMs | workUnits)',
  profileMode: 'seatProfile（seat0=NEUTRAL，seat1..4=PROFILES）',
  simSeed: '对局种子',
  acquisitionVariant: CHAMPION_PARAMETERS.acquisitionVariant,
  ...adapterDefaults,
  candidatePolicy: 'baseline',
};
const pureBeam = {
  path: '显式 legacy fixture → chooseAIAction(parameters, profile=NEUTRAL)',
  parametersId: legacy.id,
  adapter: null,
  structure: legacy.structure,
  acquisitionVariant: legacy.acquisitionVariant,
  profileName: NEUTRAL_PROFILE.name,
  budgetMode: 'none (beam search, 无联合模拟)',
  jointSearch: null,
};
const js5OptLabelOnly = {
  path: 'chooseJointAction(version=joint-js5-opt) — 当前仅标签不同，未注入独有预设',
  ...webProduction,
  jointVersion: 'joint-js5-opt',
};

/** 运行时分派探针：同一公开局面下确认实际走了哪条分支。 */
function dispatchProbe() {
  let g = createGame(['A', 'B', 'C', 'D', 'E'], 1_500_000_000, [1, 2, 3, 4]);
  g.players[0].isAI = true;
  for (let i = 0; i < 24; i++) {
    const r = chooseAIAction(g, { parameters: legacy, profile: NEUTRAL_PROFILE });
    g = applyAction(g, r.action);
  }
  const active = chooseAIAction(g, { profile: NEUTRAL_PROFILE });
  const beam = chooseAIAction(g, { parameters: legacy, profile: NEUTRAL_PROFILE });
  const joint = chooseJointAction(g, { version: 'joint-js5', budgetMs: 100, simSeed: 0, profile: NEUTRAL_PROFILE });
  return {
    seed: 1_500_000_000,
    position: { turnNumber: g.turnNumber, current: g.current, phase: g.phase },
    activeChampionDispatch: {
      reason: active.reason.slice(0, 120),
      action: active.action,
      isJointAdapter: active.reason.startsWith('js5') || active.reason.includes('联合仲裁') || active.reason.includes('冠军直通'),
    },
    explicitLegacyBeam: {
      reason: beam.reason.slice(0, 120),
      action: beam.action,
      isBeamReason: beam.reason.startsWith('AI 4.0'),
    },
    explicitJs5Adapter: {
      reason: joint.reason.slice(0, 120),
      action: joint.action,
      gated: joint.joint?.gated ?? null,
      championAction: joint.joint?.championAction ?? null,
      stats: joint.joint?.stats ?? null,
    },
  };
}

const keyFiles = [
  'web-v1/src/engine.ts',
  'web-v1/src/data.ts',
  'web-v1/src/replay.ts',
  'web-v1/src/ai/decision.ts',
  'web-v1/src/ai/parameters.ts',
  'web-v1/src/ai/planner.ts',
  'web-v1/src/ai/evaluator.ts',
  'web-v1/src/ai/observation.ts',
  'web-v1/src/js/champion-guided.ts',
  'web-v1/src/js/adapter.ts',
  'web-v1/src/js/rollout-policy.ts',
  'web-v1/src/js/joint-rollout.ts',
  'web-v1/src/js/evaluators.ts',
  'web-v1/src/js/types.ts',
  'web-v1/src/ai-runtime/protocol.ts',
  'web-v1/src/ai-runtime/decision-core.ts',
  'training/champions/champion.json',
  'data/cards.json',
  'web-v1/package-lock.json',
  'web-v1/dist/js/engine.js',
  'web-v1/dist/js/js/champion-guided.js',
  'web-v1/dist/js/ai/parameters.js',
  'ai5/lib/seed_policy.mjs',
  'training/joint/duel.mjs',
  'training/human-analytics/metrics.mjs',
  'training/human-analytics/failures.mjs',
  'training/human-analytics/cases.mjs',
];

const inputFiles = readdirSync(join(REPO, 'century-replays'))
  .filter(f => f.endsWith('.json'))
  .sort()
  .map(f => ({ file: f, sha256: fileHash(`century-replays/${f}`) }));

const manifest = {
  schema: 'js5-goal-baseline-manifest-v1',
  runId: 'run-20261025-01',
  frozenAt: new Date().toISOString(),
  objective: '修复计量/对照身份问题，实现并验证临近终局候选保留与预算有效性；不替换正式冠军。',
  environment: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  git: {
    branch: 'codex/js5-evidence-optimization',
    baseCommit: process.env.BASELINE_GIT_COMMIT ?? null,
    trackedDirty: process.env.BASELINE_TRACKED_DIRTY ?? null,
  },
  sourceHashes: Object.fromEntries(keyFiles.map(f => [f, fileHash(f)])),
  inputs: {
    replayCount: inputFiles.length,
    replaySetHash: sha256(inputFiles.map(x => `${x.file} ${x.sha256}`).join('\n')),
    files: inputFiles,
  },
  configs: {
    webProduction: { ...webProduction, hash: configHash(webProduction) },
    trainingDuel: { ...trainingDuel, hash: configHash(trainingDuel) },
    pureBeam: { ...pureBeam, hash: configHash(pureBeam) },
    js5OptLabelOnly: { ...js5OptLabelOnly, hash: configHash(js5OptLabelOnly) },
  },
  dispatchProbe: dispatchProbe(),
  notes: [
    '网页生产默认：无 profile → NEUTRAL_PROFILE；simSeed 缺省 0；100ms 墙钟。',
    '训练 duel：按席位人格 + simSeed=对局种子；预算由 CLI 指定。',
    '纯束搜索基线必须显式钉定 legacy fixture（web-v1/tests/fixtures/legacy-champion.json），不得传活动 CHAMPION_PARAMETERS。',
    'joint-js5-opt 在本基线上仅是版本标签：未注入独有预设，resolved options 与 joint-js5 相同。',
    '对局全部作为发现集；未来评测使用独立研究种子块，不消费正式验证池 [900M,1.06e9)。',
  ],
};

writeFileSync(join(RUN, 'BASELINE-MANIFEST.json'), JSON.stringify(manifest, null, 2) + '\n');
process.stdout.write(`BASELINE-MANIFEST.json 已写入（${inputFiles.length} 局输入，${keyFiles.length} 个源码/配置哈希）\n`);
process.stdout.write(`web=${manifest.configs.webProduction.hash.slice(0, 16)} duel=${manifest.configs.trainingDuel.hash.slice(0, 16)} beam=${manifest.configs.pureBeam.hash.slice(0, 16)} opt=${manifest.configs.js5OptLabelOnly.hash.slice(0, 16)}\n`);
