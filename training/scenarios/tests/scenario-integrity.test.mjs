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
