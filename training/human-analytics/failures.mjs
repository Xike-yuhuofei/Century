/** 任务 C：失败诊断（8 类候选失败，全部由可检测证据支持）。
 *
 * 纪律：
 *   1) 只用任务 B 产出的可观察事实与算法计算作证据，绝不仅凭输赢判定；
 *   2) 每类失败有明确阈值；信号达到阈值 → finding（附证据清单）；
 *      有信号但未达阈值 → inconclusive（「无法判断」，附原因）；
 *      零信号 → 不输出该类；
 *   3) 未完成对局：终局相关类型一律「无法判断」（原因 game-unfinished）。
 *
 * 类型清单（与任务书一一对应）：
 *   goal-competition   目标竞争判断不足
 *   engine-overbuild   引擎建设过度
 *   merchant-efficiency 商人卡获取效率低
 *   resource-mismatch  资源结构与魔像目标不匹配
 *   capacity-waste     商队容量浪费
 *   rest-cost-high     休息成本过高
 *   missed-claims      错过关键认领
 *   endgame-pacing     终局节奏判断错误
 */

export const FAILURE_TYPES = [
  ['goal-competition', '目标竞争判断不足'],
  ['engine-overbuild', '引擎建设过度'],
  ['merchant-efficiency', '商人卡获取效率低'],
  ['resource-mismatch', '资源结构与魔像目标不匹配'],
  ['capacity-waste', '商队容量浪费'],
  ['rest-cost-high', '休息成本过高'],
  ['missed-claims', '错过关键认领'],
  ['endgame-pacing', '终局节奏判断错误'],
];
const LABEL = Object.fromEntries(FAILURE_TYPES);

const severity = n => n >= 3 ? 'high' : n >= 2 ? 'medium' : 'low';

function finding(type, evid, thresholds) {
  return { type, label: LABEL[type], level: 'finding', severity: severity(evid.length), evidence: evid, thresholds };
}
function inconclusive(type, reason) {
  return { type, label: LABEL[type], level: 'inconclusive', reason };
}

