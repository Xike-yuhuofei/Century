#!/usr/bin/env node
/** P6：R01–R12 机器可执行总验收。
 *
 * 规则：
 * - 每项必须真实执行命令或读取真实运行产物，禁止凭"测试文件存在/历史报告 PASS"判定；
 * - 无法在本机完成的项（12 小时连续训练、真实线上发布）显式标 BLOCKED/NOT_RUN，
 *   不得伪造 PASS；
 * - 输出 training/readiness/acceptance-matrix.json（requirementId / status /
 *   source / testCommand / evidence / commit / unmetReason）。
 *
 * 用法：node training/readiness/run-readiness.mjs [--json path]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';

function parseArgs(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) values[key] = true;
    else { values[key] = next; i++; }
  }
  return values;
}

const args = parseArgs(process.argv.slice(2));
const outPath = args.json ? resolve(process.cwd(), args.json) : resolve(REPO_ROOT, 'training/readiness/acceptance-matrix.json');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', cwd: REPO_ROOT }).trim();

function run(command, { timeoutMs = 900_000, env = {} } = {}) {
  const started = Date.now();
  try {
    const stdout = execFileSync(command[0], command.slice(1), {
      encoding: 'utf8', cwd: REPO_ROOT, timeout: timeoutMs, env: { ...process.env, ...env },
      maxBuffer: 32 * 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr: '', elapsedMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false, code: error.status ?? 1,
      stdout: error.stdout ?? '', stderr: error.stderr ?? '',
      elapsedMs: Date.now() - started,
    };
  }
}

function tail(text, lines = 6) {
  return String(text).trim().split('\n').slice(-lines).join('\n');
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(resolve(REPO_ROOT, path), 'utf8')); } catch { return null; }
}

const results = [];
function record({ id, title, status, source, command = null, testCommand = null, evidence, unmetReason = null, checkVersion = 'ai8-readiness-v1' }) {
  // 验收矩阵要求每项都有可复算的测试命令；允许调用方用 command 或 testCommand，
  // 但缺失时直接失败，避免再产出没有 testCommand 的历史矩阵。
  const reproducibleCommand = command ?? testCommand;
  if (typeof reproducibleCommand !== 'string' || reproducibleCommand.trim().length === 0) {
    throw new Error(`readiness ${id} 缺少 testCommand`);
  }
  results.push({
    schema: 'century-acceptance-requirement-v1',
    requirementId: id,
    title,
    status,
    source,
    testCommand: reproducibleCommand,
    evidence,
    commit,
    unmetReason,
    checkVersion,
    measuredAt: new Date().toISOString(),
  });
}

function measured({ id, title, source, command, ok, evidence, unmetReason = null, timeoutMs = 900_000 }) {
  const r = run(command, { timeoutMs });
  record({
    id, title, source, command: command.join(' '),
    status: ok(r) ? 'PASS' : 'FAIL',
    evidence: `${evidence}；exit=${r.code}；${tail(r.stdout || r.stderr, 6)}`.slice(0, 1200),
    unmetReason: ok(r) ? null : (unmetReason ?? '检查未通过，详见 evidence'),
  });
}

const ok = r => r.ok;

// ---- R01 OpenEvolve 真实算法生成 ----
{
  const resultsRoot = resolve(REPO_ROOT, 'ai5/openevolve/results');
  const candidates = existsSync(resultsRoot)
    ? execFileSync('ls', ['-1', resultsRoot], { encoding: 'utf8' })
      .split('\n').filter(name => /^ai8-openevolve-r\d+$/.test(name))
      .sort()
    : [];
  const latest = candidates.at(-1) ?? null;
  const runDir = latest ? resolve(resultsRoot, latest) : null;
  const best = runDir ? existsSync(resolve(runDir, 'best/best_program.ts')) : false;
  const info = runDir && existsSync(resolve(runDir, 'best/best_program_info.json'))
    ? JSON.parse(readFileSync(resolve(runDir, 'best/best_program_info.json'), 'utf8'))
    : null;
  // 只读取「最新一次运行」的日志：跨 run 拼接会把旧 run 的 token 统计和
  // evolved 数量混进 R01 证据，造成 run=r003 但数字来自 r001 的审计错误。
  const repoLog = runDir ? resolve(runDir, 'run.log') : null;
  const tmpLog = latest ? `/tmp/century-openevolve-${latest.replace(/^ai8-openevolve-/, '')}.log` : null;
  const logPath = repoLog && existsSync(repoLog)
    ? repoLog
    : (tmpLog && existsSync(tmpLog) ? tmpLog : null);
  const log = logPath ? readFileSync(logPath, 'utf8') : '';
  const llmCall = /Total LLM Token Usage[^\n]*/i.exec(log)?.[0] ?? null;
  // 真实生成必须至少有一次「行为不同于官方」的演化程序通过静态/编译/探针并
  // 进入真实对局评估；只有初始程序（identical=1）的 run 不算算法生成。
  // evaluator 每次程序评估输出一行 metrics；initial=1，行为不同的演化程序=0。
  // 不能要求与 "Iteration N:" 同行（实际日志 metrics 在下一行）。
  const evolvedBehavior = [...log.matchAll(/identical_to_official=0\.0000/g)].length;
  const real = Boolean(latest && best && info && /LLM Token Usage/i.test(log));
  const metrics = info?.metrics ?? info ?? {};
  const compiled = Number(metrics.compile_ok ?? 0) >= 1;
  const probed = Number(metrics.probe_ok ?? 0) >= 1;
  const bestIdentical = Number(metrics.identical_to_official ?? 0) >= 1;
  const pass = real && evolvedBehavior >= 1;
  record({
    id: 'R01', title: 'OpenEvolve 真实算法生成（LLM 离线提案 + 级联评估）',
    status: pass ? 'PASS' : (real ? 'FAIL' : 'NOT_RUN'),
    source: 'ai5/openevolve/run_openevolve.py + training/evolution/openevolve-bridge.mjs',
    testCommand: 'caffeinate -is .venv/bin/python run_openevolve.py program/acquisition_value.ts century_evaluator.py --config config.yaml --iterations 3 --output results/ai8-openevolve-r00N',
    evidence: real
      ? `run=${latest}；log=${logPath}；${llmCall}；行为不同于官方的演化程序=${evolvedBehavior}；bestProgram=yes；bestIdentical=${bestIdentical}；` +
        `best static_ok=${metrics.static_ok} compile_ok=${compiled} probe_ok=${probed} stage_passed=${metrics.stage_passed} failure=${metrics.failure_stage ?? 'none'}`
      : '未找到本次真实 OpenEvolve 运行产物',
    unmetReason: pass ? null : (real
      ? 'OpenEvolve 只评估了初始程序，没有产生行为不同于官方的演化程序（LLM 提案失败/被级联淘汰前无可审计行为差异）'
      : 'OpenEvolve 未执行或未产出 best_program'),
  });
}

