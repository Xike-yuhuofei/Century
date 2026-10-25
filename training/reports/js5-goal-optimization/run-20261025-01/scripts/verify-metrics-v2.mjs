/** 29 局真人记录：v1 旧口径 vs v2 修正口径对账（研究证据，不写回 analytics 旧产物）。
 *
 * 输出：evidence/metrics-v2-summary.json
 * 用法：node .../scripts/verify-metrics-v2.mjs
 */
import { writeFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { importGameFiles } from '../../../../../training/human-analytics/import-games.mjs';
import { computeGameMetrics } from '../../../../../training/human-analytics/metrics.mjs';
import { computeFailureDiagnosis } from '../../../../../training/human-analytics/failures.mjs';
import { loadEngine } from '../../../../../training/human-analytics/engine-link.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN = resolve(HERE, '..');
const REPO = resolve(RUN, '../../../..');
const files = readdirSync(join(REPO, 'century-replays')).filter(f => f.endsWith('.json')).sort()
  .map(f => join(REPO, 'century-replays', f));

const imported = await importGameFiles(files);
const { data } = await loadEngine();

const summary = {
  schema: 'js5-goal-metrics-v2-verification-v1',
  games: 0, rejected: 0,
  v1: { deadCards: 0, discardedEvents: 0, discardedCrystalsByColorSum: 0, contestedOpportunityEvents: 0, missedClaimRecords: 0 },
  v2: {
    deadCards: 0, usedThenRecovered: 0, discardedEvents: 0, discardedCrystals: 0,
    contestedOpportunityEvents: 0, uniqueClaimEvents: 0,
    missedClaimRecords: 0, claimedLaterBySelf: 0, claimedLaterByOther: 0, claimedNever: 0,
    uniqueFirstLossTargets: 0, repeatMissRecords: 0,
    triggerTimeRankingGames: 0,
  },
  byGame: [],
  failureLabelSeatCountsV2: {},
};

const failureTotals = {};
for (const r of imported) {
  if (!r.ok) { summary.rejected++; continue; }
  summary.games++;
  const m = await computeGameMetrics(r);
  const diag = computeFailureDiagnosis(m);
  for (const [code, v] of Object.entries(diag.summary)) {
    failureTotals[code] = (failureTotals[code] ?? 0) + v.seatCount;
  }
  let v1DiscardSum = 0, v2Dead = 0, v2Recovered = 0, v2DiscardCount = 0, v2DiscardPieces = 0;
  for (const p of m.players) {
    const o = p.kind.observable;
    v1DiscardSum += o.discards.reduce((s, d) => s + d.colors.reduce((a, c) => a + c, 0), 0);
    v2Dead += o.deadCards.length;
    v2Recovered += (o.usedThenRecovered ?? []).length;
    v2DiscardCount += o.discards.length;
    v2DiscardPieces += o.crystalsDiscarded;
  }
  summary.v1.discardedEvents += v2DiscardCount;
  summary.v1.discardedCrystalsByColorSum += v1DiscardSum;
  summary.v2.deadCards += v2Dead;
  summary.v2.usedThenRecovered += v2Recovered;
  summary.v2.discardedEvents += v2DiscardCount;
  summary.v2.discardedCrystals += v2DiscardPieces;
  summary.v2.contestedOpportunityEvents += m.contestedLosses.length;
  summary.v2.uniqueClaimEvents += new Set(m.contestedLosses.map(e => e.claimEventId)).size;
  summary.v2.missedClaimRecords += m.missedClaims.length;
  summary.v2.claimedLaterBySelf += m.missedClaims.filter(x => x.claimedLaterBySelf).length;
  summary.v2.claimedLaterByOther += m.missedClaims.filter(x => x.claimedLaterByOther).length;
  summary.v2.claimedNever += m.missedClaims.filter(x => x.claimedLaterBy == null).length;
  summary.v2.uniqueFirstLossTargets += m.missedClaims.filter(x => x.firstLossOfTarget && x.claimedLaterByOther).length;
  summary.v2.repeatMissRecords += m.missedClaims.filter(x => x.repeatOfEarlierMiss).length;
  if (m.game.meta.triggerRanking) summary.v2.triggerTimeRankingGames++;
  summary.byGame.push({
    file: r.file,
    seats: m.players.length,
    deadCardsV2: v2Dead,
    usedThenRecovered: v2Recovered,
    discards: v2DiscardCount,
    discardedCrystals: v2DiscardPieces,
    missed: m.missedClaims.length,
    self: m.missedClaims.filter(x => x.claimedLaterBySelf).length,
    other: m.missedClaims.filter(x => x.claimedLaterByOther).length,
    triggerTimeRank: !!m.game.meta.triggerRanking,
  });
}

summary.v1.deadCards = null; // v1 精确值来自原 analytics 产物（472）；本脚本只复算 v2
summary.v1.note = 'v1 deadCards=472、discardedCrystals=4 为三份原报告对原 analytics 的记数；本脚本不重写旧产物。v1DiscardSum 展示颜色编号求和的偏差来源。';
summary.v1.discardedCrystalsByColorSum = summary.v1.discardedCrystalsByColorSum;
summary.failureLabelSeatCountsV2 = failureTotals;
summary.v2.note = 'exact: dead cards = acquired-never-played; discard pieces = colors.length; missed claims distinguish self/other and first loss of target.';
summary.v2.seatDiscardCheck = summary.v2.discardedCrystals;

writeFileSync(join(RUN, 'evidence', 'metrics-v2-summary.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(JSON.stringify({
  games: summary.games,
  rejected: summary.rejected,
  discardedEvents: summary.v2.discardedEvents,
  discardedCrystals: summary.v2.discardedCrystals,
  colorSumBias: summary.v1.discardedCrystalsByColorSum,
  deadCardsV2: summary.v2.deadCards,
  usedThenRecovered: summary.v2.usedThenRecovered,
  missedRecords: summary.v2.missedClaimRecords,
  self: summary.v2.claimedLaterBySelf,
  other: summary.v2.claimedLaterByOther,
  never: summary.v2.claimedNever,
  uniqueLossTargets: summary.v2.uniqueFirstLossTargets,
  repeats: summary.v2.repeatMissRecords,
  opportunityEvents: summary.v2.contestedOpportunityEvents,
  uniqueClaimEvents: summary.v2.uniqueClaimEvents,
  failureSeatCounts: failureTotals,
}, null, 2));
