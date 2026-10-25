/** D4/治理边界：AI7 进化控制面消费统一治理接口的适配器。
 *
 * 背景：Agent A 负责的"单一种子账本 + 晋级门禁"尚未合并。本轮所有适配器只允许
 * 使用**测试替身**；正式集成必须另行验证。适配器本身把治理规则变成可执行断言：
 * - 只接受 purpose ∈ {screen, deep} 的开发窗口；
 * - 窗口必须完整落在 AI7 开发块，且绝不触碰正式验证池 [900M, 1.06e9)；
 * - 返回的 provider 响应必须声明 pool='dev'、promotionTriggered=false；
 * - 正式挑战请求只创建 pending-human-approval 记录，绝不自动批准或晋级。
 *
 * 统一治理接口（provider contract，v1）：
 *   allocateDevSeedWindow({ campaignId, round, purpose, count, excludeWindowIds })
 *     → { windowId, purpose, pool:'dev', base, count, blockStart, blockEnd }
 *   requestFormalChallengeApproval({ campaignId, candidateId, identityDigest, evidenceDir, summary })
 *     → { requestId, status:'pending-human-approval', approvalRequired:true, promotionTriggered:false }
 *
 * 真实 provider 尚未存在；`createTestDoubleGovernance` 是离线研发替身，其返回
 * 只用于演示/测试，不产生正式证据，也不写任何账本。
 */

import {
  AI7_DEV_BLOCKS, AI7_WINDOW_SIZE, AI7_SCREEN_WINDOW_COUNT, AI7_DEEP_WINDOW_COUNT,
  SCHEMAS, assertCondition, assertNotValidationSeed, assertWindow, deepFreeze,
  sha256Canonical, shortHash, windowId,
} from './core.mjs';

export const GOVERNANCE_CONTRACT_VERSION = 'century-governance-adapter-v1';

export const GOVERNANCE_CAPABILITIES = deepFreeze({
  allocateDevSeedWindow: true,
  requestFormalChallengeApproval: true,
  recordCampaignOutcome: true,
  writeValidationLedger: false,
  promoteChampion: false,
  triggerFormalChallenge: false,
});

const PURPOSES = Object.freeze(['screen', 'deep']);

function blockForPurpose(purpose) {
  assertCondition(PURPOSES.includes(purpose), `种子窗口用途非法：${String(purpose)}（只允许 screen/deep）`);
  return AI7_DEV_BLOCKS[purpose];
}

function windowCountForPurpose(purpose) {
  return purpose === 'screen' ? AI7_SCREEN_WINDOW_COUNT : AI7_DEEP_WINDOW_COUNT;
}

/** 治理策略：按轮次轮换窗口；同一 campaign 已用窗口自动跳过。
 * 轮换是确定性的（只依赖 round、purpose、已用 id），可复现且可审计。 */
export function rotatedWindowIndex({ purpose, round, excludeWindowIds = [] }) {
  const total = windowCountForPurpose(purpose);
  assertCondition(Number.isSafeInteger(round) && round >= 1, `round 必须为 ≥1 整数，实际：${round}`);
  const excluded = new Set(excludeWindowIds);
  for (let offset = 0; offset < total; offset++) {
    const index = (round - 1 + offset) % total;
    if (!excluded.has(windowId(purpose, index))) return index;
  }
  throw new Error(`${purpose} 开发窗口池已耗尽（${total} 个窗口全部使用）——需要扩池或人工介入`);
}

