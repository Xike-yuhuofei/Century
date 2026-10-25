/** 历史算法版本锁（AI7 任务 A2：历史冠军身份不可变）。
 *
 * 背景（01 审计 P1-3）：JS5 冻结描述符名义上来自晋级归档，但其束搜索基座 /
 * 根筛选 / 溢出弃置仍读取活动 CHAMPION_PARAMETERS；归档参数与决策核心源码
 * 任何一方被后续改动，历史版本对照都会静默漂移。
 *
 * 本锁把「历史算法版本」的字节级身份固定为：
 * - 晋级归档参数文件 sha256（ai5-readiness-efficiency / joint-js5 / struct-beam-rollout）；
 * - 决策核心源码 sha256（champion-guided / adapter / config / parameters / planner / evaluator）。
 *
 * 任何字段变化都必须显式更新锁文件（经 PR 审核），否则：
 * - training/lib/version-registry.mjs 解析冻结版本时 fail-closed；
 * - audit-gate dev 层 version-lock 检查失败；
 * - 回归测试失败。
 *
 * 这不是"禁止修改代码"，而是禁止**静默**改变历史版本的语义身份。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

export const VERSION_LOCK_SCHEMA = 'century-algorithm-version-lock-v1';
export const VERSION_LOCK_PATH = 'training/champions/version-lock.json';

/** 锁覆盖的文件（相对 repo root）。新增历史版本/决策核心必须同步扩展。 */
export const LOCKED_FILES = Object.freeze({
  archives: [
    'training/champions/candidates/ai5-readiness-efficiency.json',
    'training/champions/candidates/joint-js5.json',
    'training/champions/candidates/struct-beam-rollout.json',
  ],
  decisionSources: [
    'web-v1/src/ai/decision.ts',
    'web-v1/src/js/champion-guided.ts',
    'web-v1/src/js/adapter.ts',
    'web-v1/src/js/config.ts',
    'web-v1/src/js/joint-rollout.ts',
    'web-v1/src/js/rollout-policy.ts',
    'web-v1/src/js/near-terminal.ts',
    'web-v1/src/js/budget.ts',
    'web-v1/src/js/simview.ts',
    'web-v1/src/js/types.ts',
    'web-v1/src/ai/version-registry.ts',
    'web-v1/src/ai/parameters.ts',
    'web-v1/src/ai/planner.ts',
    'web-v1/src/ai/evaluator.ts',
  ],
});

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** 计算当前锁内容（--write 与 verify 共用）。 */
export function computeVersionLock({ root = REPO_ROOT } = {}) {
  const entries = (files) => Object.fromEntries(files.map(rel => {
    const abs = resolve(root, rel);
    if (!existsSync(abs)) throw new Error(`版本锁覆盖文件缺失：${rel}`);
    return [rel, sha256File(abs)];
  }));
  return {
    schema: VERSION_LOCK_SCHEMA,
    algorithm: 'sha256(file bytes)',
    createdAt: new Date().toISOString(),
    archives: entries(LOCKED_FILES.archives),
    decisionSources: entries(LOCKED_FILES.decisionSources),
  };
}

/** 校验锁文件；返回 {ok, errors, lock, expected}，不抛错（调用方决定阻断方式）。 */
export function verifyVersionLock({ root = REPO_ROOT, lockPath = VERSION_LOCK_PATH } = {}) {
  const absoluteLock = resolve(root, lockPath);
  const errors = [];
  if (!existsSync(absoluteLock)) {
    return { ok: false, errors: [`版本锁缺失：${absoluteLock}`], lock: null, expected: null };
  }
  let lock;
  try {
    lock = JSON.parse(readFileSync(absoluteLock, 'utf8'));
  } catch (error) {
    return { ok: false, errors: [`版本锁不是合法 JSON：${error.message}`], lock: null, expected: null };
  }
  if (lock.schema !== VERSION_LOCK_SCHEMA) errors.push(`版本锁 schema 不识别：${lock.schema}`);
  let expected;
  try {
    expected = computeVersionLock({ root });
  } catch (error) {
    return { ok: false, errors: [...errors, error.message], lock, expected: null };
  }
  for (const group of ['archives', 'decisionSources']) {
    const recorded = lock[group] ?? {};
    for (const [rel, hash] of Object.entries(expected[group])) {
      if (!recorded[rel]) errors.push(`版本锁缺少 ${group} 条目：${rel}`);
      else if (recorded[rel] !== hash) {
        errors.push(`${group} 文件已变更：${rel}（锁 ${recorded[rel].slice(0, 12)} ≠ 当前 ${hash.slice(0, 12)}）`);
      }
    }
    for (const rel of Object.keys(recorded)) {
      if (!(rel in expected[group])) errors.push(`版本锁含未知 ${group} 条目：${rel}`);
    }
  }
  return { ok: errors.length === 0, errors, lock, expected };
}

/** 写入/更新版本锁（仅显式调用；更新必须随 PR 说明原因）。 */
export function writeVersionLock({ root = REPO_ROOT, lockPath = VERSION_LOCK_PATH, note = null } = {}) {
  const lock = computeVersionLock({ root });
  if (note) lock.note = String(note);
  const absolute = resolve(root, lockPath);
  writeFileSync(absolute, JSON.stringify(lock, null, 2) + '\n');
  return { absolute, lock };
}

/** 冻结版本解析前的强制校验（fail-closed）。 */
export function assertVersionLockIntact({ root = REPO_ROOT } = {}) {
  const result = verifyVersionLock({ root });
  if (!result.ok) {
    throw new Error(
      '历史算法版本锁校验失败（AI7-A2，fail-closed）：\n- ' + result.errors.join('\n- ') +
      '\n历史冠军/冻结版本身份不得静默漂移；如属有意变更，必须显式更新 version-lock.json 并经 PR 审核。',
    );
  }
  return result.lock;
}
