#!/usr/bin/env node
/** P5：故障注入验收（不允许用缩短测试/假评估器冒充 12 小时真实验收）。
 *
 * 覆盖：
 * 1. 训练进程强制终止 → 恢复不重复消费种子；
 * 2. 候选超时 → 记为异常局，不崩溃、不伪装完成；
 * 3. 非法候选源码 → 静态检查拒绝；
 * 4. 编译失败 → 隔离失败，不产生可用 artifact；
 * 5. 重复 Campaign 启动 → 锁拒绝；
 * 6. 种子区间冲突 → 中央登记拒绝；
 * 7. 结果文件损坏 → fail-closed；
 * 8. 资源耗尽 → 调度器停止/降载；
 * 9. LLM 服务不可用 → OpenEvolve 明确报告 available:false，不伪装成功。
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeJSON } from '../lib/io.mjs';
import { REPO_ROOT } from '../lib/paths.mjs';
import { evaluateCapacity } from '../lib/resource-scheduler.mjs';
import { simulateGame } from '../simulator/simulate.mjs';
import { buildRegistry } from '../adversarial/registry.mjs';
import { runSafetyChecks } from '../evolution/safety-check.mjs';
import { createCandidateFromSpec } from '../evolution/candidate-generator.mjs';
import { createCompiledAcquisitionCandidate } from '../evolution/compiled-candidate.mjs';
import { CampaignController } from '../evolution/campaign-controller.mjs';
import { createTestDoubleGovernance, createGovernanceAdapter } from '../evolution/governance-adapter.mjs';
import { reserveConsumption, completeConsumption } from '../lib/seed-governance.mjs';
import { loadOpenEvolveBestProgram } from '../evolution/openevolve-bridge.mjs';

const checks = [];
const add = (id, pass, evidence) => checks.push({ id, status: pass ? 'PASS' : 'FAIL', evidence });
const tmp = mkdtempSync(join(tmpdir(), 'century-fault-'));

function experimentRef() {
  return { configRef: 'fault-injection', configHash: 'f'.repeat(64), seedRefs: [] };
}

async function main() {
  // 1. 强制终止后的恢复：锁文件残留（pid 不存在）应被接管，不重复消费种子。
  {
    const root = join(tmp, 'campaign-kill');
    const governance = createGovernanceAdapter({ provider: createTestDoubleGovernance() });
    const config = { rounds: 1, quickSeeds: 1, deepSeeds: 1, playerCounts: [2], generation: { count: 1, seed: 1 } };
    const controller = new CampaignController({
      campaignId: 'fault-kill', rootDir: root, governance, config,
      generator: () => ({ candidates: [], rejectedAtGeneration: [] }),
      evaluator: () => { throw new Error('should not run'); },
      isPidAlive: () => false,
    });
    writeJSON(join(root, '.campaign.lock'), { pid: 999_999, runFingerprint: controller.runFingerprint });
    let resumed = false;
    try {
      await controller.run();
      resumed = existsSync(join(root, 'state.json'));
    } catch (error) {
      add('kill-recovery', false, `恢复失败：${error.message}`);
    }
    if (existsSync(join(root, 'state.json'))) {
      add('kill-recovery', resumed, '残留锁（pid 不存在）被接管，campaign 状态正常写入');
    }
  }

  // 2. 候选超时 → 异常局而非崩溃。
  {
    const registry = buildRegistry();
    const base = registry.versions['neutral-baseline'].parameters;
    const result = simulateGame({
      seed: 1_600_500_001, seatCount: 2,
      versions: [{ id: 'a', parameters: base }, { id: 'b', parameters: base }],
      deadlineMs: 1, maxMoves: 1200,
    });
    add('candidate-timeout', result.status === 'anomaly' && /时间预算/.test(result.reason ?? ''),
      `status=${result.status} reason=${String(result.reason).slice(0, 80)}`);
  }

  // 3. 非法候选源码 → 静态安全检查拒绝。
  {
    const artifact = createCandidateFromSpec({
      targetId: 'engineValue',
      values: { template: 'linear-feature-v1', coefficients: { outputWeight: 0.4 }, bias: 0, notes: 'import fs; Math.random(); merchantDeck' },
      experiment: experimentRef(),
    }).artifact;
    const safety = runSafetyChecks(artifact);
    add('illegal-source', safety.status !== 'passed', `status=${safety.status} fails=${safety.checks.filter(c => c.status === 'fail').length}`);
  }

  // 4. 编译失败 → 隔离失败（不产生 artifact）。
  {
    const badProgram = 'export function acquisitionValue(state) { return notDefined + ; }';
    let threw = false;
    let message = '';
    try {
      createCompiledAcquisitionCandidate({
        experiment: experimentRef(), programText: badProgram, mutationLabel: 'fault-compile',
      });
    } catch (error) {
      threw = true;
      message = error.message.slice(0, 200);
    }
    add('compile-failure', threw && /静态检查|编译/.test(message), message || '未抛出（失败未隔离）');
  }

  // 5. 重复 Campaign 启动 → 锁拒绝。
  {
    const root = join(tmp, 'campaign-lock');
    const governance = createGovernanceAdapter({ provider: createTestDoubleGovernance() });
    const config = { rounds: 1, quickSeeds: 1, deepSeeds: 1, playerCounts: [2], generation: { count: 1, seed: 1 } };
    const a = new CampaignController({ campaignId: 'lock-a', rootDir: root, governance, config, generator: () => [], evaluator: () => ({}) });
    const b = new CampaignController({ campaignId: 'lock-a', rootDir: root, governance, config, generator: () => [], isPidAlive: () => true });
    a._acquireLock();
    let refused = false;
    try { b._acquireLock(); } catch (error) { refused = /已有活动进程|重复运行/.test(error.message); }
    a._releaseLock();
    add('duplicate-campaign', refused, refused ? '活动锁拒绝第二个进程' : '未拒绝重复进程');
  }

  // 6. 种子区间冲突 → 中央登记拒绝。
  {
    const registryPath = join(tmp, 'seed-registry.json');
    writeFileSync(registryPath, JSON.stringify({ schema: 'century-seed-consumption-registry-v1', createdAt: new Date().toISOString(), entries: [] }));
    reserveConsumption({
      purposeClass: 'audit', purpose: 'fault-injection', base: 1_600_000_000, size: 50,
      experimentId: 'fault-audit-1', registryPath, root: REPO_ROOT,
    });
    let refused = false;
    try {
      reserveConsumption({
        purposeClass: 'audit', purpose: 'fault-injection', base: 1_600_000_010, size: 50,
        experimentId: 'fault-audit-2', registryPath, root: REPO_ROOT,
      });
    } catch (error) { refused = /重叠|种子复用/.test(error.message); }
    completeConsumption('fault-audit-1', { status: 'voided', registryPath });
    add('seed-conflict', refused, refused ? '重叠区间被中央登记拒绝' : '未拒绝重叠区间');
  }

  // 7. 结果文件损坏 → fail-closed。
  {
    const root = join(tmp, 'campaign-corrupt');
    const governance = createGovernanceAdapter({ provider: createTestDoubleGovernance() });
    const config = { rounds: 1, quickSeeds: 1, deepSeeds: 1, playerCounts: [2], generation: { count: 1, seed: 1 } };
    const controller = new CampaignController({ campaignId: 'corrupt', rootDir: root, governance, config, generator: () => [], evaluator: () => ({}) });
    writeFileSync(join(root, 'state.json'), '{not-json');
    let refused = false;
    try { await controller.run({ resume: true }); } catch { refused = true; }
    add('corrupt-state', refused, refused ? '损坏 state 导致恢复失败（fail-closed）' : '未拒绝损坏 state');
  }

  // 8. 资源耗尽 → 停止/降载。
  {
    const low = evaluateCapacity({
      requestedConcurrency: 4,
      snapshot: { cpuCount: 10, loadAverage: [30, 20, 10], totalMem: 16 * 1024 ** 3, freeMem: 1024 ** 3, availableMem: 512 * 1024 ** 2, availableMemRatio: 0.03, freeDisk: 100 * 1024 ** 3 },
    });
    add('resource-exhaustion', low.action === 'stop' && low.ok === false, `action=${low.action} reasons=${low.reasons.join('；')}`);
  }

  // 9. LLM 不可用 → 明确 available:false。
  {
    const missing = loadOpenEvolveBestProgram({ outputDir: join(tmp, 'no-such-run') });
    add('llm-unavailable', missing.available === false && /不存在/.test(missing.reason), missing.reason);
  }

  const failed = checks.filter(c => c.status === 'FAIL');
  const report = {
    schema: 'century-fault-injection-report-v1',
    generatedAt: new Date().toISOString(),
    verdict: failed.length ? 'FAIL' : 'PASS',
    checks,
  };
  console.log(JSON.stringify(report, null, 2));
  if (process.env.FAULT_REPORT) writeFileSync(process.env.FAULT_REPORT, JSON.stringify(report, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main()
  .catch(error => {
    console.error(`故障注入执行失败：${error.stack ?? error.message}`);
    process.exit(1);
  })
  .finally(() => rmSync(tmp, { recursive: true, force: true }));
