/** 战术基准库 · 完整性与信息边界测试（固定工作量，全语料覆盖）。
 *
 * 覆盖任务书 D 节前三类自动测试：
 * 1. 局面合法性：每个基准局面从 engineState.position 复原后，公开观察与
 *    publicView 逐位一致，头部字段一致，记录的全部合法行动被正式引擎逐条接受，
 *    认领行动集合与引擎 legalClaimIndices 一致。
 * 2. 公开信息边界：publicView 不含隐藏牌库字段；决策在"牌库内容置换"下逐位
 *    不变（证明 AI 决策输入与隐藏牌序正交）；引擎侧静态口径由 tests/ai-fairness
 *    已有扫描覆盖，此处验证语料层边界。
 * 3. 合法行动集合：模拟器全量枚举（web-v1/src/sim/legal.ts 全量口径）与记录
 *    集合逐键一致；弃置阶段外的行动数与引擎接受集一致。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { applyAction, legalClaimIndices } from '../../../web-v1/dist/js/engine.js';
import { buildObservation } from '../../../web-v1/dist/js/ai.js';
import { buildPublicSimState, enumerateLegalActions } from '../../../web-v1/dist/js/sim/index.js';
import { actionKey } from '../lib/classify.mjs';
import { SCHEMA } from '../lib/decisions.mjs';
import { decideWithVersion, frozenVersions, seatProfile } from '../lib/versions.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data', 'scenarios.jsonl');

const scenarios = readFileSync(DATA, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));

test('语料存在且规模达标，schema 与 id 唯一', () => {
  assert.ok(scenarios.length >= 20, `语料应 ≥20 条，实际 ${scenarios.length}`);
  const ids = new Set(scenarios.map(s => s.id));
  assert.equal(ids.size, scenarios.length, 'id 必须唯一');
  for (const s of scenarios) {
    assert.equal(s.schema, SCHEMA);
    assert.ok(s.provenance?.gameSeed !== undefined);
    assert.ok(s.engineState?.position);
    assert.equal(s.engineState.containsHiddenInfo, true, '隐藏信息必须显式标记');
  }
});

test('十类目标类别全部覆盖', () => {
  const TARGET = ['final-round', 'opponent-ending', 'contested-claim', 'multi-claim', 'seat-race',
    'acquire-vs-score', 'caravan-pressure', 'trade-chain-rest', 'conversion-efficiency', 'engine-overinvest'];
  const covered = new Set(scenarios.flatMap(s => s.classification.tags));
  for (const t of TARGET) assert.ok(covered.has(t), `缺少类别：${t}`);
});

const revived = new Map();
function revive(s) {
  if (!revived.has(s.id)) {
    const game = structuredClone(s.engineState.position);
    for (const p of game.players) p.isAI = true;
    revived.set(s.id, game);
  }
  return revived.get(s.id);
}

test('局面合法性：公开观察与头部字段逐位一致', () => {
  for (const s of scenarios) {
    const game = revive(s);
    assert.equal(game.phase, 'turn', `${s.id} 必须是 turn 阶段`);
    const view = buildObservation(game);
    assert.equal(JSON.stringify(view), JSON.stringify(s.publicView), `${s.id} publicView 与引擎重建不一致`);
    assert.equal(game.current, s.currentSeat, s.id);
    assert.equal(game.turnNumber, s.turnNumber, s.id);
    assert.equal(game.triggerPlayer, s.endgame.triggerPlayer, s.id);
    assert.deepEqual(game.players.map(p => p.claimed.length), s.endgame.claimsBySeat, s.id);
    assert.equal(s.publicView.merchantDeck, undefined, `${s.id} publicView 泄露 merchantDeck`);
    assert.equal(s.publicView.golemDeck, undefined, `${s.id} publicView 泄露 golemDeck`);
  }
});

test('局面合法性：记录的合法行动全部被正式引擎接受', () => {
  let checked = 0;
  for (const s of scenarios) {
    for (const action of s.legalActions) {
      const game = structuredClone(s.engineState.position);
      for (const p of game.players) p.isAI = true;
      applyAction(game, structuredClone(action)); // 非法行动在此抛出
      checked++;
    }
  }
  assert.ok(checked > 500, `行动接受量过低：${checked}`);
});

test('局面合法性：认领行动集合与引擎 legalClaimIndices 一致', () => {
  for (const s of scenarios) {
    const engine = legalClaimIndices(revive(s)).sort((a, b) => a - b);
    const recorded = s.legalActions.filter(a => a.type === 'claim').map(a => a.index).sort((a, b) => a - b);
    assert.deepEqual(recorded, engine, `${s.id} 认领集合不一致`);
  }
});

test('合法行动集合：模拟器全量枚举与记录逐键一致', () => {
  let total = 0;
  for (const s of scenarios) {
    const view = buildObservation(revive(s));
    const enumerated = enumerateLegalActions(buildPublicSimState(view), { dedupe: false });
    const enumKeys = enumerated.map(actionKey).sort();
    const recKeys = s.legalActions.map(actionKey).sort();
    assert.deepEqual(enumKeys, recKeys, `${s.id} 合法行动集合不一致`);
    assert.equal(s.legalActionCount, recKeys.length, s.id);
    total += recKeys.length;
  }
  assert.ok(total > 1000, `全语料行动总量过低：${total}`);
});

test('公开信息边界：隐藏牌序置换后冻结版本决策逐位不变（抽样）', { timeout: 60_000 }, () => {
  // 每个主分类抽 1 条：把 merchantDeck/golemDeck 就地轮转（长度不变、研究侧口径），
  // 决策函数只消费公开观察 ⇒ 行动与理由必须逐位不变。
  const byPrimary = new Map();
  for (const s of scenarios) if (!byPrimary.has(s.classification.category)) byPrimary.set(s.classification.category, s);
  const sample = [...byPrimary.values()].slice(0, 6); // 固定工作量：最多 6 条
  const versions = ['js5-w128', 'classic-beam-rollout'];
  for (const s of sample) {
    const game = revive(s);
    const masked = structuredClone(game);
    masked.merchantDeck = [...masked.merchantDeck.slice(1), masked.merchantDeck[0]];
    masked.golemDeck = masked.golemDeck.length > 1 ? [...masked.golemDeck.slice(1), masked.golemDeck[0]] : masked.golemDeck;
    for (const p of masked.players) p.isAI = true;
    for (const v of versions) {
      const original = s.decisions[v];
      assert.ok(original, `${s.id} 缺少 ${v} 记录`);
      const version = frozenVersions().find(x => x.key === v);
      const fresh = decideWithVersion(masked, version, seatProfile(s.currentSeat));
      assert.equal(actionKey(fresh.action), original.actionKey, `${s.id}/${v} 决策随隐藏牌序漂移`);
      assert.equal(fresh.reason, original.reason, `${s.id}/${v} 决策理由随隐藏牌序漂移`);
    }
  }
});

// ==================== P1-3 整改：公开/私有数据层物理分离 ====================

import {
  splitScenarioRecord, mergeScenarioRecords, assertPublicNoHiddenInfo,
  loadPublicScenarios, loadPrivateOracle, PUBLIC_FORBIDDEN_KEYS,
} from '../lib/dataset.mjs';

const SCEN_ROOT = join(HERE, '..');
const publicRecords = JSON.parse(JSON.stringify(loadPublicScenarios(SCEN_ROOT)));
const privateRecords = loadPrivateOracle(SCEN_ROOT, { purpose: 'oracle 复算与重放验证（完整性测试）' });

test('P1-3 双层数据集：50 条局面迁移完整、scenarioId 稳定关联', () => {
  assert.equal(scenarios.length, 50, '原始语料 50 条不得丢失');
  assert.equal(publicRecords.length, 50, '公开层必须覆盖全部 50 条');
  assert.equal(privateRecords.length, 50, '私有层必须覆盖全部 50 条');
  const ids = scenarios.map(s => s.id);
  assert.deepEqual(publicRecords.map(r => r.id), ids, '公开层 id 顺序与原始语料一致');
  assert.deepEqual(privateRecords.map(r => r.scenarioId), ids, '私有层 scenarioId 顺序与原始语料一致');
});

test('P1-3 公开层零隐藏信息：position/gameSeed/牌库键任意层级不存在', () => {
  const violations = assertPublicNoHiddenInfo(publicRecords);
  assert.deepEqual(violations, [], `公开层泄漏：${violations.join('；')}`);
  for (const r of publicRecords) {
    assert.equal(r.engineState, undefined, '公开层不得携带 engineState');
    assert.equal(r.provenance.gameSeed, undefined, 'gameSeed 可与引擎 commit 确定性重导出牌库序——必须只在私有层');
    assert.ok(r.hiddenStateRef?.containsHiddenInfo, '公开层必须显式指向私有层并标记 containsHiddenInfo');
    assert.equal(r.publicView.merchantDeck, undefined);
    assert.equal(r.publicView.golemDeck, undefined);
  }
});

test('P1-3 无损迁移：public+private ⇄ 原始记录逐字段还原', () => {
  for (let i = 0; i < scenarios.length; i++) {
    const merged = mergeScenarioRecords(publicRecords[i], privateRecords[i]);
    assert.deepEqual(merged, scenarios[i], `${scenarios[i].id} 合并后必须与原始记录逐位一致`);
  }
});

test('P1-3 公开层合法行动集合与决策分歧保持一致（AI 可用性不降级）', () => {
  for (let i = 0; i < scenarios.length; i++) {
    assert.deepEqual(publicRecords[i].legalActions, scenarios[i].legalActions, `${scenarios[i].id} 合法行动集合必须一致`);
    assert.deepEqual(publicRecords[i].decisions, scenarios[i].decisions, `${scenarios[i].id} 冻结版本决策必须一致`);
    assert.deepEqual(publicRecords[i].disagreement, scenarios[i].disagreement, `${scenarios[i].id} 分歧矩阵必须一致`);
    assert.deepEqual(publicRecords[i].publicView, scenarios[i].publicView, `${scenarios[i].id} 公开观察必须一致`);
  }
});

test('P1-3 oracle 语义：公开层保留 honest 限定 + 监督使用警告', () => {
  const oracleIds = scenarios.filter(s => s.oracle).map(s => s.id);
  assert.ok(oracleIds.length > 0, '语料必须含 oracle 局面');
  for (const r of publicRecords) {
    if (!r.oracle) continue;
    assert.match(String(r.oracle.model ?? ''), /exact-under-recorded-deck/, `${r.id} oracle 必须保留 exact-under-recorded-deck 限定`);
    assert.match(r.oracleUsageNote, /不得无条件用作神经网络监督学习/, `${r.id} 必须携带监督使用警告`);
  }
});

test('P1-3 数据接口：私有层必须显式声明评估器用途才可读取', () => {
  assert.throws(() => loadPrivateOracle(SCEN_ROOT, { purpose: null }), /评估器|purpose/);
  assert.throws(() => loadPrivateOracle(SCEN_ROOT, { purpose: 'AI 训练输入' }), /评估器/);
  assert.doesNotThrow(() => loadPrivateOracle(SCEN_ROOT, { purpose: 'oracle 复算' }));
});
