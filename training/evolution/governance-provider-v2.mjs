/** P1/P2：真实种子治理 Provider（替代 Campaign Controller 的测试替身）。
 *
 * 与 governance-adapter.mjs（v1）的区别：
 * - v1 的 provider 是离线测试替身，只演示窗口轮换；本模块把分配接到
 *   training/lib/seed-governance.mjs 的中央登记与跨系统冲突检查；
 * - 每次窗口分配在动用种子前原子登记（reserveConsumption），失败即中止，
 *   不存在"先跑后记账"；
 * - 正式挑战请求不再等待人工批准，而是进入机器门禁队列
 *   （approvalRequired=false, machineGateRequired=true）——人工审批被机器门禁
 *   取代，但门禁本身不删除；
 * - 本 Provider 永不写验证账本、永不直接晋级。
 */

import { loadSeedGovernance, queryInterval, reserveConsumption, CENTRAL_REGISTRY_PATH } from '../lib/seed-governance.mjs';
import { AI7_DEV_BLOCKS, AI7_WINDOW_SIZE, ai7WindowCount, windowId, sha256Canonical, shortHash, assertCondition } from './core.mjs';

export const GOVERNANCE_CONTRACT_V2 = 'century-governance-adapter-v2';

const PURPOSE_CLASS = Object.freeze({ screen: 'screening', deep: 'deep-validation' });

function windowIndexes(purpose) {
  return Array.from({ length: ai7WindowCount(purpose) }, (_, i) => i);
}

function intervalFor(purpose, index) {
  const block = AI7_DEV_BLOCKS[purpose];
  const base = block[0] + index * AI7_WINDOW_SIZE;
  return { base, count: AI7_WINDOW_SIZE };
}

/** 真实 Provider：中央登记 + 全系统冲突检查 + 原子分配。 */
export function createLiveGovernanceProvider({
  registryPath = CENTRAL_REGISTRY_PATH,
  windowSize = AI7_WINDOW_SIZE,
  root = undefined,
} = {}) {
  assertCondition(windowSize === AI7_WINDOW_SIZE, `真实治理窗口大小固定为 ${AI7_WINDOW_SIZE}，实际：${windowSize}`);
  const requests = [];

  return {
    contractVersion: GOVERNANCE_CONTRACT_V2,
    mode: 'live',
    capabilities: Object.freeze({
      allocateDevSeedWindow: true,
      requestFormalChallenge: true,
      recordCampaignOutcome: true,
      writeValidationLedger: false,
      promoteChampion: false,
    }),

    allocateDevSeedWindow({ campaignId, round, purpose, count, excludeWindowIds = [] }) {
      assertCondition(typeof campaignId === 'string' && campaignId.length > 0, 'campaignId 缺失');
      assertCondition(Number.isSafeInteger(round) && round >= 1, `round 非法：${String(round)}`);
      assertCondition(Number.isSafeInteger(count) && count > 0 && count <= windowSize, `窗口种子数非法：${String(count)}`);
      assertCondition(purpose === 'screen' || purpose === 'deep', `purpose 非法：${String(purpose)}`);
      const block = AI7_DEV_BLOCKS[purpose];
      const registry = loadSeedGovernance({ strict: true, ...(root ? { root } : {}) });
      assertCondition(registry.complete, `种子治理层不完整：${registry.missingSources.join(',')}`);
      assertCondition((registry.conflicts ?? []).length === 0, '种子治理层存在跨系统冲突，禁止分配开发窗口');
      const excluded = new Set(excludeWindowIds);
      const total = (block[1] - block[0]) / windowSize;
      for (const offset of Array.from({ length: total }, (_, i) => (round - 1 + i) % total)) {
        const id = windowId(purpose, offset);
        if (excluded.has(id)) continue;
        const { base, count: size } = intervalFor(purpose, offset);
        if (queryInterval(registry, base, size).length > 0) continue;
        // 原子登记：在动用种子之前占用窗口（中止不退还，绝不复用）。
        const experimentId = `ai7-dev-${campaignId}-r${round}-${purpose}`;
        try {
          reserveConsumption({
            purposeClass: PURPOSE_CLASS[purpose],
            purpose: `ai7-campaign-${purpose}`,
            base,
            size,
            experimentId,
            evidencePath: null,
            registryPath,
            ...(root ? { root } : {}),
          });
        } catch (error) {
          // 并发窗口被其他进程抢占：继续尝试下一个候选窗口。
          if (/重叠|已登记/.test(error.message)) continue;
          throw error;
        }
        return {
          windowId: id,
          purpose,
          pool: 'dev',
          base,
          count: size,
          blockStart: block[0],
          blockEnd: block[1],
          index: offset,
        };
      }
      throw new Error(`${purpose} 开发窗口池已耗尽（块 [${block[0]}, ${block[1]}) 无可分配窗口）`);
    },

    requestFormalChallenge({ campaignId, candidateId, identityDigest, evidenceDir, summary }) {
      assertCondition(typeof campaignId === 'string' && campaignId.length > 0, 'campaignId 缺失');
      assertCondition(typeof candidateId === 'string' && candidateId.length > 0, 'candidateId 缺失');
      assertCondition(/^[0-9a-f]{64}$/.test(String(identityDigest ?? '')), 'identityDigest 非法');
      const requestId = `mcgre-${shortHash(sha256Canonical({ campaignId, candidateId, identityDigest }), 16)}`;
      const record = {
        schema: 'century-machine-gate-challenge-request-v1',
        requestId,
        campaignId,
        candidateId,
        identityDigest,
        evidenceDir: evidenceDir ?? null,
        summary: summary ?? null,
        status: 'queued-machine-gate',
        approvalRequired: false,
        machineGateRequired: true,
        promotionTriggered: false,
        gates: [
          'first-place-preregistered-challenge',
          'seat-count-non-inferiority',
          'alpha-ledger',
          'seed-governance',
          'build-identity',
          'full-ci',
          'deploy-verification',
          'rollback-verification',
        ],
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
        mode: 'live',
        contractVersion: GOVERNANCE_CONTRACT_V2,
        windowSize,
        screen: { block: [...AI7_DEV_BLOCKS.screen], windows: ai7WindowCount('screen'), windowSize },
        deep: { block: [...AI7_DEV_BLOCKS.deep], windows: ai7WindowCount('deep'), windowSize },
        validationPoolConsumption: 'forbidden',
        promotion: 'machine-gate (no human approval)',
      };
    },

    requests: () => requests.map(r => ({ ...r })),
  };
}