export function createTestDoubleGovernance({
  screenBlock = AI7_DEV_BLOCKS.screen,
  deepBlock = AI7_DEV_BLOCKS.deep,
  windowSize = AI7_WINDOW_SIZE,
} = {}) {
  assertCondition(windowSize > 0 && (screenBlock[1] - screenBlock[0]) % windowSize === 0,
    'screenBlock 必须能被 windowSize 整除');
  assertCondition((deepBlock[1] - deepBlock[0]) % windowSize === 0,
    'deepBlock 必须能被 windowSize 整除');
  const blocks = { screen: screenBlock, deep: deepBlock };
  const requests = [];

  return {
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
    mode: 'test-double',
    capabilities: GOVERNANCE_CAPABILITIES,

    allocateDevSeedWindow({ campaignId, round, purpose, count, excludeWindowIds = [] }) {
      assertCondition(typeof campaignId === 'string' && campaignId.length > 0, 'campaignId 缺失');
      assertCondition(Number.isSafeInteger(count) && count > 0, `窗口种子数非法：${String(count)}`);
      assertCondition(count <= windowSize, `请求 ${count} 个种子超过窗口大小 ${windowSize}`);
      const block = blocks[purpose];
      const total = (block[1] - block[0]) / windowSize;
      const excluded = new Set(excludeWindowIds);
      let index = -1;
      for (let offset = 0; offset < total; offset++) {
        const candidate = (round - 1 + offset) % total;
        if (!excluded.has(windowId(purpose, candidate))) { index = candidate; break; }
      }
      assertCondition(index >= 0, `${purpose} 开发窗口池已耗尽`);
      const base = block[0] + index * windowSize;
      assertWindow({ base, count, block, name: `${purpose} 窗口` });
      return {
        windowId: windowId(purpose, index),
        purpose, pool: 'dev',
        base, count,
        blockStart: block[0], blockEnd: block[1],
        index,
      };
    },

    requestFormalChallengeApproval({ campaignId, candidateId, identityDigest, evidenceDir, summary }) {
      assertCondition(typeof campaignId === 'string' && campaignId.length > 0, 'campaignId 缺失');
      assertCondition(typeof candidateId === 'string' && candidateId.length > 0, 'candidateId 缺失');
      assertCondition(/^[0-9a-f]{64}$/.test(identityDigest ?? ''), 'identityDigest 非法');
      const requestId = `greq-${shortHash(sha256Canonical({ campaignId, candidateId, identityDigest }), 16)}`;
      const record = {
        schema: SCHEMAS.governanceRequest,
        requestId,
        campaignId,
        candidateId,
        identityDigest,
        evidenceDir: evidenceDir ?? null,
        summary: summary ?? null,
        status: 'pending-human-approval',
        approvalRequired: true,
        promotionTriggered: false,
        requestedAt: new Date().toISOString(),
      };
      requests.push(record);
      return record;
    },

    recordCampaignOutcome(outcome) {
      assertCondition(outcome && typeof outcome === 'object', 'campaign outcome 必须为对象');
      return { accepted: true, validationLedgerWritten: false };
    },

    describePolicy() {
      return {
        mode: 'test-double',
        contractVersion: GOVERNANCE_CONTRACT_VERSION,
        windowSize,
        screen: { block: [...screenBlock], windows: (screenBlock[1] - screenBlock[0]) / windowSize, windowSize },
        deep: { block: [...deepBlock], windows: (deepBlock[1] - deepBlock[0]) / windowSize, windowSize },
        validationPoolConsumption: 'forbidden',
      };
    },

    requests: () => requests.map(r => ({ ...r })),
  };
}

function assertProvider(provider) {
  assertCondition(provider && typeof provider === 'object', '治理 provider 缺失');
  for (const method of ['allocateDevSeedWindow', 'requestFormalChallengeApproval', 'recordCampaignOutcome']) {
    assertCondition(typeof provider[method] === 'function', `治理 provider 缺少方法 ${method}`);
  }
  return provider;
}

