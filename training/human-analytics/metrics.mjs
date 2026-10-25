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

/** v2 口径迁移说明（旧 analytics 产物保留为 v1 研究结果，不重写历史）：
 * - deadCards：v1 = 终局手牌中的非起始卡（把"曾打出后休息收回"误判为未使用）；
 *   v2 = 取后从未打出（按 acquire/play 时间线）。
 * - discards/crystalsDiscarded：v1 = 颜色编号求和（黄色编号 0 计 0 颗）；
 *   v2 = colors.length（每颗水晶恰好一项）。
 * - missedClaims：v2 区分 claimedLaterBySelf/claimedLaterByOther，并给出
 *   同一 (席位,目标) 的首次流失标记（跨回合重复不再作为独立流失）。
 * - contestedLosses：v2 明确为"他人认领时我也付得起"的机会集合（不是 199
 *   次实际被抢），附唯一 claimEventId 以便下游按事件去重。
 * - maxEngineSize：v2 = max(hand.length + played.length)；v1 = played 区最大值。
 * - rest 间隔：v2 用个人回合差（before.turns+1）；v1 首次用个人回合、后续用全局手数。
 * - lateAcquires：v2 用"触发手之后"（turn 索引）；v1 用 round > 触发轮（规则下恒 0 亦可）。
 */
export const METRIC_SCHEMA_VERSION = 'century-human-analytics-metrics-v2';

/** 弃置颗数 = 颜色数组长度（每颗水晶一个元素，绝不是颜色编号之和）。 */
export function discardedCrystalCount(colors) {
  return Array.isArray(colors) ? colors.length : 0;
}

/** 从未打出的购卡：按 (席位) 的 acquire/play 时间线计算。
 * 输入 events: [{ type:'acquire', cardId }, { type:'play', cardId }]（按时间升序）。
 * 输出 { deadCards, acquiredNeverPlayed:[{cardId, acquireTurn?}], playedCardIds }。
 * 起始卡不计入（starters 由调用方判定）；同 id 多次获取以任一被打出为准。 */
export function unusedAcquisitions(events, starterIds = new Set()) {
  const acquired = [];
  const played = new Set();
  for (const event of events) {
    if (event.type === 'acquire' && event.cardId && !starterIds.has(event.cardId)) {
      acquired.push({ cardId: event.cardId, turn: event.turn ?? null });
    } else if (event.type === 'play' && event.cardId) {
      played.add(event.cardId);
    }
  }
  const dead = acquired.filter(a => !played.has(a.cardId));
  return {
    deadCards: [...new Set(dead.map(a => a.cardId))],
    acquiredNeverPlayed: dead,
    playedCardIds: [...played],
  };
}

/** 错过认领的语义修正：区分本人稍后认领/他人认领，并把同一 (席位,目标)
 * 的跨回合重复标注为 repeat（不再当作独立目标流失）。 */
