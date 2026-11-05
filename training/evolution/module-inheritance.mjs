/** 完整子代的谱系差分；移除只允许显式消融。 */
import { assertCondition, sha256Canonical } from './core.mjs';
import { sha256 } from '../../ai5/openevolve/node/module_registry.mjs';
export function inheritanceDiff(parent = {}, child = {}, { allowRemoval = false } = {}) {
  const hashes = texts => Object.fromEntries(Object.entries(texts).map(([id, text]) => [id, sha256(text)]));
  const before = hashes(parent), after = hashes(child);
  const removed = Object.keys(before).filter(id => !(id in after)).sort();
  assertCondition(allowRemoval || !removed.length, `非法丢失父代模块：${removed.join(',')}`);
  const retained = Object.keys(before).filter(id => before[id] === after[id]).sort();
  const modified = Object.keys(before).filter(id => id in after && before[id] !== after[id]).sort();
  const added = Object.keys(after).filter(id => !(id in before)).sort();
  return { parentModuleHashes: before, modulesRetained: retained, modulesInherited: retained,
    modulesModified: modified, modulesAdded: added, modulesRemoved: removed,
    modulesChanged: [...modified, ...added].sort(),
    inputProgramHash: sha256Canonical(before), outputProgramHash: sha256Canonical(after) };
}