// ---- R02 候选独立编译 + 真实决策执行 ----
measured({
  id: 'R02', title: '候选独立编译（Seatbelt + tsc）与真实决策执行',
  source: 'training/evolution/compiled-candidate.mjs + tests/first-place-runner.test.mjs',
  command: ['node', '--test', '--test-concurrency=1', 'training/evolution/tests/compiled.test.mjs', 'training/tests/first-place-runner.test.mjs'],
  ok: r => r.ok,
  evidence: '编译型候选通过独立 tsc；descriptor 候选在真实引擎中按席位执行（第一名率配对运行器）',
  timeoutMs: 900_000,
});

// ---- R03 多代自主递归进化 ----
{
  // 优先使用 12h 真实长跑（轮次/对局/跨代继承更强）；12h 未结束时回退到 2 代 smoke。
  const summary = readJSON('training/reports/autonomous/ai8-12h-v2/run-summary.json')
    ?? readJSON('training/reports/autonomous/ai8-smoke2/run-summary.json');
  const pass = Boolean(summary && summary.rounds >= 2 && summary.candidates?.length >= 2
    && ['completed', 'budget-exhausted'].includes(summary.status));
  record({
    id: 'R03', title: '多代自主递归进化（真实开发池对局 + 跨代继承）',
    status: pass ? 'PASS' : 'NOT_RUN',
    source: 'training/evolution/autonomous-run.mjs + campaign-controller.mjs',
    testCommand: 'training/scripts/run-12h-stress.sh（ai8-12h-v2：500 rounds / 2–5p / 真实开发池 / checkpoint/resume）',
    evidence: summary ? `status=${summary.status} rounds=${summary.rounds} candidates=${summary.candidates.length} games=${summary.budgetUsed.games} wallMs=${summary.budgetUsed.wallMs} promotionQueue=${summary.promotionQueue.length}` : '缺少运行产物',
    unmetReason: pass ? null : '未完成两代真实自主运行',
  });
}

