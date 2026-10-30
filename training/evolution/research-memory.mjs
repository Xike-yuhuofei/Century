/** P1.4：跨进程研究记忆（append-only JSONL + 检索）。
 *
 * 目标：下一代研究能回答"哪些假设已测过、哪些模块改动有正/负证据、失败出现在
 * 什么局面、哪些方向需要独立复验、哪些成果在新种子上不可复现"。
 *
 * 纪律：
 * - 被否定的假设不删除，只标记 status/rejected（保留证据链）；
 * - LLM 解释只有经过实验证据才能升级为"有证据支持"；
 * - 检索结果是研究提示，不是奖励真值，不得直接改写评估器。
 */

import { existsSync, readFileSync } from 'node:fs';
import { appendJSONL, ensureDir } from '../lib/io.mjs';
import { resolve } from 'node:path';
import { assertCondition, sha256Canonical } from './core.mjs';

export const HYPOTHESIS_STATUS = Object.freeze([
  'untested', 'supported', 'weakened', 'rejected', 'inconclusive',
]);

/**
 * 打开/创建研究记忆。
 *
 * @param {object} options
 * @param {string} options.path JSONL 路径
 */
export function openResearchMemory({ path }) {
  assertCondition(typeof path === 'string' && path.length > 0, '研究记忆需要 path');
  ensureDir(resolve(path, '..'));

  function append(entry) {
    const body = {
      at: new Date().toISOString(),
      ...entry,
    };
    const record = { ...body, entryHash: sha256Canonical(body) };
    appendJSONL(path, record);
    return record;
  }

  function readAll() {
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  }

  return {
    path,
    readAll,

    /** 记录研究假设（LLM 解释只能作为假设）。 */
    recordHypothesis({
      hypothesisId, statement, mechanisms, predictions, moduleScope = [], status = 'untested',
      rationale = null, contextHash = null,
    }) {
      assertCondition(typeof statement === 'string' && statement.length > 0, '假设缺少 statement');
      assertCondition(Array.isArray(mechanisms) && mechanisms.length >= 2,
        '研究假设必须至少给出两个可区分的机制解释');
      assertCondition(HYPOTHESIS_STATUS.includes(status), `假设状态非法：${String(status)}`);
      return append({
        kind: 'hypothesis', hypothesisId, statement, mechanisms,
        predictions: Array.isArray(predictions) ? predictions : [],
        moduleScope, status, rationale, contextHash,
      });
    },

    /** 记录实验结论（带统计证据，不含 LLM 断言）。 */
    recordExperiment({
      hypothesisId, candidateId, stage, metrics, verdict, seeds = null, notes = null, moduleScope = [],
    }) {
      assertCondition(['supported', 'weakened', 'rejected', 'inconclusive'].includes(verdict),
        `实验结论非法：${String(verdict)}`);
      return append({
        kind: 'experiment', hypothesisId, candidateId, stage, metrics, verdict, seeds, notes,
        moduleScope: Array.isArray(moduleScope) ? moduleScope : [],
      });
    },

    /** 记录失败局面（合法公开状态；用于下一代研究提示）。 */
    recordFailure({ candidateId, seatCount, phase, category, detail, status = 'inconclusive', reproducible = null }) {
      assertCondition(['supported', 'weakened', 'rejected', 'inconclusive'].includes(status),
        `失败结论非法：${String(status)}`);
      return append({
        kind: 'failure', candidateId, seatCount, phase, category, detail, status, reproducible,
      });
    },

    /** 更新假设状态（追加新状态，不覆盖历史）。 */
    updateHypothesis({ hypothesisId, status, evidenceRef = null, note = null }) {
      assertCondition(HYPOTHESIS_STATUS.includes(status), `假设状态非法：${String(status)}`);
      return append({ kind: 'hypothesis-update', hypothesisId, status, evidenceRef, note });
    },

    /** 某模块方向的历史证据摘要（供 Orchestrator 决策）。 */
    moduleEvidence(moduleId, { limit = 50 } = {}) {
      const entries = readAll().filter(e =>
        (e.kind === 'experiment' || e.kind === 'failure') && e.moduleScope?.includes?.(moduleId));
      return entries.slice(-limit);
    },

    /** 已测试过的假设（含状态），用于避免重复研究。 */
    testedHypotheses() {
      const latest = new Map();
      for (const entry of readAll()) {
        if (entry.kind === 'hypothesis') latest.set(entry.hypothesisId, { ...entry, status: entry.status });
        if (entry.kind === 'hypothesis-update') {
          const current = latest.get(entry.hypothesisId);
          if (current) latest.set(entry.hypothesisId, { ...current, status: entry.status });
        }
      }
      return [...latest.values()];
    },

    /** 有正向证据的模块改动（verdict=supported 的实验）。 */
    positiveModules() {
      const modules = new Map();
      for (const entry of readAll()) {
        if (entry.kind !== 'experiment' || entry.verdict !== 'supported') continue;
        for (const id of entry.moduleScope ?? []) {
          modules.set(id, (modules.get(id) ?? 0) + 1);
        }
      }
      return [...modules.entries()].map(([moduleId, positives]) => ({ moduleId, positives }));
    },
  };
}
