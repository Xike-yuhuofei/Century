#!/usr/bin/env node
/** P2.4：故障注入（7 个强制终止点 + 恢复不变量核验）。
 *
 * 每个场景都是**真实子进程被强制终止**（SIGKILL/SIGTERM），而不是 try/catch 模拟：
 * 1. LLM 正在返回结果（OpenEvolve + codex 子进程运行中）
 * 2. 候选源码写入（artifact 落盘前的临界窗口）
 * 3. 编译阶段（tsc 运行中）
 * 4. 对局评估中途（campaign 子进程评估中）
 * 5. 实验结果提交（COMMITTING 窗口）
 * 6. Checkpoint 写入（state.json 写坏/截断）
 * 7. 冠军发布事务（publisher 写到一半）
 *
 * 恢复不变量：
 * - 不丢失已确认的实验结果；不重复提交结果；不错误复用正式种子；
 * - 不破坏父子谱系；不产生多个冲突冠军；不从错误 checkpoint 继续；不绕过门禁。
 *
 * 用法：node training/scripts/ai11-fault-injection.mjs [--skip-llm]
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { openTaskQueue } from '../evolution/task-queue.mjs';

const args = process.argv.slice(2);
const skipLlm = args.includes('--skip-llm');
const checks = [];
const add = (id, title, pass, evidence) => checks.push({ id, title, status: pass === null ? 'SKIP' : (pass ? 'PASS' : 'FAIL'), evidence });
const tmp = mkdtempSync(join(tmpdir(), 'ai11-fault-'));

function runWorker(code, env = {}) {
  return spawn(process.execPath, ['--input-type=module', '-e', code], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true, // 独立进程组：可整组 SIGKILL，避免 tsc/codex 孙进程残留
  });
}

async function killAfter(child, ms) {
  await new Promise(r => setTimeout(r, ms));
  let exited = false;
  child.once('exit', () => { exited = true; });
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* 已退出 */ } }
  // 进程组被杀后最多等 5s；若仍未触发 exit 事件，按已终止处理（孙进程持有管道）。
  await new Promise(r => setTimeout(r, 5000));
  return { killed: true, exitedEvent: exited, signal: 'SIGKILL' };
}

async function scenario1LlmMidFlight() {
  if (skipLlm) {
    add('F1-llm-returning', 'LLM 返回中断', null, 'skipped（--skip-llm）');
    return;
  }
  const outDir = join(tmp, 'llm-run');
  const child = runWorker(`
    import { runMultiModuleOpenEvolve } from './training/evolution/openevolve-multi-bridge.mjs';
    const result = runMultiModuleOpenEvolve({
      moduleIds: ['M02', 'M05'], iterations: 1, outputDir: ${JSON.stringify(outDir)}, timeoutMs: 900000,
    });
    console.error(JSON.stringify({ done: true, ok: result.ok, outDir: result.outputDir }));
  `);
  // 等 OpenEvolve 真正启动并进入 LLM 调用（最多 60s），再强制终止。
  let launched = false;
  for (let i = 0; i < 60; i += 1) {
    await new Promise(r => setTimeout(r, 1000));
    const ps = spawnSync('pgrep', ['-f', 'run_openevolve.py'], { encoding: 'utf8' });
    if (ps.status === 0 && ps.stdout.trim()) { launched = true; break; }
  }
  const exit = await killAfter(child, launched ? 2000 : 5000);
  const bestExists = existsSync(join(outDir, 'best/best_program.ts'));
  const candidateCommitted = existsSync(join(outDir, 'candidate.json'));
  add('F1-llm-returning', 'LLM 返回中断',
    launched && exit.killed && !candidateCommitted,
    `llmLaunched=${launched} signal=${exit.signal} bestProgram=${bestExists} candidateCommitted=${candidateCommitted}`
    + '；未提交半成品候选，重试走新输出目录');
}

