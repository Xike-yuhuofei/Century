/** 任务 B：战略特征分析（可观察事实 / 算法计算 / 战略推测，三级明确标注）。
 *
 * 输入：import-games.mjs 验证通过的对局（record + timeline + meta）。
 * 输出：逐席位的特征档案 + 对局级事件（终局触发、被抢目标、超额弃置）。
 *
 * 三级语义：
 *   observable — 直接来自对局记录的计数/序列（事实）；
 *   computed   — 由事实经确定性算法推导（含与正式引擎/牌表的一致性计算）；
 *   inferred   — 战略推测，仅供参考，不作为失败判定证据。
 *
 * 纪律：所有序列均按 turnNumber 升序；数值统一 round2；无随机、无时间戳，
 * 同一记录重复运行输出逐字节一致。
 */

import { loadEngine } from './engine-link.mjs';

const round2 = x => Math.round(x * 100) / 100;
const sum = a => a.reduce((s, x) => s + x, 0);
const avg = a => a.length ? round2(sum(a) / a.length) : null;

const ACTION_TYPES = ['play', 'acquire', 'claim', 'rest', 'discard'];

function coinAward(marketCoins, index) {
  // 与正式引擎 applyClaim 的发币规则一致（算法计算，依据公开钱币池）
  if (index === 0 && marketCoins.copper > 0) return 'copper';
  if (index === 0 && marketCoins.copper === 0 && marketCoins.silver > 0) return 'silver';
  if (index === 1 && marketCoins.copper > 0 && marketCoins.silver > 0) return 'silver';
  return null;
}

const crystalTotal = stock => sum(stock);