function diagnoseSeat(profile, metrics, finished, triggerTurn) {
  const o = profile.kind.observable;
  const c = profile.kind.computed;
  const findings = [];
  const inconclusives = [];

  // 1. 目标竞争判断不足：被抢目标 ≥2，或「错过且被他人拿走」≥2（合计）
  {
    const contested = c.contestedLosses;
    const stolenMissed = c.missedClaims.filter(m => m.claimedLaterBy != null);
    const total = contested.length + stolenMissed.length;
    if (total >= 2) {
      findings.push(finding('goal-competition', [
        ...contested.map(e => `第 ${e.turn} 手：可付的 ${e.golemId}（${e.points} 分）被座位 ${e.claimedBySeat + 1} 认领`),
        ...stolenMissed.map(m => `第 ${m.turn} 手：付得起 ${m.golemId}（${m.points} 分）却选择 ${m.chosen}，随后被座位 ${(m.claimedLaterBy ?? 0) + 1} 认领`),
      ], { minEvents: 2 }));
    } else if (total === 1) {
      inconclusives.push(inconclusive('goal-competition', `仅 1 次被抢/错失事件（阈值 2），不足以判断是竞争意识问题还是运气`));
    }
  }

  // 2. 引擎建设过度（需终局）
  {
    if (!finished) {
      inconclusives.push(inconclusive('engine-overbuild', 'game-unfinished：对局未结束，无法评估引擎是否过度（可能尚未变现）'));
    } else {
      const signals = [];
      if (c.deadCardCount >= 3) signals.push(`结束时仍有 ${c.deadCardCount} 张非起始卡从未打出（${o.deadCards.join('、')}）`);
      if (c.maxEngineSize >= 8 && o.claims.length <= 2) signals.push(`最大引擎规模 ${c.maxEngineSize} 张，但仅认领 ${o.claims.length} 张魔像`);
      if (c.lateAcquires >= 3) signals.push(`终局触发后仍获取 ${c.lateAcquires} 张商人卡`);
      if (signals.length >= 2) findings.push(finding('engine-overbuild', signals, { minSignals: 2, deadCardsMin: 3, engineMin: 8 }));
      else if (signals.length === 1) inconclusives.push(inconclusive('engine-overbuild', `仅 1 项信号（${signals[0]}），未达 2 项阈值`));
    }
  }

  // 3. 商人卡获取效率低
  {
    const signals = [];
    if (o.actionsByType.acquire >= 4 && c.deepAcquireRatio != null && c.deepAcquireRatio >= 0.4 && (c.avgPayDepth ?? 0) >= 2.5) {
      signals.push(`取卡平均支付深度 ${c.avgPayDepth}（≥2.5），深位（≥3）取卡占比 ${c.deepAcquireRatio}`);
    }
    if (o.actionsByType.acquire >= 4 && o.deadCards.length / Math.max(1, o.actionsByType.acquire) >= 0.5) {
      signals.push(`${o.actionsByType.acquire} 次取卡中 ${o.deadCards.length} 张到局终从未打出（≥50%）`);
    }
    if (signals.length >= 1) findings.push(finding('merchant-efficiency', signals, { deepAcquireMin: 0.4, avgPayDepthMin: 2.5, deadRatioMin: 0.5 }));
    else if (o.actionsByType.acquire >= 4 && ((c.deepAcquireRatio ?? 0) >= 0.2 || c.deadCardCount >= 1)) {
      inconclusives.push(inconclusive('merchant-efficiency', '有效率信号偏弱（未达阈值），无法判断'));
    }
  }

  // 4. 资源结构与魔像目标不匹配：决策时点商队 ≥8 颗且市场无任何可认领魔像
  {
    const idleBigTurns = c.bigIdleTurns ?? [];
    if (idleBigTurns.length >= 4) {
      findings.push(finding('resource-mismatch', [
        `${idleBigTurns.length} 个手数在决策时商队 ≥8 颗且市场无可认领魔像（第 ${idleBigTurns.slice(0, 8).join('、')}${idleBigTurns.length > 8 ? '…' : ''} 手）`,
        `平均容量利用率 ${c.avgCapacityUtil}`,
      ], { minTurns: 4, bigCaravan: 8 }));
    } else if (idleBigTurns.length >= 1) {
      inconclusives.push(inconclusive('resource-mismatch', `仅 ${idleBigTurns.length} 手出现「大商队无目标」（阈值 4），无法判断`));
    }
  }

  // 5. 商队容量浪费
  {
    const signals = [];
    if (o.crystalsDiscarded >= 3) signals.push(`超额弃置 ${o.overflowCount} 次、共丢 ${o.crystalsDiscarded} 颗水晶（${o.discards.map(d => `第 ${d.turn} 手丢 ${d.count}`).join('；')}）`);
    if (finished && (o.finalStock?.[0] ?? 0) >= 4) signals.push(`终局仍持有 ${o.finalStock[0]} 颗黄水晶（不计分、占容量）`);
    if (signals.length >= 1) findings.push(finding('capacity-waste', signals, { discardedMin: 3, finalYellowMin: 4 }));
    else if (o.crystalsDiscarded >= 1 || (finished && (o.finalStock?.[0] ?? 0) >= 1)) {
      inconclusives.push(inconclusive('capacity-waste', '有少量容量损耗但未达阈值，无法判断'));
    }
  }

  // 6. 休息成本过高
  {
    const cheapRests = o.rests.filter(r => r.playedSize <= 1);
    const signals = [];
    if (cheapRests.length >= 3) signals.push(`${cheapRests.length} 次休息时已打出卡 ≤1 张（收回价值低，第 ${cheapRests.map(r => r.turn).join('、')} 手）`);
    if (o.rests.length >= 4 && c.maxEngineSize <= 3) signals.push(`休息 ${o.rests.length} 次但最大引擎规模仅 ${c.maxEngineSize} 张（休息循环未建立足够引擎）`);
    if (signals.length >= 1) findings.push(finding('rest-cost-high', signals, { cheapRestMin: 3, restCountMin: 4, engineMax: 3 }));
    else if (cheapRests.length >= 1) inconclusives.push(inconclusive('rest-cost-high', `仅 ${cheapRests.length} 次低价值休息（阈值 3），无法判断`));
  }

  // 7. 错过关键认领
  {
    const stolen = c.missedClaims.filter(m => m.claimedLaterBy != null);
    const keyMissed = stolen.filter(m => m.points >= 14);
    const postTrigger = triggerTurn != null ? c.affordableButNotClaimed.filter(a => a.turn > triggerTurn) : [];
    const evid = [
      ...stolen.map(m => `第 ${m.turn} 手：付得起 ${m.golemId}（${m.points} 分）却选择 ${m.chosen}，被座位 ${(m.claimedLaterBy ?? 0) + 1} 认领`),
      ...postTrigger.map(a => `终局触发后第 ${a.turn} 手：仍付得起 ${a.golems.map(g => `${g.golemId}（${g.points} 分）`).join('、')} 却选择 ${a.chosen}`),
    ];
    if (stolen.length >= 2 || keyMissed.length >= 1 || postTrigger.length >= 2) {
      findings.push(finding('missed-claims', evid, { stolenMin: 2, keyGolemPoints: 14, postTriggerMin: 2 }));
    } else if (stolen.length === 1 || postTrigger.length === 1) {
      inconclusives.push(inconclusive('missed-claims', `仅 1 次错过且非关键魔像（<14 分），无法判断`));
    }
  }

  // 8. 终局节奏判断错误（需终局）
  {
    if (!finished) {
      inconclusives.push(inconclusive('endgame-pacing', 'game-unfinished：对局未结束，无终局节奏可评'));
    } else {
      const evid = [];
      const isTriggerer = metrics.game.meta.triggerPlayer === profile.seat;
      if (isTriggerer && metrics.ranking && metrics.ranking[metrics.ranking.length - 1]?.seat === profile.seat) {
        evid.push(`由本席触发终局，但触发时点全场估分最低（最终 ${metrics.ranking.at(-1).score} 分）`);
      }
      const postTriggerMissed = triggerTurn != null ? c.affordableButNotClaimed.filter(a => a.turn > triggerTurn) : [];
      if (postTriggerMissed.length >= 2) {
        evid.push(`终局触发后 ${postTriggerMissed.length} 个手数付得起魔像却未认领（第 ${postTriggerMissed.map(a => a.turn).join('、')} 手）`);
      }
      if (evid.length >= 1) findings.push(finding('endgame-pacing', evid, { postTriggerMin: 2 }));
    }
  }

  return { seat: profile.seat, name: profile.name, findings, inconclusives };
}

// 「商队≥8 且无可用认领」的精确判定已在任务 B 以决策时点状态计算（bigIdleTurns）。

/** 主入口：metrics（任务 B）→ 诊断。 */
export function computeFailureDiagnosis(metrics) {
  const finished = metrics.game.meta.finished;
  const triggerTurn = metrics.game.meta.triggerTurn ?? null;
  const players = metrics.players.map(p => diagnoseSeat(p, metrics, finished, triggerTurn));
  const summary = Object.fromEntries(FAILURE_TYPES.map(([code, label]) => {
    const n = players.filter(pl => pl.findings.some(f => f.type === code)).length;
    return [code, { label, seatCount: n }];
  }));
  return {
    schema: 'century-human-analytics-failures-v1',
    game: { file: metrics.game.file, hash: metrics.game.hash, finished, provenance: metrics.game.provenance },
    discipline: [
      '所有标签均由可检测证据支持；证据不足输出「无法判断」。',
      '不以输赢判定单步对错；本诊断只描述模式，不裁决具体一手。',
    ],
    summary,
    players,
  };
}
