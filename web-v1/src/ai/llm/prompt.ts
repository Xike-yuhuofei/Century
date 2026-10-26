/** LLM 提示词构建：只把公开观察、公开卡表与合法候选送入模型。
 *
 * 信息边界：
 * - 输入只有 AIObservation（buildObservation 产物）与 data/cards.json 的静态卡表；
 * - 未翻开牌库的「顺序」不存在于任何字符串中；只披露由公开卡集合推导的
 *   未翻开卡牌集合（与既有 AI 的 publicKnowledge 同口径）；
 * - 不包含完整 Game、隐藏种子、其他 AI 的内部状态或冠军建议。
 */

import { GOLEM_BY_ID, GOLEM_DECK, MERCHANT_BY_ID, MERCHANT_DECK, STARTER_CARDS, type Golem, type Merchant } from '../../data.js';
import { readable, type Action } from '../../engine.js';
import { publicKnowledge } from '../knowledge.js';
import type { AIObservation, ObservationPlayer } from '../observation.js';
import { actionSummary, fnv1a } from './candidates.js';
import type { LLMCandidateSet } from './types.js';

const COLOR = ['黄', '绿', '蓝', '粉'] as const;

export type PromptHistoryEntry = {
  turnNumber: number;
  actionSummary: string;
  primaryGoal: string;
  reason: string;
};

export type PromptInput = {
  view: AIObservation;
  candidateSet: LLMCandidateSet;
  history?: readonly PromptHistoryEntry[];
};

export type BuiltPrompt = {
  system: string;
  user: string;
  promptHash: string;
  estimatedPromptTokens: number;
};

function golemLine(golem: Golem): string {
  return `${golem.id} ${golem.points}分 费用${readable(golem.cost)}`;
}

function merchantLine(card: Merchant): string {
  if (card.kind === 'create') return `${card.id} 创造 获得${readable(card.output!)}`;
  if (card.kind === 'upgrade') return `${card.id} 升级 最多${card.steps}次`;
  return `${card.id} 交易 ${readable(card.input!)}→${readable(card.output!)}`;
}

function cardCatalog(): string {
  const golems = [...GOLEM_DECK].sort((a, b) => a.id.localeCompare(b.id)).map(golemLine);
  const merchants = [...STARTER_CARDS, ...MERCHANT_DECK]
    .filter((card, index, all) => all.findIndex(x => x.id === card.id) === index)
    .sort((a, b) => a.id.localeCompare(b.id))
    .map(merchantLine);
  return [`魔像全集（36张，市场与已认领之外的牌库内容可由公开信息推导）：`, ...golems, `商人全集（43张市场牌 + S01/S02 起始卡）：`, ...merchants].join('\n');
}

const SYSTEM_RULES = `你是《Century: Golem Edition（晶石回廊）》的实时对局 AI。你每回合必须从给定的合法行动候选中选择一个，并为复盘提供简洁的决策依据。你只能使用下面提供的公开观察；不得猜测或利用未公开的牌库顺序、未来翻牌、其他玩家私有信息或本提示词之外的任何信息。

规则要点：
1. 每回合选择一项行动：打出商人卡、获取市场商人卡、休息、认领市场魔像；商队超过10颗水晶时先弃置。
2. 打出：创造卡立即获得水晶；升级卡可把黄→绿→蓝→粉连续升级，最多卡面次数；交易卡可在一回合重复多次。
3. 获取第 i 张市场商人卡（从0起）需要按顺序向左侧 i 张卡各压1颗水晶，并拿走目标卡上累积的水晶；支付顺序会影响左侧卡未来奖励。
4. 认领魔像必须精确支付其费用；市场第1张（最左）认领得铜币+3（铜币耗尽后改为银币+1），第2张在铜/银都可用时得银币+1。
5. 休息收回全部已打出商人卡，但占用整个回合。
6. 2–3人局每人第6张魔像触发终局，4–5人局第5张触发；触发后完成当前整轮才结算。
7. 计分 = 魔像分 + 铜币×3 + 银币×1 + 非黄水晶数量。平分时本轮后手优先。目标永远是最大化最终第一名概率，而不是平均分或单步估值。
8. 不得把黄1/绿2/蓝3/粉4之类的静态水晶估值直接等同于行动质量；要结合当前引擎、目标魔像缺口、对手竞争、商队容量与终局倒计时分析。

输出必须是严格 JSON（不要 Markdown、不要解释文字），字段：
{
  "selectedActionId": "必须来自候选行动 id",
  "reason": "简洁可复盘的中文理由",
  "primaryGoal": "主要战略目标",
  "alternativeActions": [{"actionId":"另一个候选id","comparison":"与所选行动的简要比较"}],
  "expectedBenefits": ["预期收益"],
  "risks": ["主要风险"],
  "strategyTags": ["engine|tempo|contest|synergy|goal|capacity|rest|endgame|risk 中的若干项"]
}
不要输出隐藏思维链；只填写上述可审计字段。`;