/** 逐席位档案。 */
function playerProfile(seat, ctx) {
  const { turnsBySeat, timelineByIndex, initialPlayers, lastAfterBySeat, meta, data, engine, contestedLosses, missedClaims } = ctx;
  const own = turnsBySeat.get(seat) ?? [];
  const p0 = initialPlayers[seat];
  const lastAfter = lastAfterBySeat[seat] ?? p0;

  // —— 可观察事实 ——
  const actionsByType = Object.fromEntries(ACTION_TYPES.map(t => [t, 0]));
  const acquires = [];
  const claims = [];
  const rests = [];
  const discards = [];
  const capacitySeries = [];   // [turnNumber, 商队水晶数]（自己每手行动后）
  const playedSizeSeries = []; // [turnNumber, 已打出引擎卡数]
  const stockSeries = [];      // [turnNumber, 黄,绿,蓝,粉]（自己每手行动后）
  let overflowCount = 0;

  for (const entry of own) {
    const t = entry.turn;
    const timeline = timelineByIndex.get(entry.index);
    for (const a of t.actions) actionsByType[a.type]++;
    for (const a of t.actions) {
      if (a.type === 'acquire') {
        const marketCard = timeline.merchantMarket[a.index];
        acquires.push({
          turn: t.turnNumber, round: t.round, cardId: t.cardId,
          payCount: a.payment.length, // 位置深度 = 支付颗数（引擎规则）
          paymentByColor: a.payment.reduce((acc, c) => (acc[c]++, acc), [0, 0, 0, 0]),
          bonusRetrieved: crystalTotal(marketCard?.bonus ?? [0, 0, 0, 0]), // 卡上累积奖励（公开可见）
        });
      } else if (a.type === 'claim') {
        const golem = data.GOLEM_BY_ID[t.cardId];
        claims.push({
          turn: t.turnNumber, round: t.round, golemId: t.cardId,
          points: golem.points, index: a.index, cost: golem.cost,
          coin: coinAward(timeline.coins, a.index), // 发币依公开钱币池按引擎规则推导
        });
      } else if (a.type === 'rest') {
        rests.push({ turn: t.turnNumber, round: t.round, playedSize: t.before.played.length });
      } else if (a.type === 'discard') {
        const lost = crystalTotal(a.colors);
        overflowCount++;
        discards.push({ turn: t.turnNumber, colors: a.colors, count: lost });
      }
    }
    capacitySeries.push([t.turnNumber, crystalTotal(t.after.stock)]);
    playedSizeSeries.push([t.turnNumber, t.after.played.length]);
    stockSeries.push([t.turnNumber, ...t.after.stock]);
  }

  const finalHand = lastAfter.hand ?? [];
  const deadCards = finalHand.filter(id => !data.MERCHANT_BY_ID[id]?.starter); // 结束时仍在手上的非起始卡（取了没用上）
  const golemPoints = sum(claims.map(c => c.points));
  const copper = lastAfter.copper ?? 0;
  const silver = lastAfter.silver ?? 0;
  const crystalPoints = sum((lastAfter.stock ?? [0, 0, 0, 0]).slice(1));

  // —— 算法计算 ——
  const ownTurnNumbers = own.map(e => e.turn.turnNumber);
  const restTurns = rests.map(r => r.turn);
  const restGaps = restTurns.map((t, i) => i === 0 ? (ownTurnNumbers.indexOf(t) + 1) : t - restTurns[i - 1]);
  const acquireTurns = acquires.map(a => a.turn);
  const acquireGaps = acquireTurns.slice(1).map((t, i) => t - acquireTurns[i]);
  const capacityUsed = capacitySeries.map(x => x[1]);
  const lateRoundStart = meta.triggerRound ?? Infinity;
  const lateAcquires = acquires.filter(a => meta.triggerPlayer != null && a.round > lateRoundStart).length;
  const claimCostTotal = claims.reduce((s, c) => s + sum(c.cost), 0);
  const claimTurnSet = new Set(claims.map(c => c.turn));
  const affordableButNotClaimed = own.filter(e => {
    if (claimTurnSet.has(e.turn.turnNumber)) return false;
    const timeline = timelineByIndex.get(e.index);
    return timeline.golemMarket.some(id => engine.has(e.turn.before.stock, data.GOLEM_BY_ID[id].cost));
  }).map(e => ({
    turn: e.turn.turnNumber,
    chosen: e.turn.actions[0].type,
    golems: timelineByIndex.get(e.index).golemMarket
      .filter(id => engine.has(e.turn.before.stock, data.GOLEM_BY_ID[id].cost))
      .map(id => ({ golemId: id, points: data.GOLEM_BY_ID[id].points })),
  }));
  // 决策时点「大商队无目标」：行动前商队 ≥8 颗且市场无任何付得起的魔像
  const bigIdleTurns = own
    .filter(e => crystalTotal(e.turn.before.stock) >= 8 &&
      !timelineByIndex.get(e.index).golemMarket.some(id => engine.has(e.turn.before.stock, data.GOLEM_BY_ID[id].cost)))
    .map(e => e.turn.turnNumber);

  return {
    seat,
    name: p0.name,
    kind: {
      observable: {
        turnsPlayed: own.length,
        actionsByType,
        acquires,
        claims,
        rests,
        discards,
        overflowCount,
        crystalsDiscarded: sum(discards.map(d => d.count)),
        capacitySeries,
        playedSizeSeries,
        stockSeries,
        finalStock: lastAfter.stock ?? null,
        finalHandSize: finalHand.length,
        deadCards,
        finalCopper: copper,
        finalSilver: silver,
        firstTurn: ownTurnNumbers[0] ?? null,
        lastTurn: ownTurnNumbers[ownTurnNumbers.length - 1] ?? null,
      },
      computed: {
        golemPoints,
        coinPoints: copper * 3 + silver,
        crystalPoints,
        totalScore: golemPoints + copper * 3 + silver + crystalPoints, // 与正式引擎 score() 同式
        firstClaimTurn: claims[0]?.turn ?? null,
        claimsPer10Turns: own.length ? round2(claims.length * 10 / own.length) : 0,
        pointsPerClaim: claims.length ? round2(golemPoints / claims.length) : null,
        claimCostCrystals: claimCostTotal,
        crystalsPerGolemPoint: golemPoints ? round2(claimCostTotal / golemPoints) : null,
        acquiresPer10Turns: own.length ? round2(acquires.length * 10 / own.length) : 0,
        medianAcquireGap: acquireGaps.length ? acquireGaps.slice().sort((a, b) => a - b)[Math.floor(acquireGaps.length / 2)] : null,
        avgPayDepth: acquires.length ? round2(avg(acquires.map(a => a.payCount))) : null,
        deepAcquireRatio: acquires.length ? round2(acquires.filter(a => a.payCount >= 3).length / acquires.length) : null,
        avgBonusRetrieved: acquires.length ? avg(acquires.map(a => a.bonusRetrieved)) : null,
        deadCardCount: deadCards.length,
        avgCapacityUtil: capacityUsed.length ? round2(avg(capacityUsed.map(c => c / 10))) : null,
        maxCapacity: capacityUsed.length ? Math.max(...capacityUsed) : null,
        restCount: rests.length,
        avgRestPlayedSize: rests.length ? avg(rests.map(r => r.playedSize)) : null,
        medianRestGap: restGaps.length ? restGaps.slice().sort((a, b) => a - b)[Math.floor(restGaps.length / 2)] : null,
        maxEngineSize: playedSizeSeries.length ? Math.max(...playedSizeSeries.map(x => x[1])) : 0,
        lateAcquires,
        affordableButNotClaimed,
        bigIdleTurns,
        contestedLosses: contestedLosses.filter(e => e.bySeat === seat),
        missedClaims: missedClaims.filter(e => e.bySeat === seat),
      },
      inferred: {
        note: '战略推测仅供参考，不作为失败判定证据。',
        archetypeHint: null, // 由 inferArchetype 填充
      },
    },
  };
}

