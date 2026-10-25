/** D2：OpenEvolve 离线提案适配器（LLM 只产出有界 spec，不产出可执行引擎代码）。
 *
 * 设计边界：
 * - OpenEvolve/LLM 在离线研发阶段可以提出候选，但输出必须是 JSON 提案：
 *   { schema, targetId, values, rationale }；values 只能落在目标声明的边界内；
 * - 提案由本适配器校验并物化为 Candidate Artifact，再由 Campaign Controller
 *   执行安全检查/开发池评估；LLM 不进入最终游戏推理路径；
 * - 提案不允许包含源码、import、shell 命令或"改写整个引擎"的字段；
 * - 同一提案重复解析结果确定性一致（无随机/时钟）。
 *
 * 该模块不启动 LLM，也不修改 ai5/openevolve 既有配置；它只定义"外部生成器
 * → 统一 Candidate Artifact"的边界。真实 OpenEvolve 运行通过
 * `createProposalGenerator` 的 proposals 输入接入。
 */

import { createCandidateFromSpec } from './candidate-generator.mjs';
import { getTarget, normalizeModuleSpec, normalizeSearchValues } from './evolution-targets.mjs';
import { assertCondition, deepFreeze, sha256Canonical, SCHEMAS } from './core.mjs';

export const OPENEVOLVE_PROPOSAL_SCHEMA = 'century-ai7-openevolve-proposal-v1';
export const OPENEVOLVE_OUTPUT_CONTRACT = deepFreeze({
  schema: OPENEVOLVE_PROPOSAL_SCHEMA,
  format: 'JSON array（或 JSONL，每行一个对象）',
  allowedFields: ['schema', 'targetId', 'values', 'rationale'],
  forbiddenFields: ['source', 'code', 'imports', 'shell', 'parameters', 'engine', 'patch'],
  discipline: [
    '只能提出有界参数或声明式线性模块系数；禁止提出任意 TypeScript/JS 代码。',
    'targetId 必须在已注册目标内；values 必须通过目标边界校验。',
    'rationale 只用于研究记录，不能作为评分/奖励真值。',
    '提案不直接进入冠军路径；必须经 artifact 安全检查与人工审批。',
  ],
});

function normalizeProposal(proposal) {
  assertCondition(proposal && typeof proposal === 'object', '提案必须为对象');
  for (const key of Object.keys(proposal)) {
    assertCondition(OPENEVOLVE_OUTPUT_CONTRACT.allowedFields.includes(key), `提案含未声明字段：${key}`);
  }
  assertCondition(proposal.schema === OPENEVOLVE_PROPOSAL_SCHEMA,
    `提案 schema 必须为 ${OPENEVOLVE_PROPOSAL_SCHEMA}，实际：${String(proposal.schema)}`);
  assertCondition(typeof proposal.targetId === 'string' && proposal.targetId.length > 0, '提案缺少 targetId');
  assertCondition(proposal.values && typeof proposal.values === 'object', '提案缺少 values');
  const target = getTarget(proposal.targetId);
  const values = target.kind === 'function-module'
    ? normalizeModuleSpec(proposal.targetId, proposal.values)
    : normalizeSearchValues(proposal.targetId, proposal.values);
  return {
    schema: OPENEVOLVE_PROPOSAL_SCHEMA,
    targetId: proposal.targetId,
    values,
    rationale: typeof proposal.rationale === 'string' ? proposal.rationale.slice(0, 500) : null,
  };
}

/** 解析 LLM 提案文本（JSON 数组或 JSONL）；非法项进入 rejected，不阻断合法项。 */
export function parseOpenEvolveProposals(text, { maxCandidates = 8 } = {}) {
  assertCondition(typeof text === 'string' && text.trim().length > 0, '提案文本为空');
  const trimmed = text.trim();
  let raw;
  if (trimmed.startsWith('[')) {
    raw = JSON.parse(trimmed);
    assertCondition(Array.isArray(raw), '提案 JSON 必须为数组');
  } else {
    raw = trimmed.split('\n').filter(line => line.trim()).map((line, index) => {
      try { return JSON.parse(line); } catch (error) {
        throw new Error(`提案第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
    });
  }
  assertCondition(raw.length <= maxCandidates, `提案数 ${raw.length} 超过上限 ${maxCandidates}`);
  const proposals = [];
  const rejected = [];
  for (let i = 0; i < raw.length; i++) {
    try {
      proposals.push(normalizeProposal(raw[i]));
    } catch (error) {
      rejected.push({ index: i, error: error.message.slice(0, 300) });
    }
  }
  return deepFreeze({
    schema: 'century-ai7-openevolve-proposal-parse-v1',
    proposals,
    rejected,
    proposalDigest: proposals.length > 0 ? sha256Canonical(proposals) : null,
  });
}

/**
 * 把外部提案包装成 Campaign Controller 可用的生成器。
 * @param {object} options
 * @param {Array<object>} options.proposals parseOpenEvolveProposals().proposals
 * @param {number} [options.round]
 */
export function createProposalGenerator({ proposals, round = 1 }) {
  assertCondition(Array.isArray(proposals) && proposals.length > 0, 'proposals 不能为空');
  return ({ experiment, round: requestedRound = round, parentArtifact = null }) => {
    const candidates = [];
    const rejectedAtGeneration = [];
    proposals.forEach((proposal, index) => {
      try {
        candidates.push(createCandidateFromSpec({
          targetId: proposal.targetId,
          values: proposal.values,
          round: requestedRound,
          index,
          parentArtifact,
          experiment,
        }));
      } catch (error) {
        rejectedAtGeneration.push({
          targetId: proposal.targetId,
          index,
          error: error.message.slice(0, 300),
        });
      }
    });
    return { candidates, rejectedAtGeneration };
  };
}

/** 给 OpenEvolve prompt 的稳定契约正文（不含任何密钥/路径）。 */
export function openEvolvePromptContract() {
  return [
    'You are proposing bounded candidate configurations for the Century AI evolution platform.',
    'Return ONLY a JSON array. Each item: {"schema":"century-ai7-openevolve-proposal-v1","targetId":"...","values":{...},"rationale":"..."}',
    'Allowed targets and value shapes:',
    ...getTargetListForPrompt(),
    'HARD: never output source code, imports, shell commands, engine patches, or unbounded fields.',
    'HARD: rationale is research metadata, not reward truth.',
  ].join('\n');
}

function getTargetListForPrompt() {
  return [
    'acquisitionValue/engineValue/goalValue/keepValue/restValue: {"coefficients":{feature:number(-3..3)}, "bias":number(-2..2)}',
    'gateThreshold: {"contestThreshold":0.5..0.99}',
    'overrideMargin: {"overrideMargin":0..0.2}',
    'candidateCap: {"candidateCap":2..8 integer}',
    'searchBudget: {"workUnits":8..512 integer}',
    'searchBudgetAllocation: {"2":8..512,"3":8..512,"4":8..512,"5":8..512}',
    'playerCountScope: {"playerCounts":[2,3,4,5] subset}',
  ];
}

export { SCHEMAS };