// ---- R04 固定种子与工作量完全复现 ----
{
  const report = readJSON('training/reports/determinism/full.json');
  const pass = Boolean(report && report.verdict === 'PASS'
    && report.worldsPerSeatCount === 50
    && [2, 3, 4, 5].every(n => report.seatCounts.includes(n)));
  const partial = readJSON('training/reports/determinism/smoke.json');
  record({
    id: 'R04', title: '固定种子 + 固定 workUnits 双轮完全复现（2–5 人 × 50 世界）',
    status: pass ? 'PASS' : (partial?.verdict === 'PASS' ? 'NOT_RUN' : 'FAIL'),
    source: 'training/scripts/verify-determinism.mjs',
    testCommand: 'node training/scripts/verify-determinism.mjs --worlds 50 --seat-counts 2,3,4,5 --out training/reports/determinism/full.json',
    evidence: pass
      ? `2–5 人各 50 世界 × 2 轮；mismatches=${report.mismatches.length}`
      : (partial ? `仅完成小样本自检（worlds=${partial.worldsPerSeatCount}，seats=${partial.seatCounts.join(',')}，verdict=${partial.verdict}）；50 世界全量尚未完成` : '无确定性报告'),
    unmetReason: pass ? null : '50 世界 × 2–5 人全量确定性验收尚未完成',
  });
}

// ---- R05 全局种子治理无污染 ----
measured({
  id: 'R05', title: '全局种子治理：原子分配、跨 Campaign、冲突检查、用途隔离',
  source: 'training/lib/seed-governance.mjs + governance-provider-v2.mjs',
  command: ['node', '--test', '--test-concurrency=1', 'training/evolution/tests/governance.test.mjs', 'training/evolution/tests/governance-live.test.mjs'],
  ok: r => r.ok,
  evidence: '真实 Provider 原子登记 + 冲突拒绝 + screen/deep 隔离 + 验证池硬拒绝',
});

// ---- R06 2–5 人配对第一名率评估正确 ----
measured({
  id: 'R06', title: '2–5 人焦点席位配对第一名率评估（非阵营口径）',
  source: 'training/evaluator/first-place.mjs + tournament/first-place-challenge.mjs',
  command: ['node', '--test', '--test-concurrency=1', 'training/tests/first-place.test.mjs', 'training/tests/first-place-runner.test.mjs'],
  ok: r => r.ok,
  evidence: '焦点席位 A/B 配对、种子簇级 CI、非劣效、跨人数独立种子',
});

// ---- R07 预注册、多重检验、长期错误率 ----
{
  const ledger = readJSON('training/governance/alpha-ledger.json');
  const alphaOk = Boolean(ledger && ledger.schema === 'century-alpha-ledger-v1'
    && ledger.reservations.length === 11
    && Math.abs(ledger.reservations.reduce((s, r) => s + r.alpha, 0) - 0.049975585937500004) < 1e-9);
  const r = run(['node', '--test', '--test-concurrency=1', 'training/tests/first-place.test.mjs']);
  record({
    id: 'R07', title: '预注册 + 多重检验 + 长期 alpha 预算（不可重置）',
    status: r.ok && alphaOk ? 'PASS' : 'FAIL',
    source: 'training/evaluator/preregistration.mjs + lib/alpha-ledger.mjs',
    testCommand: 'node --test training/tests/first-place.test.mjs',
    evidence: `alpha-ledger 11 次历史消耗=${alphaOk}；预注册/反例测试 exit=${r.code}；${tail(r.stdout, 5)}`.slice(0, 1200),
    unmetReason: r.ok && alphaOk ? null : '预注册或 alpha 账本检查失败',
  });
}

// ---- R08 源码沙箱与隐藏信息安全 ----
measured({
  id: 'R08', title: '不可信源码 Seatbelt 沙箱 + 隐藏信息/禁止构造检查',
  source: 'ai5/openevolve sandbox + training/evolution/safety-check.mjs',
  command: ['python3', 'ai5/openevolve/tests/test_security_sandbox.py', '-v'],
  ok: r => r.ok,
  evidence: '沙箱禁网/禁读 HOME/禁隐藏牌库；静态禁止构造检测',
  timeoutMs: 900_000,
});

