#!/usr/bin/env node
/** 历史算法版本锁 CLI（AI7-A2）。
 *
 *   node training/scripts/version-lock.mjs --check
 *   node training/scripts/version-lock.mjs --write [--note "本次有意变更说明"]
 *
 * 默认 --check：锁与归档/决策核心源码不一致 → exit 2（fail-closed）。
 */
import { verifyVersionLock, writeVersionLock } from '../lib/version-lock.mjs';

const args = process.argv.slice(2);
const noteIndex = args.indexOf('--note');
const note = noteIndex >= 0 ? args[noteIndex + 1] : null;

if (args.includes('--write')) {
  const { absolute, lock } = writeVersionLock({ note });
  console.log(`版本锁已更新：${absolute}`);
  console.log(`  archives=${Object.keys(lock.archives).length} decisionSources=${Object.keys(lock.decisionSources).length}`);
  process.exit(0);
}

const result = verifyVersionLock();
if (result.ok) {
  console.log(`版本锁一致：archives=${Object.keys(result.lock.archives).length} decisionSources=${Object.keys(result.lock.decisionSources).length}`);
  process.exit(0);
}
console.error('版本锁校验失败（fail-closed）：');
for (const error of result.errors) console.error(`  - ${error}`);
process.exit(2);