/** 审计包装：断言 Provider 不触验证池、不直接晋级、请求进入机器门禁。 */
export function createAutonomousGovernanceAdapter({ provider }) {
  assertCondition(provider && typeof provider === 'object', '治理 provider 缺失');
  for (const method of ['allocateDevSeedWindow', 'requestFormalChallenge', 'recordCampaignOutcome']) {
    assertCondition(typeof provider[method] === 'function', `治理 provider 缺少方法 ${method}`);
  }
  const allocated = [];
  const requests = [];

  return {
    contractVersion: GOVERNANCE_CONTRACT_V2,
    mode: provider.mode ?? 'live',
    capabilities: provider.capabilities,

    allocateDevSeedWindow({ campaignId, round, purpose, count, excludeWindowIds = [] }) {
      const window = provider.allocateDevSeedWindow({ campaignId, round, purpose, count, excludeWindowIds });
      assertCondition(window?.pool === 'dev', `治理 provider 返回非开发池：${String(window?.pool)}`);
      assertCondition(window.purpose === purpose, '窗口 purpose 不符');
      assertCondition(window.blockStart === AI7_DEV_BLOCKS[purpose][0] && window.blockEnd === AI7_DEV_BLOCKS[purpose][1],
        '窗口区块与 AI7 开发池不一致');
      assertCondition(window.base >= AI7_DEV_BLOCKS[purpose][0] && window.base + count <= AI7_DEV_BLOCKS[purpose][1],
        `窗口 [${window.base},${window.base + count}) 越界`);
      const overlap = allocated.find(w => w.purpose === purpose && w.base < window.base + window.count && window.base < w.base + w.count);
      assertCondition(!overlap, `窗口 ${window.windowId} 与已分配窗口 ${overlap?.windowId} 重叠`);
      allocated.push(window);
      return window;
    },

    requestFormalChallenge(request) {
      const response = provider.requestFormalChallenge(request);
      assertCondition(response?.promotionTriggered === false, '治理 provider 不得直接触发晋级');
      assertCondition(response?.status === 'queued-machine-gate', `挑战请求状态必须为 queued-machine-gate，实际：${String(response?.status)}`);
      assertCondition(response?.machineGateRequired === true, '挑战请求必须声明机器门禁');
      assertCondition(response?.approvalRequired === false, 'autonomous 模式不得要求人工批准');
      assertCondition(response.candidateId === request.candidateId, '挑战请求 candidateId 不符');
      assertCondition(response.identityDigest === request.identityDigest, '挑战请求 identityDigest 不符');
      const record = Object.freeze({ ...response, validationPoolConsumed: false, promotionTriggered: false });
      requests.push(record);
      return record;
    },

    /** Campaign Controller 兼容入口（同一机器门禁语义）。 */
    requestFormalChallengeApproval(request) {
      return this.requestFormalChallenge(request);
    },

    recordCampaignOutcome(outcome) {
      const response = provider.recordCampaignOutcome(outcome);
      assertCondition(response?.validationLedgerWritten === false, '开发阶段不得写验证账本');
      return response;
    },

    auditTrail() {
      return Object.freeze({
        contractVersion: GOVERNANCE_CONTRACT_V2,
        mode: provider.mode ?? 'live',
        windows: allocated.map(w => ({ ...w })),
        requests: requests.map(r => ({ ...r })),
        validationPoolConsumed: false,
        promotionTriggered: false,
      });
    },
  };
}
