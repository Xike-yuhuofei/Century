/** P1.3：失败归因（合法公开状态、可复现、反事实边界内）。
 *
 * 输入：paired A/B 证据（candidate vs 冻结冠军，同种子/同对手/同席位）。
 * 输出：结构化的 FailureCase：
 *   - 动作分歧（双臂焦点席位动作分布 L1 距离）；
 *   - 结果翻转类型（candidate 赢/冠军赢/双赢/双输）；
 *   - 按人数分层；
 *   - 结论状态 supported / weakened / rejected / inconclusive。
 *
 * 边界：
 * - 只使用证据中对局产生的公开可观察量（动作计数、名次、分数、胜负）；
 * - 不使用隐藏牌序，不做"用真实牌序给候选额外信息"的反事实；
 * - 单场胜负不等于决策错误：只有"同种子同配置下候选与冠军决策路径不同且结果
 *   系统性翻转"才升级为 supported。
 */

import { assertCondition, sha256Canonical } from './core.mjs';

const ACTION_KEYS = ['acquire', 'claim', 'rest', 'play', 'discard'];

function actionL1(a, b) {
  if (!a || !b) return null;
  let sum = 0;
  let totalA = 0;
  let totalB = 0;
  for (const key of ACTION_KEYS) {
    const x = Number(a[key] ?? 0);
    const y = Number(b[key] ?? 0);
    sum += Math.abs(x - y);
    totalA += x;
    totalB += y;
  }
  const denom = Math.max(totalA, totalB, 1);
  return Number((sum / denom).toFixed(6));
}

/**
 * 逐配对比较候选与冠军的动作/结果。
 *
 * @param {object} options
 * @param {object} options.evidence 配对证据（compiled-game-evaluator 输出）
 * @param {string} [options.candidateId]
 * @param {number} [options.minSamplesPerStratum] 每层最小样本（默认 8 对）
 */
export function diagnosePairedEvidence({ evidence, candidateId = null, minSamplesPerStratum = 8 }) {
  assertCondition(evidence?.games?.length, '失败归因需要对局明细');
  const rows = evidence.games;
  const byPair = new Map();
  for (const row of rows) {
    if (row.status !== 'finished') continue;
    const key = `${row.seed}:${row.focusSeat}:${row.seatCount}`;
    if (!byPair.has(key)) byPair.set(key, {});
    byPair.get(key)[row.arm] = row;
  }
  const divergences = [];
  for (const [key, arms] of byPair.entries()) {
    const a = arms.A;
    const b = arms.B;
    if (!a || !b) continue;
    const actionDistance = actionL1(a.focusActions, b.focusActions);
    const outcomeFlip = {
      candidateFirst: a.firstPlace === true,
      championFirst: b.firstPlace === true,
    };
    divergences.push({
      key,
      seed: a.seed,
      seatCount: a.seatCount,
      focusSeat: a.focusSeat,
      actionDistance,
      candidateRank: a.rank,
      championRank: b.rank,
      scoreDelta: (a.score ?? 0) - (b.score ?? 0),
      outcomeFlip,
      category: outcomeFlip.candidateFirst && !outcomeFlip.championFirst ? 'candidate-win-flip'
        : !outcomeFlip.candidateFirst && outcomeFlip.championFirst ? 'champion-win-flip'
          : outcomeFlip.candidateFirst && outcomeFlip.championFirst ? 'both-first'
            : 'neither-first',
    });
  }

  const strata = {};
  for (const d of divergences) {
    const key = String(d.seatCount);
    if (!strata[key]) {
      strata[key] = {
        seatCount: d.seatCount, pairs: 0, actionDiverged: 0, candidateWins: 0, championWins: 0,
        bothFirst: 0, neitherFirst: 0, meanActionDistance: 0,
      };
    }
    const s = strata[key];
    s.pairs += 1;
    if (d.actionDistance !== null && d.actionDistance > 0.1) s.actionDiverged += 1;
    if (d.outcomeFlip.candidateFirst) s.candidateWins += 1;
    if (d.outcomeFlip.championFirst) s.championWins += 1;
    if (d.category === 'both-first') s.bothFirst += 1;
    if (d.category === 'neither-first') s.neitherFirst += 1;
    if (d.actionDistance !== null) s.meanActionDistance += d.actionDistance;
  }
  for (const s of Object.values(strata)) {
    s.meanActionDistance = Number((s.meanActionDistance / Math.max(1, s.pairs)).toFixed(6));
    // 结论规则（预注册式，固定阈值，不随结果调整）：
    // - 样本不足 → inconclusive；
    // - 冠军赢翻转显著多于候选赢翻转 → supported（候选在该层存在系统性弱点）；
    // - 候选赢翻转显著多于冠军 → rejected（该层不是弱点）；
    // - 其余 → weakened。
    const candidateWinFlips = s.candidateWins - s.bothFirst;
    const championWinFlips = s.championWins - s.bothFirst;
    let status = 'inconclusive';
    if (s.pairs >= minSamplesPerStratum) {
      if (championWinFlips >= candidateWinFlips + 2 && championWinFlips >= s.pairs * 0.25) status = 'supported';
      else if (candidateWinFlips >= championWinFlips + 2) status = 'rejected';
      else status = 'weakened';
    }
    s.verdict = status;
    s.candidateWinFlips = candidateWinFlips;
    s.championWinFlips = championWinFlips;
  }

  const failureCases = Object.entries(strata)
    .filter(([, s]) => s.verdict === 'supported' || s.verdict === 'weakened')
    .map(([seatCount, s]) => ({
      category: 'paired-first-place-weakness',
      seatCount: Number(seatCount),
      status: s.verdict,
      detail: `${seatCount} 人层：冠军赢翻转 ${s.championWinFlips} vs 候选赢翻转 ${s.candidateWinFlips}` +
        `（配对 ${s.pairs}，动作分歧对 ${s.actionDiverged}，平均动作 L1 ${s.meanActionDistance}）`,
      reproducible: false,
    }));

  const summary = {
    schema: 'century-failure-diagnosis-v1',
    candidateId: candidateId ?? evidence.candidateId ?? null,
    evidenceHash: sha256Canonical(evidence),
    pairs: divergences.length,
    actionDivergedPairs: divergences.filter(d => d.actionDistance !== null && d.actionDistance > 0.1).length,
    strata,
    failureCases,
    note: '结论只针对配对观测；单场胜负不升级为因果结论，需新种子独立复现',
  };
  return { summary, divergences };
}