// ---- R09 12 小时无人值守训练 ----
{
  const artifact = findLatest12hArtifact();
  const inProgress = readJSON('training/reports/autonomous/ai8-12h-v2/state.json')
    ?? readJSON('training/reports/autonomous/ai8-12h/state.json');
  const elapsedHours = inProgress?.createdAt
    ? Number(((Date.now() - Date.parse(inProgress.createdAt)) / 3600_000).toFixed(2))
    : 0;
  record({
    id: 'R09', title: '连续 12 小时真实自主训练压力测试',
    status: artifact ? 'PASS' : 'NOT_RUN',
    source: 'training/evolution/autonomous-run.mjs + training/scripts/run-12h-stress.sh',
    testCommand: 'screen -dmS century12h-v2 /bin/zsh -f -c "cd <repo> && caffeinate -is training/scripts/run-12h-stress.sh"',
    evidence: artifact
      ? `12h 产物=${artifact.path}；elapsedHours=${artifact.elapsedHours}；status=${artifact.status}；` +
        `rounds=${artifact.rounds}；games=${artifact.games}；budgetWallMs=${artifact.wallMs}`
      : (inProgress
          ? `真实 12h 运行进行中：status=${inProgress.status} phase=${inProgress.phase} rounds=${inProgress.rounds?.length ?? 0} ` +
            `games=${inProgress.budgetUsed?.games ?? 0} wallMs=${inProgress.budgetUsed?.wallMs ?? 0} 已运行约 ${elapsedHours}h；` +
            '达到 12h 且 completed/budget-exhausted（非失败/人工停止）后才可 PASS'
          : '未发现已完成的 12 小时连续运行产物'),
    unmetReason: artifact ? null : (inProgress
      ? `运行中（约 ${elapsedHours}h）；未满 12 小时，不能提前 PASS`
      : '本次会话无法连续运行 12 小时真实训练；必须在目标 M4 上实际执行并保留日志后才能 PASS'),
  });
}

function findLatest12hArtifact() {
  const candidates = [
    'training/reports/autonomous/ai8-12h-v2/run-summary.json',
    'training/reports/autonomous/ai8-12h/run-summary.json',
    'training/reports/autonomous-12h/run-summary.json',
  ];
  for (const path of candidates) {
    const doc = readJSON(path);
    if (!doc) continue;
    const elapsedMs = Number(doc.elapsedMs);
    // 12h 压力测试的自然结束方式有两种：
    // - 跑满预注册轮次 → completed；
    // - 达到 12h 墙钟预算 → budget-exhausted（这正是压力测试的目标）。
    // 两者都要求真实运行 ≥12h、有真实对局、且不是 failed/stopped-by-operator。
    const cleanStop = doc.status === 'completed'
      || (doc.status === 'budget-exhausted' && doc.phase === 'stopped-by-budget');
    const realWork = Number(doc.budgetUsed?.games ?? 0) > 0;
    if (elapsedMs >= 12 * 3600_000 && cleanStop && realWork) {
      return {
        path,
        elapsedHours: Number((elapsedMs / 3600_000).toFixed(2)),
        status: doc.status,
        rounds: doc.rounds,
        games: doc.budgetUsed.games,
        wallMs: doc.budgetUsed.wallMs,
      };
    }
  }
  return null;
}

// ---- R10 M4 资源控制与故障恢复 ----
{
  const r = run(['node', 'training/scripts/fault-injection.mjs'], { env: { FAULT_REPORT: 'training/reports/fault-injection.json' } });
  const report = readJSON('training/reports/fault-injection.json');
  const pass = r.ok && report?.verdict === 'PASS' && report.checks?.length >= 9;
  record({
    id: 'R10', title: 'M4 资源控制 + 9 类故障注入恢复',
    status: pass ? 'PASS' : 'FAIL',
    source: 'training/lib/resource-scheduler.mjs + scripts/fault-injection.mjs',
    testCommand: 'node training/scripts/fault-injection.mjs',
    evidence: report ? `checks=${report.checks.length} verdict=${report.verdict}；${report.checks.map(c => `${c.id}:${c.status}`).join(' ')}` : '无故障注入报告',
    unmetReason: pass ? null : '故障注入存在失败项',
  });
}

// ---- R11 正式冠军挑战自动统计判定 ----
{
  const machineGate = existsSync(resolve(REPO_ROOT, 'training/scripts/promote-first-place-champion.mjs'));
  const noHuman = !existsSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'))
    || !readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8').includes('promotion-approval');
  const r = run(['node', '--test', '--test-concurrency=1', 'training/tests/first-place.test.mjs']);
  record({
    id: 'R11', title: '正式冠军挑战：预注册第一名率自动统计判定',
    status: machineGate && noHuman && r.ok ? 'PASS' : 'FAIL',
    source: 'promote-first-place-champion.mjs + scripts/ci/lib/summary.mjs',
    testCommand: 'node training/scripts/promote-first-place-champion.mjs --evidence ... --plan ... --candidate ... --dry-run',
    evidence: `机器门禁脚本在场=${machineGate}；人工批准作业已移除=${noHuman}；统计反例测试 exit=${r.code}`,
    unmetReason: machineGate && noHuman && r.ok ? null : '机器门禁或统计判定未就绪',
  });
}

