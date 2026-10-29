/** LLM 结构化响应解析与严格 Schema 校验（不保存隐藏思维链）。 */

import type { LLMDecisionPayload, LLMSchemaValidation } from './types.js';

const STRATEGY_ALIASES: Record<string, string> = {
  engine: 'engine', 引擎: 'engine', 生产: 'engine', 引擎建设: 'engine',
  tempo: 'tempo', 节奏: 'tempo', 速度: 'tempo', 速攻: 'tempo',
  contest: 'contest', 竞争: 'contest', 压制: 'contest', 抢牌: 'contest',
  synergy: 'synergy', 协同: 'synergy', 组合: 'synergy',
  goal: 'goal', 目标: 'goal', 魔像: 'goal', 认领: 'goal',
  capacity: 'capacity', 容量: 'capacity', 商队: 'capacity',
  rest: 'rest', 休息: 'rest', 回收: 'rest',
  endgame: 'endgame', 终局: 'endgame', 倒计时: 'endgame',
  risk: 'risk', 风险: 'risk', 稳健: 'risk',
};

const ALLOWED_STRATEGY_TAGS = new Set(['engine', 'tempo', 'contest', 'synergy', 'goal', 'capacity', 'rest', 'endgame', 'risk']);

/** 从可能带 Markdown 围栏/前后说明的文本中提取 JSON 对象。 */
export function extractJsonObject(text: string): unknown {
  const raw = String(text ?? '').trim();
  if (!raw) throw new Error('响应为空');
  const candidates: string[] = [raw];
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(raw.slice(first, last + 1));
  let lastError: unknown = null;
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`响应不是合法 JSON：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function textField(value: unknown, name: string, maxLength: number, errors: string[]): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    errors.push(`${name} 必须是非空字符串`);
    return '';
  }
  const text = value.trim();
  if (text.length > maxLength) {
    errors.push(`${name} 超过长度上限 ${maxLength}（实际 ${text.length}）`);
  }
  return text.slice(0, maxLength);
}

function stringArray(value: unknown, name: string, maxItems: number, maxLength: number, errors: string[], warnings: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push(`${name} 必须是数组`);
    return [];
  }
  if (value.length > maxItems) warnings.push(`${name} 条目 ${value.length} 超过建议上限 ${maxItems}，已截断`);
  const result: string[] = [];
  for (const item of value.slice(0, maxItems)) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push(`${name} 只能包含非空字符串`);
      continue;
    }
    result.push(item.trim().slice(0, maxLength));
  }
  return result;
}

function normalizeStrategyTags(value: unknown, errors: string[], warnings: string[]): string[] {
  if (!Array.isArray(value)) {
    errors.push('strategyTags 必须是数组');
    return [];
  }
  const result: string[] = [];
  for (const item of value.slice(0, 8)) {
    if (typeof item !== 'string' || item.trim().length === 0) {
      errors.push('strategyTags 只能包含非空字符串');
      continue;
    }
    const key = item.trim().toLowerCase();
    const mapped = STRATEGY_ALIASES[key] ?? STRATEGY_ALIASES[item.trim()];
    if (mapped && ALLOWED_STRATEGY_TAGS.has(mapped)) {
      if (!result.includes(mapped)) result.push(mapped);
    } else {
      warnings.push(`未知策略标签已忽略：${item.trim().slice(0, 40)}`);
    }
  }
  if (result.length === 0) warnings.push('strategyTags 为空或全部未知，样本质量下降');
  return result;
}

/**
 * 校验 LLM 结构化响应。
 * @param value 已解析的 JSON（或原始文本）
 * @param candidateIds 当前候选行动 ID 集合
 */
export function validateLLMResponse(value: unknown, candidateIds: readonly string[]): LLMSchemaValidation {
  const errors: string[] = [];
  const warnings: string[] = [];
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = extractJsonObject(value);
    } catch (error) {
      return { ok: false, value: null, errors: [error instanceof Error ? error.message : String(error)], warnings };
    }
  }
  if (!isRecord(parsed)) {
    return { ok: false, value: null, errors: ['响应顶层必须是 JSON 对象'], warnings };
  }
  const allowedKeys = new Set([
    'selectedActionId', 'reason', 'primaryGoal', 'alternativeActions',
    'expectedBenefits', 'risks', 'strategyTags',
  ]);
  for (const key of Object.keys(parsed)) {
    if (!allowedKeys.has(key)) errors.push(`未知字段：${key}`);
  }
  const idSet = new Set(candidateIds);
  const selectedActionId = textField(parsed.selectedActionId, 'selectedActionId', 80, errors);
  if (selectedActionId && !idSet.has(selectedActionId)) {
    errors.push(`selectedActionId ${selectedActionId} 不在合法候选集中`);
  }
  const reason = textField(parsed.reason, 'reason', 600, errors);
  const primaryGoal = textField(parsed.primaryGoal, 'primaryGoal', 240, errors);

  const alternativeActions: LLMDecisionPayload['alternativeActions'] = [];
  if (!Array.isArray(parsed.alternativeActions)) {
    errors.push('alternativeActions 必须是数组');
  } else {
    for (const item of parsed.alternativeActions.slice(0, 6)) {
      if (!isRecord(item)) {
        errors.push('alternativeActions 条目必须是对象');
        continue;
      }
      const actionId = textField(item.actionId, 'alternativeActions.actionId', 80, errors);
      const comparison = textField(item.comparison, 'alternativeActions.comparison', 300, errors);
      if (actionId && !idSet.has(actionId)) {
        warnings.push(`alternative actionId ${actionId} 不在候选集中，已忽略`);
        continue;
      }
      if (actionId === selectedActionId) {
        warnings.push('alternativeActions 包含与所选行动相同的 id，已忽略');
        continue;
      }
      alternativeActions.push({ actionId, comparison });
    }
    if (alternativeActions.length === 0) warnings.push('缺少有效的竞争替代行动');
  }

  const expectedBenefits = stringArray(parsed.expectedBenefits, 'expectedBenefits', 8, 240, errors, warnings);
  const risks = stringArray(parsed.risks, 'risks', 8, 240, errors, warnings);
  const strategyTags = normalizeStrategyTags(parsed.strategyTags, errors, warnings);

  if (errors.length) return { ok: false, value: null, errors, warnings };
  return {
    ok: true,
    value: {
      selectedActionId, reason, primaryGoal, alternativeActions,
      expectedBenefits, risks, strategyTags,
    },
    errors,
    warnings,
  };
}
