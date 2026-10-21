/** 参数进化优化器（任务书第六节·第一阶段参数进化）。
 *
 * 方法：(μ,λ) 进化策略 + 逐代收缩步长，结构简单、可复现、可断点续训。
 * - 候选生成：冠军参数 + 对数尺度高斯扰动（每参数独立 σ），夹取到合法区间。
 * - 快速筛选：每个候选在训练种子上与冠军双向对战，淘汰明显劣势者。
 * - 精细评估：胜过冠军的最佳候选交由调用方用独立验证种子做确认挑战。
 * - 全程记录：随机种子、参数、评估结果经 onGeneration / 实验日志回调导出。
 * - 断点续训：状态对象可序列化；持久化与恢复由 CLI 层负责。
 * - 冠军切换防护（P0）：恢复断点时校验冠军身份指纹（id+结构+参数），
 *   冠军已换人则旧精英池/待定候选强制失效，从新冠军重新出发。
 * - 训练种子分配（P0 可靠性整改）：每候选固定预留 1000 种子的块对齐块，
 *   全部落在训练池 [0, 900M) 内（验证池 ≥ 900M 物理隔离、永不越界）；
 *   候选生成 rng 与游戏种子分流（rngCursor / seedCursor 独立游标）；
 *   旧版断点（游标×1000 语义）恢复时自动迁移，事件落盘可审计。
 */

import { mulberry32, gaussian, clamp } from '../lib/rng.mjs';
import { runChallenge } from '../tournament/challenge.mjs';
import { PARAMETER_BOUNDS, validateAIParameters } from '../../web-v1/dist/js/ai/parameters.js';
import {
  alignToTrainingBlock, allocateTrainingBlock, migrateLegacyCursor,
  TRAINING_POOL_MAX, TRAINING_SEED_BLOCK, ENGINE_SEED_MAX,
} from '../lib/seeds.mjs';

const TUNABLE_KEYS = Object.keys(PARAMETER_BOUNDS);

/** 冠军身份指纹：id + 结构 + 全部可调参数值。
 * 断点续训时用于检测冠军是否已切换——旧冠军下的精英池对新冠军不可信。 */
export function championFingerprint(champion) {
  const structure = champion.structure ?? 'beam-lineage';
  const values = TUNABLE_KEYS.map(key => champion[key]);
  return JSON.stringify([champion.id, structure, values]);
}

/** 由父代参数生成一个候选（对数扰动 + 边界约束）。
 * 父代的 structure 字段（结构变体）原样继承——参数进化在选定结构内进行。 */
export function mutateCandidate(parent, { id, sigma, rng }) {
  const candidate = { id };
  for (const key of TUNABLE_KEYS) {
    const [low, high] = PARAMETER_BOUNDS[key];
    const sigmaKey = key === 'endgameWeight' ? sigma * 0.6 : sigma;
    candidate[key] = clamp(parent[key] * Math.exp(gaussian(rng) * sigmaKey), low, high);
  }
  if (parent.structure) candidate.structure = parent.structure;
  return validateAIParameters(candidate);
}

/** 快速对战评估：候选相对冠军的胜率与诊断指标。
 * opponents：可选对手池（审计整改：多样化训练对手）；缺省 = 仅冠军。 */
export function evaluateCandidate(champion, candidate, { seeds, seedBase, maxMoves, deadlineMs, opponents = null }) {
  const { summary } = runChallenge({ champion, candidate, seeds, seedBase, opponents });
  return {
    wins: summary.candidateWins,
    games: summary.finishedGames,
    anomalies: summary.anomalies,
    winRate: summary.candidateWinRate,
    meanScoreDiff: Number((summary.meanScoreDiffCI?.mean ?? 0).toFixed(3)),
    meanRank: summary.meanRankCI?.mean ?? null,
  };
}

/** 排序键：胜率优先，并列看平均分差（诊断指标仅用于打破并列）。 */
export function compareCandidates(a, b) {
  const byWinRate = b.winRate - a.winRate;
  if (byWinRate !== 0) return byWinRate > 0 ? 1 : -1;
  const byScore = b.meanScoreDiff - a.meanScoreDiff;
  return byScore > 0 ? 1 : byScore < 0 ? -1 : 0;
}

export function defaultEvolveOptions() {
  return {
    generations: 3,
    population: 8,
    eliteKeep: 3,
    gamesPerCandidate: 20, // 20 种子 × 2 方向 = 40 局/候选
    seedBase: 100000,
    sigma: 0.18,
  };
}