/** 战略推测：按已认领魔像的成本色偏好描述倾向。 */
function inferArchetype(profile, data) {
  const costs = profile.kind.observable.claims.map(c => c.cost);
  if (!costs.length) return '未认领魔像，无倾向可判';
  const acc = [0, 0, 0, 0];
  for (const cost of costs) cost.forEach((n, i) => acc[i] += n);
  const names = ['黄', '绿', '蓝', '粉'];
  const top = acc.map((n, i) => [n, i]).sort((a, b) => b[0] - a[0])[0];
  return top[0] === 0 ? '无显著色彩偏好' : `偏重${names[top[1]]}系魔像（成本色累计 ${acc.join('/')}）`;
}

/** 主入口：对局级 + 逐席位指标。 */
export async function computeGameMetrics(imported) {
  const { engine, data } = await loadEngine();
  const record = imported.record;
  const r = record.replay;
  const turns = r.turns;
  const timelineByIndex = new Map(imported.timeline.map((snap, i) => [i, snap]));

  const turnsBySeat = new Map();
  for (let i = 0; i < turns.length; i++) {
    const seat = turns[i].playerId;
    (turnsBySeat.get(seat) ?? turnsBySeat.set(seat, []).get(seat)).push({ turn: turns[i], index: i });
  }

  // —— 对局级事件：被抢目标（computed）——
  // 某席位认领魔像 X 时，若其他席位在「截至上一手的公开商队」付得起 X，记为该席位被抢目标。
  // 单趟扫描维护每个席位的最新公开状态，保证是时点状态而非终态。
  const contestedLosses = [];
  const latestPublic = {}; // seat -> 该席位最近一次行动后的状态
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const claim = t.actions.find(a => a.type === 'claim');
    if (claim) {
      const timeline = timelineByIndex.get(i);
      const golemId = timeline.golemMarket[claim.index];
      const cost = data.GOLEM_BY_ID[golemId].cost;
      for (const seatStr of Object.keys(latestPublic)) {
        const seat = Number(seatStr);
        if (seat === t.playerId) continue;
        if (engine.has(latestPublic[seat].stock, cost)) {
          contestedLosses.push({
            turn: t.turnNumber, round: t.round, golemId, points: data.GOLEM_BY_ID[golemId].points,
            bySeat: seat, claimedBySeat: t.playerId,
          });
        }
      }
    }
    latestPublic[t.playerId] = t.after;
  }
  const lastAfterBySeat = { ...latestPublic }; // 终态（档案收尾用）

  // —— 对局级事件：错过认领（computed）——
  // 自己的手里有付得起的魔像却选择了其他行动；若该魔像随后被他人认领，标记 contested。
  const missedClaims = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.actions.some(a => a.type === 'claim')) continue;
    const timeline = timelineByIndex.get(i);
    const affordable = timeline.golemMarket.filter(id => engine.has(t.before.stock, data.GOLEM_BY_ID[id].cost));
    if (!affordable.length) continue;
    for (const golemId of affordable) {
      const idx = timeline.golemMarket.indexOf(golemId);
      let claimedLaterBy = null;
      for (let j = i + 1; j < turns.length && !claimedLaterBy; j++) {
        const later = turns[j];
        const laterClaim = later.actions.find(a => a.type === 'claim');
        if (laterClaim && timelineByIndex.get(j).golemMarket[laterClaim.index] === golemId) claimedLaterBy = later.playerId;
      }
      missedClaims.push({
        turn: t.turnNumber, bySeat: t.playerId, golemId, points: data.GOLEM_BY_ID[golemId].points,
        chosen: t.actions[0].type, claimedLaterBy,
      });
    }
  }

  const meta = imported.meta;
  const triggerTurn = turns.find(t => t.triggersEnd);
  const fullMeta = {
    ...meta,
    triggerTurn: triggerTurn?.turnNumber ?? null,
    triggerRound: triggerTurn?.round ?? null,
    roundsAfterTrigger: triggerTurn && meta.lastRound != null ? meta.lastRound - triggerTurn.round : null,
  };

  const ctx = { turnsBySeat, timelineByIndex, initialPlayers: r.initial.players, lastAfterBySeat, meta: fullMeta, data, engine, contestedLosses, missedClaims };
  const players = [];
  for (let seat = 0; seat < meta.seatCount; seat++) {
    const profile = playerProfile(seat, ctx);
    profile.kind.inferred.archetypeHint = inferArchetype(profile, data);
    players.push(profile);
  }

  // 终局排名：复用正式引擎 ranking（平分后手优先）
  const ranking = meta.finished && imported.game ? engine.ranking(imported.game).map(p => ({ seat: p.id, name: p.name, score: engine.score(p) })) : null;

  return {
    schema: 'century-human-analytics-metrics-v1',
    game: {
      file: imported.file,
      hash: imported.hash,
      provenance: imported.provenance,
      meta: fullMeta,
      anomalies: imported.anomalies,
    },
    contestedLosses,   // 对局级：谁的目标被谁抢走
    missedClaims,      // 对局级：付得起却没认领（含是否随后被他人拿走）
    overflowEvents: turns.flatMap((t, i) => t.actions.filter(a => a.type === 'discard')
      .map(a => ({ turn: t.turnNumber, seat: t.playerId, count: sum(a.colors) }))),
    players,
    ranking,
  };
}
