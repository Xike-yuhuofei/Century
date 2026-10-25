#!/usr/bin/env node
/** 统一种子治理 CLI（AI7-A1）。
 *
 * 用法：
 *   node training/scripts/seed-governance-cli.mjs status [--json]
 *   node training/scripts/seed-governance-cli.mjs check [--json]
 *   node training/scripts/seed-governance-cli.mjs next [--json]
 *   node training/scripts/seed-governance-cli.mjs query --seed 900000001 [--json]
 *   node training/scripts/seed-governance-cli.mjs reserve --purpose-class deep-validation \
 *     --purpose deep-validation:best --base 300001200 --size 100 --experiment-id deep-x
 *   node training/scripts/seed-governance-cli.mjs complete --experiment-id deep-x --status completed
 *
 * 退出码：0=健康/成功；2=缺失/冲突/拒绝（fail-closed）。
 */
import { resolve } from 'node:path';
import {
  loadSeedGovernance, governanceReport, nextFormalValidationBase,
  formalChallengeCount, querySeed, queryInterval, reserveConsumption,
  completeConsumption, SEED_PURPOSES,
} from '../lib/seed-governance.mjs';

const argv = process.argv.slice(2);
const command = argv[0];
if (!command) {
  console.error('缺少命令：status|check|next|query|reserve|complete');
  process.exit(1);
}
const getArg = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
const hasFlag = (flag) => argv.includes(flag);
const json = hasFlag('--json');
// --root：隔离工作区/测试夹具使用；缺省为当前仓库。
const rootArg = getArg('--root');
const root = rootArg !== undefined ? resolve(process.cwd(), rootArg) : undefined;
const registryPath = root ? resolve(root, 'training/governance/seed-consumption-registry.json') : undefined;
const print = (value) => {
  if (json) console.log(JSON.stringify(value, null, 2));
  else if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value, null, 2));
};

try {
  if (command === 'status' || command === 'check') {
    const strict = command === 'check';
    const registry = loadSeedGovernance({ strict, ...(root ? { root } : {}) });
    const report = governanceReport(registry);
    if (json) print(report);
    else {
      console.log(`种子治理：${registry.complete ? '完整' : `缺失 ${registry.missingSources.join(',')}`}`);
      console.log(`区间条目 ${registry.entries.length}；用途分布 ${JSON.stringify(registry.summary.byPurpose)}`);
      console.log(`正式挑战累计 ${registry.summary.formalChallenges}；验证池区间 ${registry.summary.validationPoolIntervals}`);
      console.log(`冲突 ${registry.conflicts.length}；不确定条目 ${registry.summary.uncertainEntries}`);
      for (const conflict of registry.conflicts) console.log(`  ✗ ${conflict.message}`);
      for (const missing of registry.missingSources) console.log(`  ⛔ 缺失来源：${missing}`);
    }
    if (!registry.complete || registry.conflicts.length) process.exit(2);
    process.exit(0);
  }

  if (command === 'next') {
    const registry = loadSeedGovernance({ strict: true, ...(root ? { root } : {}) });
    const next = {
      nextBase: nextFormalValidationBase(registry),
      nextChallengeIndex: formalChallengeCount(registry) + 1,
      formalChallengeCount: formalChallengeCount(registry),
    };
    print(next);
    process.exit(0);
  }

  if (command === 'query') {
    const registry = loadSeedGovernance({ strict: true, ...(root ? { root } : {}) });
    const seed = getArg('--seed');
    if (seed !== undefined) {
      const hits = querySeed(registry, Number(seed));
      print({ query: { seed: Number(seed) }, hits });
      process.exit(0);
    }
    const base = getArg('--base');
    const size = getArg('--size');
    if (base !== undefined && size !== undefined) {
      const hits = queryInterval(registry, Number(base), Number(size));
      print({ query: { base: Number(base), size: Number(size) }, hits });
      process.exit(0);
    }
    console.error('query 需要 --seed 或 --base/--size');
    process.exit(1);
  }

  if (command === 'reserve') {
    const purposeClass = getArg('--purpose-class');
    if (!SEED_PURPOSES.includes(purposeClass)) {
      console.error(`--purpose-class 必须为：${SEED_PURPOSES.join('|')}`);
      process.exit(1);
    }
    const result = reserveConsumption({
      purposeClass,
      purpose: getArg('--purpose') ?? purposeClass,
      base: Number(getArg('--base')),
      size: Number(getArg('--size')),
      experimentId: getArg('--experiment-id'),
      challengeIndex: getArg('--challenge-index') !== undefined ? Number(getArg('--challenge-index')) : null,
      evidencePath: getArg('--evidence') ?? null,
      codeCommit: getArg('--code-commit') ?? null,
      ...(root ? { root, registryPath } : {}),
    });
    print({ ok: true, entry: result.entry });
    process.exit(0);
  }

  if (command === 'complete') {
    const entry = completeConsumption(getArg('--experiment-id'), {
      status: getArg('--status') ?? 'completed',
      note: getArg('--note') ?? null,
      evidencePath: getArg('--evidence') ?? null,
      ...(registryPath ? { registryPath } : {}),
    });
    print({ ok: true, entry });
    process.exit(0);
  }

  console.error(`未知命令：${command}`);
  process.exit(1);
} catch (error) {
  console.error(`种子治理阻断（fail-closed）：${error.message}`);
  process.exit(2);
}
