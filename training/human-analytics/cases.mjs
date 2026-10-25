/** 任务 D：战术案例提取（供第六阶段 JS5/JS6 反事实分析）。
 *
 * 关键纪律（隐藏信息）：
 *   - 每条案例只含「该决策时点的公开信息」+ 决策席位本人的手牌（ownHand，其本人可知）；
 *   - 其他席位手牌、牌库序（merchantDeck/golemDeck）一律不进入输出；
 *   - 对局结束后存档中的完整牌库绝不重新编码为决策输入特征；
 *   - assertNoHiddenInfo 提供独立泄漏检查（键级扫描），测试管线覆盖。
 *
 * 案例选择（确定性、按优先级截断）：
 *   trigger（终局触发手）> contested/missed-claim（被抢目标/错过认领）>
 *   overflow（超额弃置）> endgame（触发后每手）> claim（认领手）> final-action（各席最后一手）。
 */

import { loadEngine } from './engine-link.mjs';

const round2 = x => Math.round(x * 100) / 100;

/** 公开席位状态（无手牌）。 */
function publicSeat(state, seat, name, isAI) {
  return {
    seat, name, isAI: !!isAI,
    stock: [...state.stock],
    copper: state.copper, silver: state.silver,
    played: [...state.played], claimed: [...state.claimed],
    turns: state.turns,
  };
}