export function annotateMissedClaims(missedClaims) {
  const firstByTarget = new Map();
  return missedClaims.map((m, index) => {
    const key = `${m.bySeat}|${m.golemId}`;
    const first = firstByTarget.get(key);
    if (first === undefined) firstByTarget.set(key, index);
    return {
      ...m,
      claimedLaterBySelf: m.claimedLaterBy != null && m.claimedLaterBy === m.bySeat,
      claimedLaterByOther: m.claimedLaterBy != null && m.claimedLaterBy !== m.bySeat,
      firstLossOfTarget: first === undefined,
      repeatOfEarlierMiss: first !== undefined,
      lossEventId: `${m.bySeat}|${m.golemId}|${first ?? index}`,
    };
  });
}

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
  const playRoundSet = new Set(); // 有打出行动的轮次（引擎建设持续轮数）
  const seatEvents = []; // acquire/play 时间线（dead card 口径）
  const playerTurnOf = entry => entry.turn.before.turns + 1; // 个人回合（1-based）

  for (const entry of own) {
    const t = entry.turn;
    const timeline = timelineByIndex.get(entry.index);
    for (const a of t.actions) actionsByType[a.type]++;
    if (t.actions.some(a => a.type === 'play')) playRoundSet.add(t.round);
    for (const a of t.actions) {
      if (a.type === 'play' || a.type === 'acquire') {
        seatEvents.push({ type: a.type, cardId: t.cardId, turn: t.turnNumber, index: entry.index });
      }
      if (a.type === 'acquire') {
        const marketCard = timeline.merchantMarket[a.index];
        acquires.push({
          turn: t.turnNumber, round: t.round, playerTurn: playerTurnOf(entry), index: entry.index,
          cardId: t.cardId,
          payCount: a.payment.length, // 位置深度 = 支付颗数（引擎规则）
          paymentByColor: a.payment.reduce((acc, c) => (acc[c]++, acc), [0, 0, 0, 0]),
          bonusRetrieved: crystalTotal(marketCard?.bonus ?? [0, 0, 0, 0]), // 卡上累积奖励（公开可见）
        });
      } else if (a.type === 'claim') {
        const golem = data.GOLEM_BY_ID[t.cardId];
        claims.push({
          turn: t.turnNumber, round: t.round, playerTurn: playerTurnOf(entry), golemId: t.cardId,
          points: golem.points, index: a.index, cost: golem.cost,
          coin: coinAward(timeline.coins, a.index), // 发币依公开钱币池按引擎规则推导
        });
      } else if (a.type === 'rest') {
        rests.push({ turn: t.turnNumber, round: t.round, playerTurn: playerTurnOf(entry), playedSize: t.before.played.length });
      } else if (a.type === 'discard') {
        const lost = discardedCrystalCount(a.colors); // v2：颜色编号不能求和当颗数
        overflowCount++;
        discards.push({ turn: t.turnNumber, colors: a.colors, count: lost });
      }
    }
    capacitySeries.push([t.turnNumber, crystalTotal(t.after.stock)]);
    playedSizeSeries.push([t.turnNumber, t.after.hand.length + t.after.played.length]); // v2：拥有卡总数
    stockSeries.push([t.turnNumber, ...t.after.stock]);
  }

  const finalHand = lastAfter.hand ?? [];
  const starterIds = ctx.starterIds;
  // v2 dead card：取后从未打出（曾打出后休息收回的卡不算）
  const unused = unusedAcquisitions(seatEvents, starterIds);
  const deadCards = unused.deadCards;
  const usedThenRecovered = finalHand.filter(id => !data.MERCHANT_BY_ID[id]?.starter && !deadCards.includes(id));
  const golemPoints = sum(claims.map(c => c.points));
  const copper = lastAfter.copper ?? 0;
  const silver = lastAfter.silver ?? 0;
  const crystalPoints = sum((lastAfter.stock ?? [0, 0, 0, 0]).slice(1));

  // —— 算法计算 ——
  const ownTurnNumbers = own.map(e => e.turn.turnNumber);
  const restTurns = rests.map(r => r.playerTurn);
  const restGaps = restTurns.map((t, i) => i === 0 ? t : t - restTurns[i - 1]); // v2：个人回合差
  const acquireTurns = acquires.map(a => a.playerTurn);
  const acquireGaps = acquireTurns.slice(1).map((t, i) => t - acquireTurns[i]);
  const capacityUsed = capacitySeries.map(x => x[1]);
  // v2：触发手之后（规则保证不会再有下一轮，不能用 round 比较）
  const lateAcquires = ctx.meta.triggerIndex == null ? 0 : acquires.filter(a => a.index > ctx.meta.triggerIndex).length;
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
        deadCardDetails: unused.acquiredNeverPlayed,
        usedThenRecovered, // 终局手牌中曾打出、休息后收回的非起始卡（v1 曾误计为死卡）
        finalCopper: copper,
        finalSilver: silver,
        firstTurn: ownTurnNumbers[0] ?? null,
        lastTurn: ownTurnNumbers[ownTurnNumbers.length - 1] ?? null,
        lastActions: own.length ? { // 最后行动（终局触发与收尾评估用，可观察事实）
          turn: own[own.length - 1].turn.turnNumber,
          round: own[own.length - 1].turn.round,
          actions: own[own.length - 1].turn.actions.map(a =>
            `${a.type}${a.cardId ? ` ${a.cardId}` : ''}${a.type === 'discard' ? `×${discardedCrystalCount(a.colors)}` : ''}`),
        } : null,
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
        engineActiveRounds: playRoundSet.size, // 引擎建设持续轮数（有打出行动的轮次）
        firstPlayRound: playRoundSet.size ? Math.min(...playRoundSet) : null,
        lastPlayRound: playRoundSet.size ? Math.max(...playRoundSet) : null,
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
            // v2：这是"他人认领时我也付得起"的机会集合；不等于我实际锁定了该目标。
            opportunityOnly: true,
            claimEventId: `${t.turnNumber}:${t.playerId}:${golemId}`,
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
  const annotatedMissedClaims = annotateMissedClaims(missedClaims);

  const meta = imported.meta;
  const triggerIndex = turns.findIndex(t => t.triggersEnd);
  const triggerTurn = triggerIndex >= 0 ? turns[triggerIndex] : undefined;
  // 触发时点公开分数（每个席位取触发手及之前最后一次行动后的状态；不拿终态回填）。
  const triggerScores = triggerIndex >= 0 ? (() => {
    const latest = Array.from({ length: meta.seatCount }, () => null);
    for (let i = 0; i <= triggerIndex; i++) latest[turns[i].playerId] = turns[i].after;
    return latest.map((p, seat) => p ? { seat, score: engine.score(p), copper: p.copper ?? 0, silver: p.silver ?? 0 } : { seat, score: null, copper: null, silver: null });
  })() : null;
  const triggerRanking = triggerScores
    ? [...triggerScores].filter(x => x.score != null).sort((a, b) => b.score - a.score || b.seat - a.seat)
    : null;
  const triggerRankBySeat = triggerRanking
    ? Object.fromEntries(triggerRanking.map((x, i) => [x.seat, i + 1]))
    : null;
  const fullMeta = {
    ...meta,
    triggerTurn: triggerTurn?.turnNumber ?? null,
    triggerRound: triggerTurn?.round ?? null,
    triggerIndex: triggerIndex >= 0 ? triggerIndex : null,
    roundsAfterTrigger: triggerTurn && meta.lastRound != null ? meta.lastRound - triggerTurn.round : null,
    triggerScores,
    triggerRanking,
    triggerRankBySeat,
  };

  const starterIds = new Set(Object.keys(data.MERCHANT_BY_ID).filter(id => data.MERCHANT_BY_ID[id]?.starter));
  const ctx = { turnsBySeat, timelineByIndex, initialPlayers: r.initial.players, lastAfterBySeat, meta: fullMeta, data, engine, contestedLosses, missedClaims: annotatedMissedClaims, starterIds };
  const players = [];
  for (let seat = 0; seat < meta.seatCount; seat++) {
    const profile = playerProfile(seat, ctx);
    profile.kind.inferred.archetypeHint = inferArchetype(profile, data);
    players.push(profile);
  }

  // 终局排名：复用正式引擎 ranking（平分后手优先）
  const ranking = meta.finished && imported.game ? engine.ranking(imported.game).map(p => ({ seat: p.id, name: p.name, score: engine.score(p) })) : null;

  return {
    schema: METRIC_SCHEMA_VERSION,
    metricSemantics: {
      version: 2,
      previous: 'century-human-analytics-metrics-v1（旧产物保留；以下字段口径已修正，不重写历史）',
      deadCards: 'acquired-never-played（按 acquire/play 时间线；曾打出后休息收回不算死卡）',
      discardedCrystals: 'colors.length（每颗水晶一项；不是颜色编号之和）',
      missedClaims: 'claimedLaterBySelf/Other 分开；firstLossOfTarget 标记同一 (席位,目标) 的首次流失',
      contestedLosses: 'opportunity-only：他人认领时我也付得起，不证明我锁定了该目标',
      engineSize: 'hand.length + played.length（拥有卡总数）',
      restGap: '个人回合差（before.turns+1）',
      lateAcquires: '触发手之后的获取（turn 索引）；规则下通常为 0',
      triggerTime: '触发时点公开分数/排名（不拿终态回填）',
    },
    game: {
      file: imported.file,
      hash: imported.hash,
      provenance: imported.provenance,
      meta: fullMeta,
      anomalies: imported.anomalies,
    },
    contestedLosses,   // 对局级：他人认领时我也付得起（机会集合，非实际被抢次数）
    missedClaims: annotatedMissedClaims, // 对局级：付得起却没认领（区分自领/他领/重复）
    overflowEvents: turns.flatMap(t => t.actions.filter(a => a.type === 'discard')
      .map(a => ({ turn: t.turnNumber, seat: t.playerId, count: discardedCrystalCount(a.colors), colors: [...a.colors] }))),
    players,
    ranking,
  };
}