/**
 * 运行进化循环。
 * @param {object} options
 * @param {object} options.champion 冠军参数（AIParameters，含 id）
 * @param {object} [options.initialState] 断点恢复的状态（来自上次 state 导出）
 * @param {number} [options.generations] 代数
 * @param {Array<object>} [options.opponents] 训练对手池（缺省 = 仅冠军）
 * @param {number|null} [options.deadlineAt] 真实墙钟截止时间（epoch ms，审计整改：
 *        超时前按安全余量停止生成新候选，已完成的整代状态照常持久化，可断点续训）
 * @param {number} [options.safetyMarginMs] 截止安全余量（默认 90s）
 * @param {Function} [options.onGeneration] (state, candidates) => void，每代回调（用于持久化/日志）
 * @returns {{bestCandidate: object|null, improved: boolean, state: object}}
 */
export function evolve({
  champion,
  initialState = null,
  generations, population, eliteKeep, gamesPerCandidate, seedBase, sigma,
  maxMoves, deadlineMs,
  opponents = null,
  deadlineAt = null,
  safetyMarginMs = 90_000,
  onGeneration = null,
  experimentLog = null,
}) {
  const defaults = defaultEvolveOptions();
  const opts = {
    generations: generations ?? defaults.generations,
    population: population ?? defaults.population,
    eliteKeep: eliteKeep ?? defaults.eliteKeep,
    gamesPerCandidate: gamesPerCandidate ?? defaults.gamesPerCandidate,
    seedBase: seedBase ?? defaults.seedBase,
    sigma: sigma ?? defaults.sigma,
  };
  if (!Number.isSafeInteger(opts.seedBase) || opts.seedBase < 0 || opts.seedBase > ENGINE_SEED_MAX) {
    throw new Error(`seedBase 必须为 [0, 2^31) 内的安全整数，实际：${opts.seedBase}`);
  }
  // P0 可靠性整改（训练种子分配）：旧实现 candidateSeedBase = seedCursor++ × 1000，
  // 日期基数（如工作流的 date +%Y%m%d ≈ 2e7）会把种子乘到 ≈ 2e10：
  // 越过 2^31 引擎安全上限（engine.ts generator 按 mod 2^32 回绕，名义种子与实际
  // 生效序列脱钩）、越过训练/验证池边界，且游标无界增长终将与验证种子镜像重叠。
  // 新语义：
  // - state.seedCursor = 下一个训练种子块起点（绝对种子，块对齐，每候选固定预留
  //   TRAINING_SEED_BLOCK=1000 个种子，块完整落在训练池 [0, 900M) 内，越界抛错）；
  // - state.rngCursor = 候选生成 rng 种子（独立游标，逐代 +1，与游戏种子分流）。
  const alignedBase = alignToTrainingBlock(opts.seedBase);
  if (alignedBase + TRAINING_SEED_BLOCK > TRAINING_POOL_MAX) {
    throw new Error(`seedBase ${opts.seedBase} 过高：对齐后 ${alignedBase} 连一个 ${TRAINING_SEED_BLOCK} 种子的候选块都放不下（训练池上限 ${TRAINING_POOL_MAX}）`);
  }
  const state = initialState ?? {
    generation: 0,
    sigma: opts.sigma,
    seedCursor: alignedBase,
    rngCursor: opts.seedBase,
    elites: [],
    history: [],
    pendingCandidate: null,
    championId: champion.id,
    championFingerprint: championFingerprint(champion),
  };
  state.interrupted = false;

  // 旧版断点迁移：旧 state 只有混合语义的 seedCursor（块索引），无 rngCursor。
  // 迁移规则见 lib/seeds.mjs migrateLegacyCursor——训练种子续接在旧已消费块之后，
  // rng 流从旧游标续接，零重复；迁移事件落盘供审计。
  // 注意 state === initialState（同一引用）：必须先捕获旧游标再就地改写。
  if (initialState && initialState.rngCursor === undefined) {
    const legacyCursor = initialState.seedCursor;
    const migrated = migrateLegacyCursor(legacyCursor);
    state.seedCursor = migrated.seedCursor;
    state.rngCursor = migrated.rngCursor;
    state.seedMigration = { from: legacyCursor, to: migrated.seedCursor, rngCursor: migrated.rngCursor, at: new Date().toISOString() };
  }

  // P0 修复（冠军切换后的状态继承）：断点状态是围绕"当时的冠军"搜索的产物。
  // 冠军晋级换人后（id、结构或参数指纹任一变化），旧精英/待定候选继续作为
  // 父代会让进化沿旧结构、旧参数区域搜索，新冠军形同虚设。此处强制失效：
  // 精英池与待定候选清空、步长复位；种子游标保留（训练种子不重复消费），
  // 历史保留（审计可追溯），并记录失效事件。
  const currentFingerprint = championFingerprint(champion);
  if (initialState && initialState.championFingerprint !== currentFingerprint) {
    const discarded = {
      stateChampionId: initialState.championId ?? null,
      eliteCount: Array.isArray(initialState.elites) ? initialState.elites.length : 0,
      hadPendingCandidate: initialState.pendingCandidate != null,
    };
    state.elites = [];
    state.pendingCandidate = null;
    state.sigma = opts.sigma;
    state.championId = champion.id;
    state.championFingerprint = currentFingerprint;
    state.eliteReset = { ...discarded, newChampionId: champion.id, atGeneration: state.generation };
  } else if (initialState) {
    state.championId = champion.id;
    state.championFingerprint = currentFingerprint;
  }

  outer:
  for (let gen = 0; gen < opts.generations; gen++) {
    const rng = mulberry32(state.rngCursor++);
    const parents = state.elites.length
      ? state.elites.map(e => e.parameters)
      : [champion];
    const candidates = [];
    for (let k = 0; k < opts.population; k++) {
      // 真实截止时间：预算将尽时安全退出——未完成的候选直接丢弃，
      // 状态保持"最后一个完整代"的一致性，下次 --resume 从这里继续。
      if (deadlineAt !== null && Date.now() + safetyMarginMs > deadlineAt) {
        state.interrupted = true;
        break outer;
      }
      const parent = parents[k % parents.length];
      const candidate = mutateCandidate(parent, {
        id: `evo-g${state.generation}-${k}`,
        sigma: state.sigma,
        rng,
      });
      // 训练种子块分配（P0 整改）：每候选固定预留 1000 种子的块，块对齐、
      // 互不重叠、完整落在训练池 [0, 900M) 内；池耗尽抛错而非越界。
      const block = allocateTrainingBlock(state.seedCursor);
      const candidateSeedBase = block.base;
      state.seedCursor = block.next;
      const evaluation = evaluateCandidate(champion, candidate, {
        seeds: opts.gamesPerCandidate,
        seedBase: candidateSeedBase,
        maxMoves, deadlineMs, opponents,
      });
      candidates.push({ parameters: candidate, evaluation, seedBase: candidateSeedBase, parentId: parent.id });
      experimentLog?.({
        type: 'candidate', generation: state.generation, candidateId: candidate.id,
        parentId: parent.id, seedBase: candidateSeedBase, evaluation, parameters: candidate,
      });
    }
    candidates.sort((a, b) => compareCandidates(a.evaluation, b.evaluation));
    const best = candidates[0];
    // 宁可保守：只有快速筛选确实胜过冠军（胜率 > 0.5）才推进候选；
    // 否则保留冠军参数作为下代唯一父代，并缩小步长继续搜索。
    if (best.evaluation.winRate > 0.5) {
      state.pendingCandidate = best.parameters;
      state.elites = candidates.slice(0, opts.eliteKeep).map(c => ({
        parameters: c.parameters, winRate: c.evaluation.winRate,
      }));
      state.sigma = Math.max(0.04, state.sigma * 0.85);
    } else {
      state.pendingCandidate = null;
      state.elites = [];
      state.sigma = Math.max(0.04, state.sigma * 0.92);
    }
    state.history = [...(state.history ?? []), {
      generation: state.generation,
      bestId: best.parameters.id,
      bestWinRate: best.evaluation.winRate,
      bestMeanScoreDiff: best.evaluation.meanScoreDiff,
      promoted: state.pendingCandidate !== null,
      populationMeanWinRate: Number((candidates.reduce((s, c) => s + c.evaluation.winRate, 0) / candidates.length).toFixed(4)),
      sigma: Number(state.sigma.toFixed(4)),
    }];
    const generationCandidates = candidates;
    state.generation += 1;
    onGeneration?.(state, generationCandidates);
  }
  return {
    bestCandidate: state.pendingCandidate,
    improved: state.pendingCandidate !== null,
    state,
  };
}