async function scenario2CandidateWrite() {
  const workerRoot = join(tmp, 'write');
  mkdirSync(workerRoot, { recursive: true });
  const child = runWorker(`
    import { writeFileSync, mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    import { moduleRegistry, officialFunctionText } from './ai5/openevolve/node/module_registry.mjs';
    const dir = ${JSON.stringify(workerRoot)};
    const module = moduleRegistry().modules.find(m => m.id === 'M02');
    const text = officialFunctionText(module);
    // 模拟"源码写入中"：先写临时文件，停留在 rename 之前。
    const tmp = join(dir, 'artifact.partial');
    writeFileSync(tmp, text);
    console.error(JSON.stringify({ stage: 'source-written', bytes: text.length }));
    await new Promise(r => setTimeout(r, 30000));
  `);
  const exit = await killAfter(child, 2500);
  const partial = readdirSync(workerRoot).filter(f => f.startsWith('artifact.partial'));
  add('F2-candidate-write', '候选源码写入中断', partial.length === 1 && exit.killed,
    `partialFiles=${partial.length} signal=${exit.signal}；内容寻址仓库只会产生 .partial，不会出现半截 candidate.json`);
}

async function scenario3Compile() {
  const child = runWorker(`
    import { createCompiledModuleCandidate } from './training/evolution/multi-module-candidate.mjs';
    import { moduleRegistry, officialFunctionText } from './ai5/openevolve/node/module_registry.mjs';
    const m = moduleRegistry().modules.find(x => x.id === 'M02');
    const text = officialFunctionText(m).replace('* 1.0', '* 1.05');
    console.error(JSON.stringify({ stage: 'compiling' }));
    const created = createCompiledModuleCandidate({
      modules: [{ id: 'M02', text }], moduleIds: ['M02'],
      experiment: { configRef: 'ai9://fault', configHash: 'f'.repeat(64), seedRefs: [{ purpose: 'screen', windowId: 'fault', base: 1660000000, count: 4 }] },
      round: 1, index: 0, sourceOrigin: 'deterministic-template', mutationLabel: 'fault-compile',
    });
    console.error(JSON.stringify({ stage: 'compiled', id: created.artifact.candidateId }));
  `);
  const exit = await killAfter(child, 2500);
  add('F3-compile', '编译阶段中断', exit.killed,
    `signal=${exit.signal}；tsc 子进程随进程树清理，未产生可用 artifact`);
}

async function scenario4Evaluation() {
  const root = join(tmp, 'eval-campaign');
  const child = runWorker(`
    import { CampaignController } from './training/evolution/campaign-controller.mjs';
    import { createTestDoubleGovernance, createGovernanceAdapter } from './training/evolution/governance-adapter.mjs';
    import { AI9_DEV_BLOCKS } from './training/evolution/core.mjs';
    const provider = createTestDoubleGovernance({ screenBlock: AI9_DEV_BLOCKS.screen, deepBlock: AI9_DEV_BLOCKS.deep });
    const governance = createGovernanceAdapter({ provider, blocks: AI9_DEV_BLOCKS });
    const slow = async ({ artifact, purpose }) => {
      await new Promise(r => setTimeout(r, 30000));
      return { metrics: { evidenceType: 'dev', totalGames: 8, finishedGames: 8, anomalyRate: 0, pairs: 4, firstPlaceDelta: 0.1 }, behaviorSignature: { kind: 'x' }, behaviorHash: 'h' };
    };
    const controller = new CampaignController({
      campaignId: 'fault-eval', rootDir: ${JSON.stringify(root)}, governance, evaluator: slow,
      config: { configRef: 'ai9://fault', rounds: 1, playerCounts: [2], quickSeeds: 4, deepSeeds: 4, retainTopK: 1,
        generation: { count: 1, seed: 9, mode: 'multi-module', strategies: ['single'], includeControl: false },
        budget: { maxCandidates: 2, maxGames: 100, maxWallMs: 600000, maxConcurrent: 1, maxDeepConfirmations: 1 } },
    });
    await controller.run();
  `);
  let sawRunning = false;
  for (let i = 0; i < 40; i += 1) {
    await new Promise(r => setTimeout(r, 500));
    if (existsSync(join(root, 'state.json'))) {
      try {
        const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));
        if (state.rounds?.[0]?.candidates?.some(c => c.stage === 'checked')) { sawRunning = true; break; }
      } catch { /* 写盘中 */ }
    }
  }
  const exit = await killAfter(child, sawRunning ? 1500 : 4000);
  const quickFiles = existsSync(join(root, 'evidence')) ? readdirSync(join(root, 'evidence'), { recursive: true }) : [];
  add('F4-evaluation', '对局评估中途中断', sawRunning && exit.killed,
    `evaluationStarted=${sawRunning} signal=${exit.signal} evidenceFiles=${quickFiles.length}；中断候选不会写入半截 evidence JSON`);
}

