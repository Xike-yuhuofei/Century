/** 对抗性联赛测试：对手版本注册表（不可变指纹 / 冻结身份 / strip-adapter）。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildRegistry, resolveVersion, stripAdapter, canonicalJSON, sha256Hex,
  versionFingerprint, registryFingerprint, validateDescriptor,
  applyWeightOverrides, championBaseParameters, CHAMPION_ARCHIVE_DIR,
} from '../adversarial/registry.mjs';
import { setAIParameters, resetAIParameters, CHAMPION_PARAMETERS, BASELINE_PARAMETERS } from '../../web-v1/dist/js/ai/parameters.js';

test('注册表构建：9 个版本、三决策核心齐备、确定性重建', () => {
  const reg = buildRegistry({ jointOptions: null });
  const ids = Object.keys(reg.versions);
  assert.equal(ids.length, 9);
  for (const expected of [
    'js5-frozen-champion', 'ai5-readiness-efficiency', 'ai4-struct-beam-rollout',
    'neutral-baseline', 'style-rush', 'style-engine', 'style-contest',
    'style-balanced', 'random-legal',
  ]) assert.ok(ids.includes(expected), `缺少版本 ${expected}`);
  const cores = new Set(ids.map(id => reg.versions[id].decisionCore));
  for (const core of ['champion-guided', 'beam-search', 'random-legal']) {
    assert.ok(cores.has(core), `缺少决策核心 ${core}`);
  }
  const reg2 = buildRegistry({ jointOptions: null });
  assert.equal(reg2.snapshot.registryFingerprint, reg.snapshot.registryFingerprint, '重建指纹必须一致');
  assert.equal(reg2.snapshot.engineBundleSha256, reg.snapshot.engineBundleSha256);
});

test('注册表深冻结：任何变异都被拒绝', () => {
  const reg = buildRegistry({ jointOptions: null });
  assert.throws(() => { 'use strict'; reg.versions['style-rush'].id = 'x'; }, TypeError);
  assert.throws(() => { 'use strict'; reg.versions['style-rush'].parameters.tempoWeight = 9; }, TypeError);
  assert.throws(() => { 'use strict'; reg.versions['js5-frozen-champion'].jointOptions = {}; }, TypeError);
});

test('冻结版本身份来自晋级归档，不随活动冠军状态切换而变化', () => {
  const reg = buildRegistry({ jointOptions: null });
  const before = reg.snapshot.registryFingerprint;
  const js5Fp = reg.versions['js5-frozen-champion'].fingerprint;
  // 模拟"当前冠军切换"：篡改活动参数（正式系统中对应新冠军 apply-champion）。
  try {
    setAIParameters({ ...BASELINE_PARAMETERS, id: 'hypothetical-future-champion' });
    const regAfter = buildRegistry({ jointOptions: null });
    assert.equal(regAfter.snapshot.registryFingerprint, before, '活动冠军切换不得影响注册表身份');
    assert.equal(regAfter.versions['js5-frozen-champion'].fingerprint, js5Fp);
  } finally {
    resetAIParameters();
  }
  // 归档目录 注入：注册表只读已知归档文件，目录内新增归档不影响既有身份。
  const tmp = mkdtempSync(join(tmpdir(), 'adv-reg-'));
  for (const f of readdirSync(CHAMPION_ARCHIVE_DIR).filter(f => f.endsWith('.json'))) {
    copyFileSync(join(CHAMPION_ARCHIVE_DIR, f), join(tmp, f));
  }
  writeFileSync(join(tmp, 'joint-js6-hypothetical.json'), JSON.stringify({
    id: 'joint-js6-hypothetical', parameters: { id: 'joint-js6-hypothetical', adapter: 'champion-guided', jointVersion: 'joint-js5' },
  }));
  const regTmp = buildRegistry({ archiveDir: tmp, jointOptions: null });
  assert.equal(regTmp.versions['js5-frozen-champion'].fingerprint, js5Fp);
});

test('stripAdapter：恰好剥离 adapter/jointVersion/budgetMs 三个字段', () => {
  const stripped = stripAdapter(CHAMPION_PARAMETERS);
  assert.equal(stripped.adapter, undefined);
  assert.equal(stripped.jointVersion, undefined);
  assert.equal(stripped.budgetMs, undefined);
  assert.equal(stripped.acquisitionVariant, CHAMPION_PARAMETERS.acquisitionVariant);
  assert.equal(stripped.id, CHAMPION_PARAMETERS.id);
  // 不修改输入
  assert.equal(CHAMPION_PARAMETERS.adapter, 'champion-guided');
});

test('冠军基座参数：适配器归档缺省权重补 1.0，结构固定 beam-rollout', () => {
  const base = championBaseParameters(CHAMPION_PARAMETERS);
  assert.equal(base.adapter, undefined);
  assert.equal(base.structure, 'beam-rollout');
  assert.equal(base.acquisitionVariant, 'readiness-efficiency');
  for (const key of ['engineWeight', 'tempoWeight', 'contestWeight', 'synergyWeight', 'goalWeight', 'capacityWeight', 'restWeight', 'endgameWeight']) {
    assert.equal(base[key], 1, `基座权重 ${key} 缺省应为 1.0`);
  }
});

test('指纹：键序不变性、权重敏感性、字段敏感性', () => {
  const a = { decisionCore: 'beam-search', parameters: { id: 'x', engineWeight: 1, tempoWeight: 2 }, structure: 'beam-rollout', acquisitionVariant: null, jointOptions: null };
  const reordered = { jointOptions: null, acquisitionVariant: null, structure: 'beam-rollout', parameters: { tempoWeight: 2, engineWeight: 1, id: 'x' }, decisionCore: 'beam-search' };
  assert.equal(versionFingerprint(a), versionFingerprint(reordered), '键序不得影响指纹');
  const changed = structuredClone(a);
  changed.parameters.tempoWeight = 2.5;
  assert.notEqual(versionFingerprint(a), versionFingerprint(changed), '权重变化必须改变指纹');
  const withJoint = structuredClone(a);
  withJoint.decisionCore = 'champion-guided';
  withJoint.jointOptions = { budgetMs: 100 };
  assert.notEqual(versionFingerprint(a), versionFingerprint(withJoint), '运行时选项变化必须改变指纹');
  assert.equal(sha256Hex(canonicalJSON([1, 2])), sha256Hex(canonicalJSON([1, 2])));
});

test('描述符校验：走私 adapter / 缺 adapter / 非法 id 全部拒绝', () => {
  assert.throws(() => validateDescriptor({
    id: 'bad-variant', family: 'style', decisionCore: 'beam-search',
    parameters: { ...BASELINE_PARAMETERS, adapter: 'champion-guided' },
  }), /adapter.*audit 缺陷|非法携带 adapter/);
  assert.throws(() => validateDescriptor({
    id: 'bad-joint', family: 'champion', decisionCore: 'champion-guided',
    parameters: { ...BASELINE_PARAMETERS },
  }), /必须显式携带 adapter/);
  assert.throws(() => validateDescriptor({
    id: 'BAD ID!', family: 'style', decisionCore: 'beam-search', parameters: BASELINE_PARAMETERS,
  }), /id 非法/);
  assert.throws(() => validateDescriptor({
    id: 'ok-id', family: 'style', decisionCore: 'quantum', parameters: BASELINE_PARAMETERS,
  }), /decisionCore 非法/);
  // 合法通过（validateDescriptor 返回校验后的参数——id 透传参数自身 id）
  const ok = validateDescriptor({ id: 'ok-id', family: 'style', decisionCore: 'beam-search', parameters: BASELINE_PARAMETERS });
  assert.equal(ok.id, BASELINE_PARAMETERS.id);
});

test('权重覆盖：越界拒绝、未知键拒绝、合法合并', () => {
  const base = championBaseParameters(CHAMPION_PARAMETERS);
  assert.throws(() => applyWeightOverrides(base, { tempoWeight: 99 }), /越界/);
  assert.throws(() => applyWeightOverrides(base, { notAWeight: 1 }), /未知权重参数/);
  const merged = applyWeightOverrides(base, { tempoWeight: 1.8, restWeight: 0.4 });
  assert.equal(merged.tempoWeight, 1.8);
  assert.equal(merged.restWeight, 0.4);
  assert.equal(merged.engineWeight, 1);
});

test('resolveVersion：未注册 id 抛错（禁止静默回退）', () => {
  const reg = buildRegistry({ jointOptions: null });
  assert.throws(() => resolveVersion(reg, 'nonexistent'), /未注册的对手版本/);
  assert.equal(resolveVersion(reg, 'style-rush').id, 'style-rush');
});

test('注册表快照披露全部版本指纹', () => {
  const reg = buildRegistry({ jointOptions: null });
  assert.equal(Object.keys(reg.snapshot.versionFingerprints).length, 9);
  for (const [id, fp] of Object.entries(reg.snapshot.versionFingerprints)) {
    assert.equal(reg.versions[id].fingerprint, fp);
  }
  assert.equal(reg.snapshot.registryFingerprint, registryFingerprint(reg));
  assert.match(reg.snapshot.engineBundleSha256, /^[0-9a-f]{64}$/);
});