function validateWindowResponse(response, { purpose, requestedCount }) {
  assertCondition(response && typeof response === 'object', '治理 provider 未返回窗口');
  assertCondition(response.pool === 'dev', `治理 provider 返回非开发池：${String(response.pool)}（AI7 禁止正式验证池）`);
  assertCondition(response.purpose === purpose, `窗口 purpose 不符：期望 ${purpose}，实际 ${String(response.purpose)}`);
  assertCondition(typeof response.windowId === 'string' && response.windowId.length > 0, '窗口缺少 windowId');
  const block = blockForPurpose(purpose);
  const normalized = assertWindow({ base: response.base, count: response.count, block, name: `治理窗口 ${response.windowId}` });
  assertCondition(normalized.count >= requestedCount,
    `治理窗口仅 ${normalized.count} 个种子，少于请求 ${requestedCount}`);
  return deepFreeze({
    windowId: response.windowId,
    purpose,
    pool: 'dev',
    base: normalized.base,
    count: normalized.count,
    blockStart: block[0],
    blockEnd: block[1],
    contractVersion: GOVERNANCE_CONTRACT_VERSION,
  });
}

export function createGovernanceAdapter({ provider, contractVersion = GOVERNANCE_CONTRACT_VERSION } = {}) {
  const p = assertProvider(provider);
  assertCondition(contractVersion === GOVERNANCE_CONTRACT_VERSION,
    `治理接口版本不符：期望 ${GOVERNANCE_CONTRACT_VERSION}，实际 ${contractVersion}`);

  const allocated = [];
  const requests = [];

  return {
    contractVersion,
    mode: provider.mode ?? 'external',
    capabilities: GOVERNANCE_CAPABILITIES,

    /** 申请开发种子窗口；返回已断言（dev-only、不触验证池）的冻结窗口。 */
    allocateDevSeedWindow({ campaignId, round, purpose, count, excludeWindowIds = [] }) {
      blockForPurpose(purpose);
      const response = p.allocateDevSeedWindow({ campaignId, round, purpose, count, excludeWindowIds });
      const window = validateWindowResponse(response, { purpose, requestedCount: count });
      const overlap = allocated.find(w => w.purpose === purpose && w.base < window.base + window.count && window.base < w.base + w.count);
      assertCondition(!overlap, `治理窗口 ${window.windowId} 与已分配窗口 ${overlap?.windowId} 重叠`);
      allocated.push(window);
      return window;
    },

    /** 创建正式挑战待审核请求。该调用绝不触发正式挑战或晋级。 */
    requestFormalChallengeApproval(request) {
      assertCondition(request && typeof request === 'object', '挑战请求必须为对象');
      const response = p.requestFormalChallengeApproval(request);
      assertCondition(response && typeof response === 'object', '治理 provider 未返回挑战请求记录');
      assertCondition(response.approvalRequired === true, '正式挑战请求必须要求人工审批');
      assertCondition(response.promotionTriggered === false,
        '治理 provider 返回 promotionTriggered=true——AI7 适配器禁止自动晋级');
      assertCondition(response.status === 'pending-human-approval',
        `正式挑战请求状态必须为 pending-human-approval，实际：${String(response.status)}`);
      assertCondition(typeof response.requestId === 'string' && response.requestId.length > 0, '挑战请求缺少 requestId');
      assertCondition(response.candidateId === request.candidateId, '挑战请求 candidateId 不符');
      assertCondition(response.identityDigest === request.identityDigest, '挑战请求 identityDigest 不符');
      const record = deepFreeze({
        ...response,
        validationPoolConsumed: false,
        promotionTriggered: false,
      });
      requests.push(record);
      return record;
    },

    recordCampaignOutcome(outcome) {
      const response = p.recordCampaignOutcome(outcome);
      assertCondition(response?.validationLedgerWritten === false, '治理 provider 不应在开发阶段写验证账本');
      return response;
    },

    /** 审计：本次进程分配的全部窗口与请求。 */
    auditTrail() {
      return deepFreeze({
        contractVersion,
        mode: provider.mode ?? 'external',
        windows: allocated.map(w => ({ ...w })),
        requests: requests.map(r => ({ ...r })),
        validationPoolConsumed: false,
        promotionTriggered: false,
      });
    },
  };
}
