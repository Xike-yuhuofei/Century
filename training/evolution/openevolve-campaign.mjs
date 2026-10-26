/** P1：OpenEvolve 与 Campaign Controller 的生产接线（双轨道生成器）。
 *
 * 轨道 A：有界参数/搜索结构变异（deterministic-bounded-mutation）。
 * 轨道 B：OpenEvolve 真实 LLM 源码进化（EVOLVE-BLOCK 白名单 + 静态检查 +
 *        隔離编译 + 真实对局级联评估），best program 经 openevolve-bridge 变成
 *        独立 Candidate Artifact，进入 Campaign 的安全检查与后续筛选。
 *
 * 纪律：
 * - 只有真实启动 OpenEvolve 并读到 best program 时，候选才标记 generator='openevolve-llm'；
 * - LLM 不可用/超时/失败：按配置安全停止（抛错，campaign 失败）或使用
 *   明确标记的 deterministic-bounded-mutation 继续，绝不伪装成 OpenEvolve 成功；
 * - OpenEvolve 自身已经完成真实对局（stage2/stage3）与第一名率统计；其证据只作为
 *   generatorMeta 记录，不替代 Campaign 的独立评估，也不直接触发冠军晋级；
 * - 候选源码只允许改 EVOLVE-BLOCK 内的 acquisitionValue；编译/静态检查仍在沙箱内。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertCondition } from './core.mjs';
import { generateCandidateBatch } from './candidate-generator.mjs';
import {
  probeOpenEvolve, runOpenEvolve, createCandidateFromOpenEvolve, loadOpenEvolveBestProgram,
} from './openevolve-bridge.mjs';

export const OPENEVOLVE_CAMPAIGN_MODES = Object.freeze([
  'bounded', 'openevolve-hybrid', 'openevolve-only',
]);

const SOURCE_TARGET_ID = 'acquisitionValue';

/** bounded 生成器既可能返回数组（默认 generateCandidateBatch），也可能返回带
 * rejectedAtGeneration 的对象（外部注入）；统一成对象后再合并。 */
function normalizeBounded(result) {
  if (Array.isArray(result)) return { candidates: result, rejectedAtGeneration: [] };
  return {
    candidates: result?.candidates ?? [],
    rejectedAtGeneration: result?.rejectedAtGeneration ?? [],
  };
}

function readBestEvidence(outputDir) {
  const loaded = loadOpenEvolveBestProgram({ outputDir });
  if (!loaded.available) return { loaded, evidence: null };
  const metrics = loaded.info?.metrics ?? {};
  return {
    loaded,
    evidence: {
      bestProgramId: loaded.info?.id ?? null,
      generation: loaded.info?.generation ?? null,
      parentId: loaded.info?.parent_id ?? null,
      functionSha256: loaded.functionSha256,
      identicalToOfficial: metrics.identical_to_official === 1,
      combinedScore: metrics.combined_score ?? null,
      stagePassed: metrics.stage_passed ?? null,
      games: metrics.games ?? 0,
      firstPlaceDelta: metrics.first_place_delta ?? null,
      firstPlaceCiLower: metrics.first_place_ci_lower ?? null,
      candidateFirstRate: metrics.candidate_first_rate ?? null,
      championFirstRate: metrics.champion_first_rate ?? null,
      anomalyRate: metrics.anomaly_rate ?? null,
      primaryMetric: 'first-place',
    },
  };
}

/**
 * 创建 Campaign Controller 可用的生成器。
 *
 * @param {object} options
 * @param {string} [options.mode] bounded | openevolve-hybrid | openevolve-only
 * @param {number} [options.iterations] OpenEvolve LLM 迭代数
 * @param {number} [options.timeoutMs] OpenEvolve 进程超时（毫秒）
 * @param {string|null} [options.outputDir] 固定输出目录（可复现）
 * @param {'fallback'|'stop'} [options.onLlmUnavailable]
 * @param {Function} [options.runFn] 测试注入点（默认 runOpenEvolve）
 * @param {Function} [options.probeFn] 测试注入点（默认 probeOpenEvolve）
 * @param {Function} [options.createFromRunFn] 测试注入点
 * @param {Function} [options.boundedFn] 测试注入点（默认 generateCandidateBatch）
 */