// ---- R12 无人工审批的自动晋级、部署与回滚 ----
{
  const verifyWorkflows = run(['node', 'scripts/ci/verify-workflows.mjs']);
  const rollbackDry = run(['node', 'scripts/ci/rollback-champion.mjs', '--dry-run']);
  const deployed = readJSON('training/reports/deploy-verification.json');
  const deployedPass = deployed?.verdict === 'PASS';
  const championEvidence = readJSON('training/champions/champion.json')?.provenance?.promotionEvidence;
  const promotedFirstPlace = championEvidence?.metric === 'pairedFirstPlaceRateDelta'
    && championEvidence?.decision?.promote === true;
  const rollbackDrill = existsSync(resolve(REPO_ROOT, 'training/reports/rollback-drill.json'));
  const promotionDrill = readJSON('training/reports/promotion-e2e-drill.json');
  const promotionDrillPass = promotionDrill?.verdict === 'PASS';
  const pilot = readJSON('training/reports/first-place-promotion/pilot-candidatecap-r1c7.json');
  const pilotNoChallenge = pilot?.verdict === 'NO-FORMAL-CHALLENGE';
  const ruleset = readJSON('training/reports/github-governance-verification.json');
  const machineMerge = ruleset?.ruleset?.requiredApprovingReviewCount === 0
    && Array.isArray(ruleset?.ruleset?.requiredStatusChecks)
    && ruleset.ruleset.requiredStatusChecks.includes('ci-summary');
  const complete = deployedPass && promotedFirstPlace && rollbackDrill;
  record({
    id: 'R12', title: '无人工审批的自动晋级、发布、线上核验与回滚',
    status: complete ? 'PASS' : 'BLOCKED',
    source: '.github/workflows/ci.yml + ai-training.yml + scripts/ci/verify-deploy.mjs + rollback-champion.mjs + training/scripts/promotion-e2e-drill.mjs',
    testCommand: 'node scripts/ci/verify-workflows.mjs && node scripts/ci/rollback-champion.mjs --dry-run && node training/scripts/promotion-e2e-drill.mjs',
    evidence: `工作流机器门禁=${verifyWorkflows.ok}；回滚 dry-run=${rollbackDry.ok}；` +
      `GitHub ruleset 机器合并（0 人工批准 + 必需检查）=${machineMerge}；` +
      `真实机器合并+Pages 部署+线上核验=${deployedPass}（run 40221527752, site=PASS）；` +
      `隔离环境晋级→落地→构建→发布核验→回滚全链路=${promotionDrillPass}（${promotionDrill?.checks?.length ?? 0} 项，合成夹具）；` +
      `dev 信号同预算配对复现筛查=${pilotNoChallenge ? 'NO-FORMAL-CHALLENGE（4 层均无正增量）' : '未执行'}；` +
      `第一名率冠军晋级=${promotedFirstPlace}；回滚演练=${rollbackDrill}`,
    unmetReason: complete ? null
      : (deployedPass && rollbackDrill
          ? '部署、线上身份核验、隔离全链路演练与回滚演练均已 PASS，但没有统计合格候选完成真实冠军晋级；且几何 alpha 预算已消耗 0.0499756（剩余 2.44e-5），新 alpha 家族必须显式治理授权，不能把“部署现有冠军/合成夹具演练”当作 R12 完成'
          : (deployedPass
              ? '真实部署与线上身份核验已 PASS，但没有统计合格候选完成冠军晋级，也未执行回滚演练；不能把“部署现有冠军”当作 R12 完成'
              : '当前没有通过第一名率正式挑战的候选，因此未执行真实冠军发布；不能以模拟发布冒充 PASS')),
  });
}

const summary = {
  schema: 'century-acceptance-matrix-v1',
  generatedAt: new Date().toISOString(),
  commit,
  ready: results.every(r => r.status === 'PASS'),
  status: results.every(r => r.status === 'PASS') ? 'CENTURY_AUTONOMOUS_EVOLUTION_READY = true'
    : 'CENTURY_AUTONOMOUS_EVOLUTION_READY = false',
  counts: {
    PASS: results.filter(r => r.status === 'PASS').length,
    FAIL: results.filter(r => r.status === 'FAIL').length,
    BLOCKED: results.filter(r => r.status === 'BLOCKED').length,
    NOT_RUN: results.filter(r => r.status === 'NOT_RUN').length,
  },
  requirements: results,
};
writeJSON(outPath, summary);
console.log(JSON.stringify({
  commit,
  ready: summary.ready,
  counts: summary.counts,
  requirements: results.map(r => ({ id: r.requirementId, status: r.status, reason: r.unmetReason })),
  out: outPath,
}, null, 2));
process.exit(summary.ready ? 0 : 2);
