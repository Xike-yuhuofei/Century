/** 信息公平性测试（任务书第四节·不可妥协约束）。
 * 1) 隐藏牌库顺序随机化不变性：公开信息一致时，AI 决策必须一致。
 * 2) 观察对象纯度：AIObservation 不得包含任何隐藏牌库数据，且为深度冻结。
 * 3) 静态扫描：src/ai/** 源码对隐藏字段的引用必须为零。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { createGame, applyAction } from '../dist/js/engine.js';
import { chooseAIAction, buildObservation, CHAMPION_PARAMETERS } from '../dist/js/ai.js';

const shuffle = (array, random) => {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

const mulberry32 = seed => {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6D2B79F5) | 0;
    let t = Math.imul(value ^ (value >>> 15), 1 | value);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/** 构造若干真实中局位置（全 AI 推进若干步），返回深拷贝。 */
function midgamePositions(count) {
  const positions = [];
  for (let seed = 1; seed <= 6 && positions.length < count; seed++) {
    let g = createGame(['A', 'B', 'C', 'D', 'E'], seed, [1, 2, 3, 4]);
    g.players[0].isAI = true;
    let moves = 0;
    while (g.phase !== 'finished' && moves < 400 && positions.length < count) {
      if (g.phase === 'turn' && g.turnNumber % 7 === 3 && g.players[g.current].claimed.length === 0) {
        positions.push(JSON.parse(JSON.stringify(g)));
      }
      const { action } = chooseAIAction(g);
      g = applyAction(g, action);
      moves++;
    }
  }
  return positions;
}

test('随机化隐藏牌库顺序不改变 AI 决策（多位置 × 多种打乱方式）', () => {
  const positions = midgamePositions(12);
  assert.ok(positions.length >= 8, `采集中局位置不足：${positions.length}`);
  for (let pi = 0; pi < positions.length; pi++) {
    const base = positions[pi];
    const baseDecision = chooseAIAction(base);
    for (let variant = 1; variant <= 4; variant++) {
      const shuffled = JSON.parse(JSON.stringify(base));
      const random = mulberry32(pi * 100 + variant);
      shuffled.merchantDeck = shuffle(shuffled.merchantDeck, random);
      shuffled.golemDeck = shuffle(shuffled.golemDeck, random);
      const decision = chooseAIAction(shuffled);
      assert.deepEqual(
        decision.action, baseDecision.action,
        `位置 ${pi} 变体 ${variant}：隐藏牌库顺序改变不应影响决策`,
      );
      assert.deepEqual(decision.plan?.actions, baseDecision.plan?.actions);
    }
  }
});

test('AIObservation 纯度：不含隐藏牌库字段且深度冻结', () => {
  const g = createGame(['A', 'B', 'C', 'D', 'E'], 42, [1, 2, 3, 4]);
  g.players[0].isAI = true;
  const view = buildObservation(g);
  const serialized = JSON.stringify(view);
  assert.equal(serialized.includes('merchantDeck'), false);
  assert.equal(serialized.includes('golemDeck'), false);
  // 冻结校验：观察及嵌套对象均不可变。
  assert.equal(Object.isFrozen(view), true);
  assert.equal(Object.isFrozen(view.players), true);
  assert.equal(Object.isFrozen(view.players[0]), true);
  assert.equal(Object.isFrozen(view.players[0].stock), true);
  assert.equal(Object.isFrozen(view.merchantMarket[0]), true);
  // 席位越权观察：非当前席位也可以构造观察（训练诊断用），但同样不含隐藏字段。
  const other = buildObservation(g, 2);
  assert.equal(JSON.stringify(other).includes('merchantDeck'), false);
});

test('静态扫描：AI 决策源码对隐藏牌库字段的引用必须为零', () => {
  const aiDir = new URL('../src/ai/', import.meta.url);
  const files = readdirSync(aiDir).filter(f => f.endsWith('.ts'));
  assert.ok(files.length >= 6, `AI 模块数量异常：${files.join(',')}`);
  const forbidden = /\.merchantDeck|\.golemDeck|game\.merchantDeck|game\.golemDeck/;
  for (const file of files) {
    const source = readFileSync(new URL(`../src/ai/${file}`, import.meta.url));
    assert.equal(
      forbidden.test(source), false,
      `${file} 引用了隐藏牌库字段，违反信息公平性约束`,
    );
  }
});

test('决策不修改输入局面且与冠军参数显式传入结果一致', () => {
  const positions = midgamePositions(5);
  for (const original of positions) {
    const snapshot = JSON.stringify(original);
    const implicit = chooseAIAction(original);
    assert.equal(JSON.stringify(original), snapshot, 'chooseAIAction 不得修改输入局面');
    const explicit = chooseAIAction(original, { parameters: CHAMPION_PARAMETERS });
    assert.deepEqual(implicit.action, explicit.action);
  }
});

test('冠军参数与训练系统冠军记录一致（审计整改：防止真正晋级后测试误报）', () => {
  // 此前本文件要求"默认冠军决策与基线一致"——初始冠军恰为基线时成立，
  // 一旦真正晋级非中性参数就会误报。正确的不变量是：
  // CHAMPION_PARAMETERS 必须与 training/champions/champion.json 逐字段一致。
  const record = JSON.parse(readFileSync(new URL('../../training/champions/champion.json', import.meta.url), 'utf8'));
  const recorded = record.parameters ?? record;
  assert.equal(CHAMPION_PARAMETERS.id, recorded.id, '冠军 id 必须与冠军记录一致');
  for (const [key, value] of Object.entries(recorded)) {
    if (key === 'id') continue;
    assert.equal(CHAMPION_PARAMETERS[key], value, `冠军参数 ${key} 必须与冠军记录一致`);
  }
});
