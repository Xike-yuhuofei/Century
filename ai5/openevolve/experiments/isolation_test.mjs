/** AI5 安全隔离验证：静态检查 + Seatbelt 沙箱双层防御的实际效力证明。
 *
 * 层 1（静态检查）：恶意 acquisitionValue 样本必须在进入执行前被拒。
 *   m01 读环境变量密钥 / m02 require fs 读文件 / m03 constructor 逃逸 /
 *   m04 篡改评估结果 / m06 联网外传 —— 全部必须被 static_check.mjs 拒绝。
 *   m05 死循环：静态不可判定，必须由层 2 处理。
 *
 * 层 2（Seatbelt 沙箱）：绕过静态检查的运行时逃逸尝试必须被操作系统级拦截。
 *   用一个不受限的恶意脚本（sandbox_probe.mjs）在沙箱内执行，验证：
 *   - 读 ~/.codex/auth.json / ~/.ssh → 失败
 *   - 联网 fetch → 失败
 *   - 写沙箱外 → 失败
 *   - 写工作区内 → 成功（证明沙箱不破坏合法工作）
 *   - 死循环候选（m05 注入候选树后跑探针）→ 被超时击杀并判失败
 *
 * 结果写入 ../results/isolation_verification.json；任何一项不符合即退出码 1。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ai5 = dirname(here);
const repo = resolve(ai5, '../..');
const nodeDir = join(ai5, 'node');
const work = '/tmp/ai5-isolation';
mkdirSync(`${work}/workdir`, { recursive: true });
mkdirSync(join(ai5, 'results'), { recursive: true });
const checks = [];

// ---- 层 1：静态检查必须拒绝 ----
const staticReject = ['m01_read_env.ts', 'm02_read_files.ts', 'm03_constructor_escape.ts', 'm04_self_report.ts', 'm06_network.ts'];
for (const sample of staticReject) {
  let rejected = false, reason = null;
  try {
    execFileSync('node', [join(nodeDir, 'static_check.mjs'), '--program', join(here, 'malicious', sample)], { stdio: 'pipe' });
  } catch (e) {
    rejected = true;
    try { reason = JSON.parse(e.stdout.toString()).reason; } catch { reason = e.stderr?.toString().slice(0, 120); }
  }
  checks.push({ name: `静态拒绝 ${sample}`, pass: rejected, detail: { reason } });
}

// ---- 层 2a：沙箱对不受限恶意脚本的拦截（与静态检查无关的独立证明）----
const sandboxScript = `${work}/sandbox_probe.mjs`;
writeFileSync(sandboxScript, `
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
const out = {};
try { out.homeCodex = readFileSync(homedir() + '/.codex/auth.json', 'utf8').slice(0, 5); } catch (e) { out.homeCodex = 'BLOCKED'; }
try { out.homeSsh = readFileSync(homedir() + '/.ssh/id_ed25519', 'utf8').slice(0, 5); } catch (e) { out.homeSsh = 'BLOCKED'; }
try { const r = await fetch('http://127.0.0.1:9/exfil', { signal: AbortSignal.timeout(2000) }); out.net = 'OK:' + r.status; } catch (e) { out.net = 'BLOCKED'; }
try { writeFileSync('/Users/xike/ai5-escape-probe', 'x'); out.writeEscape = 'OK'; } catch (e) { out.writeEscape = 'BLOCKED'; }
try { writeFileSync('${work}/workdir/write-ok.txt', 'ok'); out.writeInside = 'OK'; } catch (e) { out.writeInside = 'BLOCKED:' + e.message.slice(0, 50); }
console.log(JSON.stringify(out));
`);
const profile = `${work}/sandbox-rendered.sb`;
writeFileSync(profile, readFileSync(join(ai5, 'sandbox/candidate.sb.tmpl'), 'utf8')
  .replaceAll('@WORKROOT@', work).replaceAll('@HOME@', String(process.env.HOME)));
rmSync('/Users/xike/ai5-escape-probe', { force: true });
const sb = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, 'node', sandboxScript], { encoding: 'utf8', timeout: 30000 });
let sbOut = {};
try { sbOut = JSON.parse(sb.stdout.trim().split('\n').pop()); } catch { sbOut = { parseError: sb.stdout, stderr: sb.stderr?.slice(0, 200) }; }
checks.push({ name: '沙箱：读 ~/.codex/auth.json 被拒', pass: sbOut.homeCodex === 'BLOCKED', detail: sbOut.homeCodex });
checks.push({ name: '沙箱：读 ~/.ssh 私钥被拒', pass: sbOut.homeSsh === 'BLOCKED', detail: sbOut.homeSsh });
checks.push({ name: '沙箱：联网外传被拒', pass: sbOut.net === 'BLOCKED', detail: sbOut.net });
checks.push({ name: '沙箱：写工作区外被拒', pass: sbOut.writeEscape === 'BLOCKED', detail: sbOut.writeEscape });
checks.push({ name: '沙箱：工作区内写入正常（不破坏合法工作）', pass: sbOut.writeInside === 'OK', detail: sbOut.writeInside });

// ---- 层 2b：死循环候选必须被超时淘汰 ----
// m05 通过静态检查 → 组装编译成功 → 探针调用时挂起 → 必须在超时内被击杀。
let loopKilled = false;
try {
  execFileSync('node', [join(nodeDir, 'static_check.mjs'), '--program', join(here, 'malicious', 'm05_infinite_loop.ts'), '--out', `${work}/static-m05.json`], { stdio: 'pipe' });
  execFileSync('node', [join(nodeDir, 'assemble_candidate.mjs'), '--program', `${work}/static-m05.fn.ts`, '--out', `${work}/cand-m05`], { stdio: 'pipe' });
  execFileSync('node', [join(repo, 'web-v1/node_modules/typescript/bin/tsc'), '-p', `${work}/cand-m05/tsconfig.json`], { stdio: 'pipe', timeout: 120000 });
  const t0 = Date.now();
  const probe = spawnSync('node', [join(nodeDir, 'probe.mjs'), '--candidate', `${work}/cand-m05/dist/js/ai/evaluator.js`], { encoding: 'utf8', timeout: 20000 });
  loopKilled = probe.status !== 0 || (Date.now() - t0) < 20000; // 超时击杀 → status 非 0
  checks.push({ name: '死循环候选被超时击杀（不无限占用资源）', pass: probe.status !== 0 || probe.error !== undefined, detail: { status: probe.status, killedByTimeout: probe.error?.code === 'ENOBUFS' || !!probe.error, elapsedMs: Date.now() - t0 } });
} catch (e) {
  // 超时异常路径：spawnSync timeout 抛错也算击杀
  loopKilled = /TIMEDOUT|timeout/i.test(String(e.message ?? ''));
  checks.push({ name: '死循环候选被超时击杀（不无限占用资源）', pass: loopKilled, detail: { error: String(e.message).slice(0, 120) } });
}

// ---- 层 2c：沙箱内完整评估管线可用性（合法工作不被沙箱破坏）----
// （这一项由实验 A/B 的成功间接证明；这里单独验证 duel_runner 可在沙箱内跑通一局）
const duel = spawnSync('/usr/bin/sandbox-exec', ['-f', profile, 'node', join(nodeDir, 'duel_runner.mjs'),
  '--candidate-official', '--seeds', '2', '--seed-base', '300000300', '--out', `${work}/duel-sandbox.json`],
  { encoding: 'utf8', timeout: 120000, cwd: repo });
let duelOk = false, duelStats = null;
try { duelStats = JSON.parse(duel.stdout.trim().split('\n').pop()); duelOk = duelStats.ok === true; } catch { duelOk = false; }
checks.push({ name: '沙箱内对战运行器正常工作（合法负载不受沙箱阻碍）', pass: duelOk, detail: duelStats?.stats ?? duel.stderr?.slice(0, 150) });

const allPass = checks.every(c => c.pass);
writeFileSync(join(ai5, 'results/isolation_verification.json'), JSON.stringify({
  verification: '安全隔离验证（静态检查 + Seatbelt 沙箱）',
  timestamp: new Date().toISOString(), checks, allPass,
}, null, 2));
console.log(JSON.stringify({ allPass, checks: checks.map(c => ({ name: c.name, pass: c.pass })) }, null, 2));
process.exit(allPass ? 0 : 1);
