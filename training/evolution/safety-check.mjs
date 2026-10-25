/** D4 静态安全检查：候选 artifact 进入开发池评估前的强制门禁。
 *
 * 检查项全部可复现、无网络、无墙钟依赖：
 * 1. artifact-schema：结构 + 全部哈希可复现；
 * 2. parameter-bounds：目标参数在声明边界内，分人数选项完整；
 * 3. hidden-info：源码/声明模块不得包含隐藏牌库、随机源、未来顺序；
 * 4. forbidden-constructs：不得包含 import/eval/process/fs/网络/时钟等构造；
 * 5. resource-budget：候选数与评估局数在目标预算内；
 * 6. fallback-declared：目标声明了回退策略；
 * 7. governance-boundary：实验种子只引用 dev 窗口，不触正式验证池；
 * 8. production-isolation：proxy 候选不得声明生产接线；game 候选必须显式适配器身份；
 * 9. identity-reproducible：artifact + source + build 哈希可重算。
 *
 * 任一 fail → artifact.safety.status='failed'，控制器隔离该候选，其他候选继续。
 */

import {
  ALL_PLAYER_COUNTS, HIDDEN_INFO_KEYS, assertCondition, scanForbiddenConstructs,
} from './core.mjs';
import { validateArtifact, verifyArtifactReproducibility } from './candidate-artifact.mjs';
import { getTarget } from './evolution-targets.mjs';
import { AI7_DEV_BLOCKS } from './core.mjs';

function check(id, fn) {
  try {
    const detail = fn();
    return { id, status: 'pass', detail: detail ?? 'ok' };
  } catch (error) {
    return { id, status: 'fail', detail: error.message.slice(0, 300) };
  }
}

function artifactText(artifact) {
  return artifact.source.files.map(f => `${f.path}\n${f.content}`).join('\n');
}

/** 运行全部安全检查；返回 { status, checks }（不修改 artifact）。 */
export function runSafetyChecks(artifact) {
  const checks = [];

  checks.push(check('artifact-schema', () => {
    validateArtifact(artifact);
    return `schema=${artifact.schema}, identity=${artifact.identityDigest.slice(0, 12)}`;
  }));

  checks.push(check('parameter-bounds', () => {
    const targetIds = artifact.algorithmStructure.targetIds;
    for (const targetId of targetIds) {
      const target = getTarget(targetId);
      if (target.kind === 'parameter-vector') {
        if (target.structural) {
          assertCondition(Array.isArray(artifact.parameters.values.playerCounts), 'playerCounts 缺失');
          for (const n of artifact.parameters.values.playerCounts) {
            assertCondition(ALL_PLAYER_COUNTS.includes(n), `适用人数非法：${n}`);
          }
        } else {
          assertCondition(artifact.parameters.values && typeof artifact.parameters.values === 'object',
            '搜索控制候选 parameters.values 缺失');
        }
      } else {
        assertCondition(artifact.parameters.values?.coefficients, '模块候选缺少系数');
        for (const [key, value] of Object.entries(artifact.parameters.values.coefficients)) {
          assertCondition(Number.isFinite(value), `系数 ${key} 非有限`);
          assertCondition(value >= -3 && value <= 3, `系数 ${key} 越界：${value}`);
        }
      }
    }
    return `targets=${targetIds.join(',')}`;
  }));

  checks.push(check('hidden-info', () => {
    const text = artifactText(artifact);
    for (const key of HIDDEN_INFO_KEYS) {
      // 只扫描候选自带的源码/备注文本；descriptor 的公开字段（stock/hand/played）不在此列。
      if (new RegExp(`\\b${key}\\b`).test(text)) {
        throw new Error(`候选源码/声明模块包含隐藏信息字段：${key}`);
      }
    }
    return 'no hidden deck/seed/random access';
  }));

  checks.push(check('forbidden-constructs', () => {
    const hits = scanForbiddenConstructs(artifactText(artifact));
    if (hits.length) throw new Error(hits.map(h => `${h.why}（${h.token}）`).join('；'));
    return 'no forbidden constructs';
  }));

  checks.push(check('resource-budget', () => {
    const targetIds = artifact.algorithmStructure.targetIds;
    for (const targetId of targetIds) {
      const target = getTarget(targetId);
      if (target.kind === 'parameter-vector') {
        assertCondition(artifact.applicablePlayerCounts.length <= 4, '适用人数超过预算');
      } else {
        const text = artifactText(artifact);
        assertCondition(text.length <= target.resourceBudget.maxInputBytes,
          `${targetId} 源文本 ${text.length}B 超过预算 ${target.resourceBudget.maxInputBytes}B`);
      }
    }
    return `players=${artifact.applicablePlayerCounts.join(',')}`;
  }));

  checks.push(check('fallback-declared', () => {
    for (const targetId of artifact.algorithmStructure.targetIds) {
      const target = getTarget(targetId);
      assertCondition(target.fallback && target.fallback.strategy, `目标 ${targetId} 未声明回退策略`);
    }
    return 'fallback strategy present';
  }));

  checks.push(check('governance-boundary', () => {
    for (const ref of artifact.experiment.seedRefs) {
      const block = AI7_DEV_BLOCKS[ref.purpose];
      assertCondition(block, `seedRef purpose 非法：${ref.purpose}`);
      assertCondition(ref.base >= block[0] && ref.base + ref.count <= block[1],
        `seedRef ${ref.windowId} 越出 AI7 ${ref.purpose} 开发块`);
    }
    return 'dev-only seed references';
  }));

  checks.push(check('production-isolation', () => {
    const mode = artifact.algorithmStructure.evaluationMode;
    if (mode === 'proxy') {
      assertCondition(artifact.algorithmStructure.integration === 'candidate-plugin-only',
        'proxy 候选不得声明生产接线');
      assertCondition(artifact.algorithmStructure.decisionCore === 'plugin-only',
        'proxy 候选决策核心必须为 plugin-only');
    } else {
      assertCondition(artifact.algorithmStructure.integration === 'production-seat-dispatch',
        'game 候选缺少生产分派声明');
      assertCondition(artifact.algorithmStructure.adapter === 'champion-guided',
        'game 候选必须携带 champion-guided 适配器身份');
      assertCondition(artifact.parameters.values?.adapter === 'champion-guided',
        'game 候选参数缺少 adapter=champion-guided');
    }
    return `mode=${mode}`;
  }));

  checks.push(check('identity-reproducible', () => {
    const result = verifyArtifactReproducibility(artifact);
    assertCondition(result.ok, result.error ?? 'artifact 不可复现');
    return `source=${artifact.sourceHash.slice(0, 12)}, build=${artifact.buildArtifact.sha256.slice(0, 12)}`;
  }));

  const status = checks.every(c => c.status === 'pass') ? 'passed' : 'failed';
  return { status, checks };
}