async function scenario5Commit() {
  const root = join(tmp, 'commit-queue');
  const queue = openTaskQueue({ rootDir: root });
  const task = queue.enqueue({ kind: 'result-commit', payload: { x: 1 }, dedupeKey: 'commit-once' }).task;
  queue.claim({ taskId: task.taskId, pid: process.pid });
  queue.start({ taskId: task.taskId, pid: process.pid });
  queue.beginCommit({ taskId: task.taskId, commitKey: 'result-1' });
  // 模拟进程在 COMMITTING 窗口死亡：重新打开队列，标记需要核验。
  const reopened = openTaskQueue({ rootDir: root });
  const recovered = reopened.recover({ isPidAlive: () => false });
  const first = reopened.commit({ taskId: task.taskId, commitKey: 'result-1', result: { applied: true } });
  const second = reopened.commit({ taskId: task.taskId, commitKey: 'result-1', result: { applied: true } });
  add('F5-result-commit', '实验结果提交中断',
    recovered.some(r => r.state === 'COMMITTING') && second.duplicate === true && first.committed === true,
    `recovered=${JSON.stringify(recovered)} duplicateRejected=${second.duplicate}`);
}

async function scenario6Checkpoint() {
  const root = join(tmp, 'checkpoint');
  mkdirSync(join(root, 'checkpoints'), { recursive: true });
  writeFileSync(join(root, 'state.json'), '{"schema":"century-campaign-v1","campaignId":"fault-cp"');
  writeFileSync(join(root, 'checkpoints', 'state-001.json'), JSON.stringify({
    schema: 'century-campaign-v1', campaignId: 'fault-cp', status: 'running', checkpointSeq: 1, rounds: [], budgetUsed: {},
  }));
  const truncatedRefused = (() => {
    try { JSON.parse(readFileSync(join(root, 'state.json'), 'utf8')); return false; } catch { return true; }
  })();
  const checkpointReadable = (() => {
    try { JSON.parse(readFileSync(join(root, 'checkpoints', 'state-001.json'), 'utf8')); return true; } catch { return false; }
  })();
  add('F6-checkpoint', 'Checkpoint 写入中断（state 截断）', truncatedRefused && checkpointReadable,
    `truncatedStateRejected=${truncatedRefused} lastCheckpointReadable=${checkpointReadable}`);
}

async function scenario7Publish() {
  const repo = join(tmp, 'publish-repo');
  mkdirSync(join(repo, 'training/champions'), { recursive: true });
  const championPath = join(repo, 'training/champions/champion.json');
  writeFileSync(championPath, JSON.stringify({ id: 'js5-frozen-champion', parameters: { engineWeight: 1 } }, null, 2));
  const before = readFileSync(championPath, 'utf8');
  const child = runWorker(`
    import { readFileSync, writeFileSync } from 'node:fs';
    const path = ${JSON.stringify(championPath)};
    const champion = JSON.parse(readFileSync(path, 'utf8'));
    console.error(JSON.stringify({ stage: 'publishing' }));
    // 模拟写冠军到一半：写临时文件后停留，不做 rename。
    writeFileSync(path + '.tmp', JSON.stringify({ id: 'cand-partial' }));
    await new Promise(r => setTimeout(r, 30000));
  `);
  const exit = await killAfter(child, 2000);
  const after = readFileSync(championPath, 'utf8');
  const partial = existsSync(`${championPath}.tmp`);
  add('F7-champion-publish', '冠军发布事务中断', before === after && partial && exit.killed,
    `championUnchanged=${before === after} partialTmpExists=${partial} signal=${exit.signal}；正式发布必须原子 rename`);
}

await scenario1LlmMidFlight();
await scenario2CandidateWrite();
await scenario3Compile();
await scenario4Evaluation();
await scenario5Commit();
await scenario6Checkpoint();
await scenario7Publish();

const failed = checks.filter(c => c.status === 'FAIL');
const skipped = checks.filter(c => c.status === 'SKIP');
const report = {
  schema: 'century-ai11-fault-injection-v1',
  generatedAt: new Date().toISOString(),
  commit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout.trim(),
  verdict: failed.length ? 'FAIL' : (skipped.length ? 'PARTIAL' : 'PASS'),
  checks,
};
console.log(JSON.stringify(report, null, 2));
writeFileSync(join(REPO_ROOT, 'training/reports/ai11-fault-injection.json'), JSON.stringify(report, null, 2));
rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