export function createOpenEvolveCampaignGenerator({
  mode = 'bounded',
  iterations = 1,
  timeoutMs = 3_600_000,
  outputDir = null,
  onLlmUnavailable = 'fallback',
  runFn = runOpenEvolve,
  probeFn = probeOpenEvolve,
  createFromRunFn = createCandidateFromOpenEvolve,
  boundedFn = generateCandidateBatch,
} = {}) {
  assertCondition(OPENEVOLVE_CAMPAIGN_MODES.includes(mode), `生成器模式非法：${mode}`);
  assertCondition(Number.isSafeInteger(iterations) && iterations >= 1, `OpenEvolve iterations 非法：${iterations}`);
  assertCondition(Number.isSafeInteger(timeoutMs) && timeoutMs >= 60_000, `OpenEvolve timeoutMs 非法：${timeoutMs}`);
  assertCondition(onLlmUnavailable === 'fallback' || onLlmUnavailable === 'stop',
    `onLlmUnavailable 非法：${onLlmUnavailable}`);

  if (mode === 'bounded') {
    return (options) => {
      const batch = normalizeBounded(boundedFn(options));
      const candidates = batch.candidates.map(item => ({
        ...item,
        generator: 'deterministic-bounded-mutation',
        generatorMeta: { sourceKind: 'bounded-mutation', openevolve: null },
      }));
      return { ...batch, candidates };
    };
  }

  return (options) => {
    const { count, round, experiment, parentArtifact = null, targetIds = null } = options;
    // 每轮独立输出目录：避免第二轮覆盖第一轮 best program，保证跨轮证据可追溯。
    const roundOutputDir = outputDir
      ? `${outputDir}-r${String(round).padStart(3, '0')}`
      : null;
    const rejectedAtGeneration = [];
    const sourceAllowed = targetIds === null || targetIds.includes(SOURCE_TARGET_ID);
    const meta = {
      mode,
      onLlmUnavailable,
      iterations,
      outputDir: roundOutputDir ?? outputDir,
      probe: null,
      run: null,
      evidence: null,
      fallback: null,
    };

    let sourceItem = null;
    if (sourceAllowed) {
      const probe = probeFn();
      meta.probe = { available: probe.available, blocked: probe.blocked, checks: probe.checks };
      if (probe.available) {
        let run = null;
        try {
          run = runFn({ iterations, outputDir: roundOutputDir, timeoutMs });
        } catch (error) {
          run = { ok: false, reason: String(error?.message ?? error).slice(0, 500) };
        }
        meta.run = run ? {
          ok: run.ok === true,
          status: run.status ?? null,
          signal: run.signal ?? null,
          elapsedMs: run.elapsedMs ?? null,
          outputDir: run.outputDir ?? null,
          reason: run.reason ?? null,
        } : null;
        if (run?.ok === true) {
          const evidence = readBestEvidence(run.outputDir);
          meta.evidence = evidence.evidence;
          if (!evidence.loaded.available) {
            rejectedAtGeneration.push({
              targetId: SOURCE_TARGET_ID,
              error: `OpenEvolve best program 不可读：${evidence.loaded.reason}`,
            });
          } else {
            try {
              const created = createFromRunFn({
                outputDir: run.outputDir,
                experiment,
                round,
                index: 0,
                // OpenEvolve 每轮从官方 acquisitionValue 起点重新进化；它的
                // 代际继承发生在内部（best_program_info.parent_id），不是把 Campaign
                // 的参数候选当源码父代。parentId 明确置空，避免伪造源码血缘。
                parentId: null,
              });
              sourceItem = {
                artifact: created.artifact,
                generator: 'openevolve-llm',
                generatorMeta: {
                  sourceKind: 'openevolve-llm',
                  outputDir: run.outputDir,
                  bestProgramPath: created.provenance?.bestProgramPath ?? null,
                  functionSha256: created.provenance?.functionSha256 ?? null,
                  identicalToOfficial: evidence.evidence?.identicalToOfficial ?? null,
                  sourceParentId: evidence.evidence?.parentId ?? null,
                  seedProgram: 'program/acquisition_value.ts（官方冠军实现）',
                  realGameEvidence: evidence.evidence,
                  note: 'OpenEvolve stage2/3 真实对局与第一名率统计；Campaign 仍会独立执行安全检查与开发池评估',
                },
              };
            } catch (error) {
              rejectedAtGeneration.push({
                targetId: SOURCE_TARGET_ID,
                error: `源码候选编译/注册失败：${String(error?.message ?? error).slice(0, 500)}`,
              });
            }
          }
        } else {
          rejectedAtGeneration.push({
            targetId: SOURCE_TARGET_ID,
            error: `OpenEvolve 未产出 best program：${run?.reason ?? `status=${run?.status ?? 'unknown'}`}`,
          });
        }
      } else {
        rejectedAtGeneration.push({
          targetId: SOURCE_TARGET_ID,
          error: `OpenEvolve 不可用：${probe.blocked.join(', ')}`,
        });
      }
    } else {
      rejectedAtGeneration.push({
        targetId: SOURCE_TARGET_ID,
        error: '本 campaign 的 targetIds 不包含 acquisitionValue，跳过源码轨道',
      });
    }

    if (!sourceItem && onLlmUnavailable === 'stop') {
      const error = new Error(`LLM/SOURCE_EVOLUTION_UNAVAILABLE：${rejectedAtGeneration.map(r => r.error).join('；')}`);
      error.code = 'LLM_UNAVAILABLE';
      throw error;
    }

    if (!sourceItem && mode === 'openevolve-only') {
      const error = new Error(`OpenEvolve 源码轨道未产出候选：${rejectedAtGeneration.map(r => r.error).join('；')}`);
      error.code = 'SOURCE_CANDIDATE_MISSING';
      throw error;
    }

    const candidates = sourceItem ? [sourceItem] : [];
    const remaining = mode === 'openevolve-only' ? 0 : count - candidates.length;
    if (remaining > 0) {
      const bounded = normalizeBounded(boundedFn({
        ...options, count: remaining,
      }));
      rejectedAtGeneration.push(...bounded.rejectedAtGeneration);
      for (const item of bounded.candidates) {
        candidates.push({
          ...item,
          generator: 'deterministic-bounded-mutation',
          generatorMeta: {
            sourceKind: 'bounded-mutation',
            openevolve: meta.probe ? {
              available: meta.probe.available,
              attempted: sourceAllowed,
              fallbackReason: sourceItem ? null : (rejectedAtGeneration[0]?.error ?? null),
            } : null,
          },
        });
      }
      if (!sourceItem && candidates.length > 0) {
        meta.fallback = 'deterministic-bounded-mutation';
      }
    }

    if (mode === 'openevolve-only' && candidates.length === 0) {
      const error = new Error('OpenEvolve 模式未生成任何源码候选');
      error.code = 'SOURCE_CANDIDATE_MISSING';
      throw error;
    }

    // 生成器元数据落盘到 campaign 根目录之外由 controller 保存到 state；这里仅返回。
    return { candidates, rejectedAtGeneration, generatorMeta: meta };
  };
}

/** 把一次生成器返回的 OpenEvolve 真实对局证据写成独立 sidecar（可审计）。 */
export function writeOpenEvolveEvidence({ dir, round, generatorMeta }) {
  if (!generatorMeta?.evidence && !generatorMeta?.probe) return null;
  mkdirSync(dir, { recursive: true });
  const path = resolve(dir, `openevolve-r${String(round).padStart(3, '0')}.json`);
  const payload = {
    schema: 'century-openevolve-round-evidence-v1',
    round,
    generatedAt: new Date().toISOString(),
    generatorMode: generatorMeta.mode,
    onLlmUnavailable: generatorMeta.onLlmUnavailable,
    iterations: generatorMeta.iterations,
    probe: generatorMeta.probe,
    run: generatorMeta.run,
    bestProgram: generatorMeta.evidence,
    fallback: generatorMeta.fallback,
    discipline: 'OpenEvolve 只做离线研发；正式冠军晋级仍由预注册第一名率挑战与机器门禁决定',
  };
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`);
  return path;
}
