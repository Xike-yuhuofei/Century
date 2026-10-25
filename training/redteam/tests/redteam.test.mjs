/** 红队审计回归测试（training/redteam/tests）。
 *
 * 运行：node --test --test-concurrency=2 training/redteam/tests/redteam.test.mjs
 * 前置：cd web-v1 && npm run build（行为学测试需要 dist）。
 *
 * P0-2 整改：原「缺陷快照」以"漏洞存在"为通过条件——修复后必然失败，且被
 * 不当用作"修复完成"的信号。本文件已全部迁移为**正向不变量**测试（修复后
 * 应永久成立；任何回归直接红）。历史缺陷清单见 OVERNIGHT-AUDIT.md（保留作
 * 溯源记录，不再作为测试通过条件）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSimStreamSeed } from '../../lib/sim-stream.mjs';

const REPO_ROOT = resolve(resolve(dirname(fileURLToPath(import.meta.url)), '..'), '..', '..');
const DIST = resolve(REPO_ROOT, 'web-v1/dist/js');
const hasDist = (() => { try { readFileSync(resolve(DIST, 'ai.js')); return true; } catch { return false; } })();

// ---------- 正向不变量：版本身份（P0-1 修复固化；行为学） ----------
test('[不变量] 版本身份审计无 P0 发现（js0/js1/对手池=真实冻结身份）', { skip: hasDist ? false : '需要 web-v1/dist 构建产物' }, () => {
  let out;
  try {
    out = execFileSync('node', [resolve(REPO_ROOT, 'training/redteam/audit-versions.mjs'), '--probes=8', '--json'], { encoding: 'utf8' });
  } catch (error) {
    out = error.stdout; // 有 P0 时脚本按设计 exit 2，JSON 在 stdout
  }
  const j = JSON.parse(out);
  const p0 = j.findings.filter(f => f.severity === 'P0');
  assert.deepEqual(p0.map(f => f.id), [], `版本身份必须无 P0：${p0.map(f => `${f.id} ${f.title}`).join('；')}`);
  // 结构化检查输出完备（audit-gate 消费契约）
  for (const c of j.checks) {
    for (const key of ['id', 'severity', 'status', 'evidence', 'checkVersion']) {
      assert.ok(c[key] !== undefined, `check ${c.id} 缺少 ${key}`);
    }
  }
});

// ---------- 正向不变量：挑战链路独立模拟随机流（R1 修复固化） ----------
test('[不变量] simulate.mjs 适配器分派传入独立域派生的 simSeed（不暴露真实牌库种子）', { skip: hasDist ? false : '需要 web-v1/dist 构建产物' }, () => {
  const src = readFileSync(resolve(REPO_ROOT, 'training/simulator/simulate.mjs'), 'utf8');
  const dispatch = src.slice(src.indexOf("version?.adapter === 'champion-guided'"), src.indexOf('const decisionMs'));
  assert.ok(dispatch.includes('chooseJointAction'), '应定位到适配器分派调用');
  assert.ok(dispatch.includes('deriveSimStreamSeed(seed'), '适配器分派必须传入独立域派生的模拟流种子');
  assert.ok(!/simSeed:\s*seed[,\s}]/.test(dispatch), '不得把真实对局种子原样作为 simSeed（洗牌种子暴露）');
});

test('[不变量] deriveSimStreamSeed：确定性、域分离、31 位安全域、不可逆暴露', () => {
  const a = deriveSimStreamSeed(941512402);
  assert.equal(a, deriveSimStreamSeed(941512402), '同种子同盐 ⇒ 同流（CRN）');
  assert.notEqual(a, 941512402, '派生值 ≠ 原种子（不原样暴露）');
  assert.ok(a > 0 && a <= 2 ** 31 - 1, '派生值必须落在引擎安全种子域');
  assert.notEqual(a, deriveSimStreamSeed(941512402, 'other-domain'), '不同盐 ⇒ 不同流（域分离）');
  assert.notEqual(deriveSimStreamSeed(1), deriveSimStreamSeed(2), '不同对局 ⇒ 不同流（跨局独立）');
  assert.throws(() => deriveSimStreamSeed(-1), /非法/);
  assert.throws(() => deriveSimStreamSeed(1, ''), /simSalt/);
});

// ---------- 正向不变量：账本 fail-closed（L1 修复固化） ----------
test('[不变量] run-formal-challenge-js5.mjs 对缺失账本 fail-closed', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'training/tournament/run-formal-challenge-js5.mjs'), 'utf8');
  assert.ok(src.includes('fail-closed'), '账本合并必须声明 fail-closed 纪律');
  assert.ok(!src.includes('账本缺失（跳过）'), '不得静默跳过缺失账本（challenge-10 事故根因）');
  // AI7-A1：账本合并升级为统一治理层 strict 模式（缺失任一来源即抛出，
  // 并保留 fail-closed 纪律说明），不再由本脚本维护局部账本清单。
  assert.ok(/loadSeedGovernance\(\{ strict: true \}\)/.test(src), '必须经统一治理层 strict 模式加载全部账本');
  assert.ok(/fail-closed/.test(src), '缺失账本/冲突必须抛错并说明后果');
  // 运行指纹在进程启动时捕获（受试代码 = 实际加载代码）
  assert.ok(/CODE_COMMIT_AT_START\s*=\s*execFileSync\('git', \['rev-parse', 'HEAD'\]/.test(src), 'codeCommit 必须在进程启动时捕获');
  assert.ok(/ENGINE_BUNDLE_AT_START\s*=\s*engineBundleSha256\(\)/.test(src), '引擎产物指纹必须在进程启动时捕获');
  // 代码冻结校验（挑战全程指纹不漂移）
  assert.ok(/代码冻结校验失败/.test(src) && /ENGINE_BUNDLE_AT_END/.test(src), '必须含挑战全程产物指纹冻结校验');
  // 多人数协议支持（2..5 独立成次）
  assert.ok(/--seats/.test(src), '正式挑战协议必须支持按人数（--seats 2..5）独立挑战');
});

// ---------- 正向不变量：挑战协议多人数与方向分列统计（P0-5） ----------
test('[不变量] challenge.mjs 支持全部人数且主统计量按人数定义（跨人数不合并）', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'training/tournament/challenge.mjs'), 'utf8');
  assert.ok(/seatCount = 5/.test(src), 'seatCount 参数化（缺省 5 = 历史协议口径）');
  assert.ok(/MIN_SEAT_COUNT = 2/.test(src) && /MAX_SEAT_COUNT = 5/.test(src), '人数约束 2..5');
  assert.ok(/PRIMARY_METRIC/.test(src), '必须定义按人数主统计量');
  assert.ok(/firstPlaceByDirection/.test(src), '方向分列先名率（A=单席位 / B=阵营）必须披露');
  // 一次挑战一种人数：seatCount 校验必须在 runChallenge 内强制
  assert.ok(/seatCount 必须在 \$\{MIN_SEAT_COUNT\}\.\.\$\{MAX_SEAT_COUNT\}/.test(src), '人数越界必须抛错');
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