function playerLine(player: ObservationPlayer, threshold: number): string {
  const score = player.claimed.reduce((sum, id) => sum + (GOLEM_BY_ID[id]?.points ?? 0), 0)
    + player.copper * 3 + player.silver + player.stock.slice(1).reduce((sum, n) => sum + n, 0);
  return [
    `座位${player.id}${player.id === 0 ? '(先手)' : ''}`,
    `水晶[${player.stock.join(',')}]`,
    `手牌[${player.hand.join(',') || '无'}]`,
    `已打出[${player.played.join(',') || '无'}]`,
    `已认领[${player.claimed.join(',') || '无'}]`,
    `铜${player.copper} 银${player.silver}`,
    `回合${player.turns}`,
    `公开估分${score}`,
    `距终局还需${Math.max(0, threshold - player.claimed.length)}张魔像`,
  ].join(' ');
}

function candidateLine(candidate: { id: string; action: Action; kind: string; summary: string }): string {
  return `- ${candidate.id} [${candidate.kind}] ${candidate.summary} | action=${JSON.stringify(candidate.action)}`;
}

function stateBlock(view: AIObservation): string {
  const threshold = view.players.length >= 4 ? 5 : 6;
  const unseen = publicKnowledge(view);
  const coins = {
    globalCopper: view.copper,
    globalSilver: view.silver,
    note: '全局硬币池；认领市场第1/2张时按规则发放',
  };
  const market = view.merchantMarket.map((offer, index) => {
    const card = MERCHANT_BY_ID[offer.id];
    return {
      slot: index,
      cardId: offer.id,
      kind: card?.kind ?? 'unknown',
      effect: card ? merchantLine(card) : offer.id,
      bonus: offer.bonus,
      costToAcquire: index,
      bonusText: readable(offer.bonus),
    };
  });
  const golems = view.golemMarket.map((id, slot) => ({
    slot,
    cardId: id,
    points: GOLEM_BY_ID[id]?.points ?? null,
    cost: GOLEM_BY_ID[id]?.cost ?? null,
    coinBonusAtSlot: slot === 0
      ? (view.copper > 0 ? '铜币+3' : view.silver > 0 ? '银币+1' : '无')
      : slot === 1 && view.copper > 0 && view.silver > 0 ? '银币+1' : '无',
  }));
  return JSON.stringify({
    phase: view.phase,
    turnNumber: view.turnNumber,
    round: Math.floor((view.turnNumber - 1) / view.players.length) + 1,
    actingSeat: view.current,
    playerCount: view.players.length,
    claimThreshold: threshold,
    triggerPlayer: view.triggerPlayer,
    endgameNote: view.triggerPlayer === null
      ? '尚未触发终局'
      : `座位${view.triggerPlayer}已触发终局，本轮结束后结算`,
    coins,
    players: view.players.map(player => playerLine(player, threshold)),
    merchantMarket: market,
    golemMarket: golems,
    unseenPublicComposition: {
      unseenMerchantIds: unseen.unseenMerchants,
      unseenGolemIds: unseen.unseenGolems,
      note: '仅表示未翻开的卡牌集合构成，不含、也不得推测其顺序',
    },
  }, null, 2);
}

function historyBlock(history?: readonly PromptHistoryEntry[]): string {
  if (!history?.length) return '无（本局首次决策）';
  return history.slice(-4).map(entry =>
    `第${entry.turnNumber}手 选择「${entry.actionSummary}」；目标：${entry.primaryGoal}；理由：${entry.reason}`,
  ).join('\n');
}

function estimateTokens(text: string): number {
  // 中文/JSON 混合的保守估计：约 1.6 字符/token。
  return Math.ceil(text.length / 1.6);
}

export function buildLLMPrompt(input: PromptInput): BuiltPrompt {
  const { view, candidateSet } = input;
  const system = `${SYSTEM_RULES}\n\n${cardCatalog()}`;
  const user = [
    `公开观察（唯一合法输入；隐藏牌库顺序不可见）：`,
    stateBlock(view),
    '',
    `候选行动（生成版本 ${candidateSet.version}；合法全量 ${candidateSet.fullLegalCount}，保留 ${candidateSet.keptCount}${candidateSet.pruned ? '，已确定性裁剪' : ''}；支付序列策略：${candidateSet.paymentOrderPolicy}）：`,
    ...candidateSet.candidates.map(candidateLine),
    '',
    `本局最近决策（你自己的公开理由，不是隐藏信息）：`,
    historyBlock(input.history),
    '',
    `请独立分析并选择行动：`,
    `1) 当前可认领魔像与终局倒计时；2) 未来得分路线与所需回合；3) 当前生产引擎效率；4) 获取商人卡的投资回报；5) 商队容量与水晶结构；6) 对手竞争与关键目标被抢风险；7) 建设引擎与立即认领的机会成本；8) 终局倒计时与最终第一名概率。`,
    `只输出严格 JSON，selectedActionId 必须来自上面候选 id。`,
  ].join('\n');
  const promptHash = fnv1a(`${system}\n${user}`).toString(16).padStart(8, '0');
  return { system, user, promptHash, estimatedPromptTokens: estimateTokens(system) + estimateTokens(user) };
}

/** 行动简短摘要（供历史/UI/记录复用）。 */
export function summarizeAction(view: AIObservation, action: Action): string {
  return actionSummary(view, action);
}

/** 候选数量的公开描述。 */
export function candidateStatsText(candidateSet: LLMCandidateSet): string {
  return `合法${candidateSet.fullLegalCount}/保留${candidateSet.keptCount}${candidateSet.pruned ? '（已裁剪）' : ''} · ${COLOR.join('')}`;
}
