/** 红队审计回归测试（training/redteam/tests）。
 *
 * 运行：node --test --test-concurrency=2 training/redteam/tests/redteam.test.mjs
 * 前置：cd web-v1 && npm run build（行为学测试需要 dist）。
 *
 * 测试分两类：
 * 1. 【缺陷快照】锁定 2026-10-24 夜审发现的缺陷现状——当前应当通过；
 *    修复后相应断言会失败，提示同步更新 OVERNIGHT-AUDIT.md 的缺陷清单。
 * 2. 【期望不变量（todo）】修复后应成立的行为学断言，修复时把 todo 改回 test。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..', '..');
const DIST = resolve(REPO_ROOT, 'web-v1/dist/js');
const hasDist = (() => { try { readFileSync(resolve(DIST, 'ai.js')); return true; } catch { return false; } })();

// ---------- 缺陷快照：版本身份污染（P0-1） ----------
test('[缺陷快照 P0-1] js0/js1/对手池变体在晋级产物上实际执行 JS5 适配器', { skip: hasDist ? false : '需要 web-v1/dist 构建产物' }, () => {
  let out;
  try {
    out = execFileSync('node', [resolve(REPO_ROOT, 'training/redteam/audit-versions.mjs'), '--probes=8', '--json'], { encoding: 'utf8' });
  } catch (error) {
    out = error.stdout; // POLLUTED 时脚本按设计 exit 2，JSON 在 stdout
  }
  const j = JSON.parse(out);
  const byId = Object.fromEntries(j.findings.map(f => [f.id, f]));
  // V2：js0 标签 → JS5 适配器（8 探针全走适配器）
  assert.equal(byId.V2.severity, 'P0', 'js0 标签应处于污染状态（V2）');
  assert.match(byId.V2.detail, /8\/8 探针决策走适配器路径/);
  // V3：js1 标签 → JS5 适配器
  assert.equal(byId.V3.severity, 'P0', 'js1 标签应处于污染状态（V3）');
  // V4：对手池风格变体 → JS5 本体
  assert.equal(byId.V4.severity, 'P0', '对手池变体应处于标签化状态（V4）');
  // V7b：晋级证据指纹 ≠ 当前产物
  assert.equal(byId.V7a?.severity ?? byId.V7b.severity, 'P0', '晋级指纹应与当前产物不一致（V7）');
});

// ---------- 期望不变量：修复后应成立（现为 todo） ----------
test('[期望不变量] js0 标签行为 ≡ 归档冻结冠军（修复 V2 后转正）', { todo: '等 apply-champion/decision 分派修复后把 todo 改回 test' }, () => {});

test('[期望不变量] 挑战链路传入 simSeed（修复 R1 后转正）', { todo: 'simulate.mjs 应向 chooseJointAction 传 simSeed=对局种子' }, () => {});

test('[期望不变量] run-formal-challenge 账本缺失应 fail-closed（修复 L1 后转正）', { todo: '缺失账本应抛错而非跳过' }, () => {});

// ---------- 缺陷快照：随机性隔离（P1-R1） ----------
test('[缺陷快照 P1-R1] simulate.mjs 挑战链路未传 simSeed（联合模拟流全局面共用 0）', { skip: hasDist ? false : '需要 web-v1/dist 构建产物' }, () => {
  const src = readFileSync(resolve(REPO_ROOT, 'training/simulator/simulate.mjs'), 'utf8');
  const dispatch = src.slice(src.indexOf("version?.adapter === 'champion-guided'"), src.indexOf('const decisionMs'));
  assert.ok(dispatch.includes('chooseJointAction'), '应定位到适配器分派调用');
  assert.ok(!dispatch.includes('simSeed'), 'simulate.mjs 的 chooseJointAction 调用不应缺失 simSeed（当前缺失=缺陷仍在）');
  const adapter = readFileSync(resolve(DIST, 'js/adapter.js'), 'utf8');
  assert.match(adapter, /simSeed:\s*options\.simSeed\s*\?\?\s*0/, 'adapter.ts 缺省 simSeed=0（duel.mjs 已修复传 seed，simulate.mjs 未传）');
});

// ---------- 缺陷快照：账本 fail-open（P1-L1） ----------
test('[缺陷快照 P1-L1] run-formal-challenge-js5.mjs 对缺失账本静默跳过（challenge-10 事故根因仍在）', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'training/tournament/run-formal-challenge-js5.mjs'), 'utf8');
  assert.ok(src.includes("existsSync(p)) { console.error(`账本缺失（跳过）：${rel}`); continue; }"),
    '缺失账本应改为抛错（fail-closed）；当前静默跳过=缺陷仍在');
});

// ---------- 数据完整性：证据核算（P0-2/P0-3 附属） ----------
test('[证据完整性] confirm 块总局数 = 12,800（PR #29 的 25,600 为双计）', () => {
  const out = execFileSync('node', [resolve(REPO_ROOT, 'training/redteam/audit-evidence-accounting.mjs')], { encoding: 'utf8' });
  assert.match(out, /落盘 confirm 数据实为 12800 局/);
  assert.match(out, /配对 188W\/60L\/2T/, 'challenge-11 复算应与记录一致');
  assert.match(out, /独立判定 promote/, '晋级判定应可独立复现');
  assert.match(out, /两两无重叠/, '验证种子账本去重后应无重叠');
});

// ---------- 双人 A/B 统计与官方工具交叉一致 ----------
test('[统计交叉核对] 2p 方向A 点估计与 compare.mjs 完全一致', () => {
  const out = execFileSync('node', [resolve(REPO_ROOT, 'training/redteam/stats-two-player.mjs'), '--json'], { encoding: 'utf8' });
  const j = JSON.parse(out);
  assert.equal(j.crossCheck.agreePoint, true, '审计侧与官方工具点估计应逐位一致');
  assert.equal(j.crossCheck.agreeCIOrder, true, '审计侧与官方工具 CI 应区间重叠');
  const js5Classic = j.results[0];
  assert.equal(js5Classic.A.diff, 0.08, 'js5 vs js0 classic 2p 方向A = +8.0pp');
  assert.equal(js5Classic.merged.exploratory, true, 'A+B 合并必须标记探索性');
});