/** 提取关键战术案例。 */
export async function extractCases(imported, metrics, opts = {}) {
  const { engine, data } = await loadEngine();
  const maxCases = opts.maxCases ?? 60;
  const record = imported.record;
  const r = record.replay;
  const turns = r.turns;
  const timelineByIndex = new Map(imported.timeline.map((snap, i) => [i, snap]));
  const gameId = imported.hash.slice(0, 8);
  const initialPlayers = r.initial.players;
  const triggerTurn = metrics.game.meta.triggerTurn ?? null;

  // 事件分类（单趟）：kinds[turnNumber:seat] = Set
  const contestedTurns = new Set(metrics.contestedLosses.map(e => e.turn));
  // v2：错过案例只用"本人放弃 → 他人拿走"（本人稍后自领不是流失）。
  const missedTurns = new Set(metrics.missedClaims.filter(m => m.claimedLaterByOther).map(m => m.turn));
  const lastOwnTurnBySeat = {};
  for (const t of turns) lastOwnTurnBySeat[t.playerId] = t.turnNumber; // 后写覆盖 → 最后一手

  const KIND_PRIORITY = ['trigger', 'contested', 'missed-claim', 'overflow', 'endgame', 'claim', 'final-action'];
  const candidates = new Map(); // key -> {kinds:Set, index}
  const addCase = (index, kind) => {
    const t = turns[index];
    const key = `${t.turnNumber}:${t.playerId}`;
    if (!candidates.has(key)) candidates.set(key, { kinds: new Set(), index });
    candidates.get(key).kinds.add(kind);
  };

  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (t.triggersEnd) addCase(i, 'trigger');
    if (contestedTurns.has(t.turnNumber)) addCase(i, 'contested');
    if (missedTurns.has(t.turnNumber)) addCase(i, 'missed-claim');
    if (t.actions.some(a => a.type === 'discard')) addCase(i, 'overflow');
    if (triggerTurn != null && t.turnNumber > triggerTurn) addCase(i, 'endgame');
    if (t.actions.some(a => a.type === 'claim')) addCase(i, 'claim');
  }
  // 各席最后一手
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    if (lastOwnTurnBySeat[t.playerId] === t.turnNumber) addCase(i, 'final-action');
  }

  // 按优先级 + turnNumber 排序后截断
  const ordered = [...candidates.values()].sort((a, b) => {
    const pa = Math.min(...[...a.kinds].map(k => KIND_PRIORITY.indexOf(k)));
    const pb = Math.min(...[...b.kinds].map(k => KIND_PRIORITY.indexOf(k)));
    return pa - pb || turns[a.index].turnNumber - turns[b.index].turnNumber;
  }).slice(0, maxCases);

  // 单趟重建决策时点的各席位公开状态
  const latestPublic = new Map(); // seat -> after 状态
  const entryByKey = new Map(ordered.map(e => [`${turns[e.index].turnNumber}:${turns[e.index].playerId}`, e]));
  const cases = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const key = `${t.turnNumber}:${t.playerId}`;
    const entry = entryByKey.get(key);
    const timeline = timelineByIndex.get(i);
    const isOverflow = t.actions[0]?.type === 'discard';
    if (entry) {
      const actor = initialPlayers[t.playerId];
      const playersPublic = [];
      for (let seat = 0; seat < metrics.game.meta.seatCount; seat++) {
        const state = latestPublic.get(seat) ?? initialPlayers[seat];
        if (seat === t.playerId) {
          // 决策席位：行动前状态（t.before 即本人当时状态）
          playersPublic.push({ ...publicSeat(t.before, seat, actor.name, actor.isAI) });
        } else {
          playersPublic.push({ ...publicSeat(state, seat, initialPlayers[seat].name, initialPlayers[seat].isAI) });
        }
      }
      const main = t.actions[0];
      cases.push({
        id: `${gameId}-T${t.turnNumber}`,
        gameId,
        file: imported.file,
        turnNumber: t.turnNumber,
        round: t.round,
        seat: t.playerId,
        kinds: [...entry.kinds].sort((a, b) => KIND_PRIORITY.indexOf(a) - KIND_PRIORITY.indexOf(b)),
        publicPosition: {
          turnNumber: t.turnNumber,
          round: t.round,
          pendingDiscard: isOverflow ? engine.count(t.before.stock) - 10 : 0,
          coins: timeline.coins,
          merchantMarket: timeline.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] })),
          golemMarket: [...timeline.golemMarket],
          players: playersPublic,
        },
        ownHand: [...t.before.hand], // 仅决策席位本人可知
        action: main,
        extraAction: t.actions.length > 1 ? t.actions[1] : null,
        cardId: t.cardId ?? null,
        outcome: {
          scoreBefore: engine.score(t.before),
          scoreAfter: engine.score(t.after),
          scoreDelta: round2(engine.score(t.after) - engine.score(t.before)),
          completed: t.completed,
          triggersEnd: t.triggersEnd,
        },
      });
    }
    latestPublic.set(t.playerId, t.after);
  }

  // 用有序候选顺序输出（候选按优先级排序，但 cases 需与候选一致）
  cases.sort((a, b) => {
    const ka = Math.min(...[...candidates.get(`${a.turnNumber}:${a.seat}`).kinds].map(k => KIND_PRIORITY.indexOf(k)));
    const kb = Math.min(...[...candidates.get(`${b.turnNumber}:${b.seat}`).kinds].map(k => KIND_PRIORITY.indexOf(k)));
    return ka - kb || a.turnNumber - b.turnNumber || a.seat - b.seat;
  });
  const trimmed = cases.slice(0, maxCases);

  return {
    schema: 'century-human-analytics-cases-v1',
    game: { file: imported.file, id: gameId, hash: imported.hash, provenance: imported.provenance },
    hiddenInfoPolicy: [
      '案例仅含决策时点公开信息（市场、钱币池、各席位公开区）+ 决策席位本人手牌。',
      '其他席位手牌、merchantDeck/golemDeck 牌库序一律不进入案例。',
      '对局存档终态中的完整牌库不得作为决策输入特征（引擎重放仅为内部重建公开市场）。',
    ],
    selected: trimmed.length,
    totalEligible: candidates.size,
    cases: trimmed,
  };
}

/** 泄漏检查：键级扫描案例输出。返回违规列表（空数组 = 通过）。
 * 规则：
 *   1) 任何层级不得出现键 merchantDeck / golemDeck / deck / futureDeck / hands；
 *   2) 任何层级不得出现键 hand —— 本实现中决策者本人手牌已改名 ownHand，
 *      其余任何 hand 键都是泄漏信号；
 */
export function assertNoHiddenInfo(casesBundle) {
  const violations = [];
  const FORBIDDEN_KEYS = new Set(['merchantDeck', 'golemDeck', 'deck', 'futureDeck', 'hands', 'hand']);
  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (FORBIDDEN_KEYS.has(k)) violations.push(`${path}.${k}（禁用键）`);
        walk(v, `${path}.${k}`);
      }
    }
  };
  casesBundle.cases.forEach((c, i) => walk(c, `cases[${i}]`));
  return violations;
}
