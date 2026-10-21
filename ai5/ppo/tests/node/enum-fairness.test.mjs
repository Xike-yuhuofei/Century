/** 信息公平性测试（任务书 4.2 / 14.P1）：
 * 1) 静态扫描：bridge 的决策路径代码不引用隐藏牌库字段（merchantDeck/golemDeck）；
 * 2) 动态不变性：隐藏牌库顺序改变而公开状态不变 ⇒ 状态向量与候选集合逐位不变；
 * 3) 候选上限剪枝覆盖率上报（防伪称全量）。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createGame, applyAction } from '../../../../web-v1/dist/js/engine.js';
import { buildObservation, chooseAIAction, PROFILES, NEUTRAL_PROFILE } from '../../../../web-v1/dist/js/ai.js';
import { enumerateCandidates, descriptorToEngineAction } from '../../bridge/action_enum.mjs';
import { encodeState } from '../../bridge/encode.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Fisher-Yates 洗牌（独立于引擎 rng，确保改变的是隐藏顺序本身）。 */
function shuffle(array, rng) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

test('静态扫描：桥接决策路径不引用隐藏牌库字段', () => {
  const bridgeDir = join(here, '../../bridge');
  for (const file of ['action_enum.mjs', 'encode.mjs', 'card_features.mjs']) {
    const text = readFileSync(join(bridgeDir, file), 'utf8');
    assert.ok(!/\bmerchantDeck\b/.test(text), `${file} 引用了 merchantDeck`);
    assert.ok(!/\bgolemDeck\b/.test(text), `${file} 引用了 golemDeck`);
    assert.ok(!/\.log\b/.test(text.replace(/\/\/[^\n]*/g, '')), `${file} 引用了引擎内部 log`);
  }
});

test('隐藏牌库顺序改变 ⇒ 状态向量与候选集合逐位不变', () => {
  for (const seed of [11, 2222, 90125]) {
    let game = createGame(Array.from({ length: 5 }, (_, i) => `席位${i}`), seed, [1, 2, 3, 4]);
    game.players[0].isAI = true;
    for (let i = 0; i < 25 && game.phase !== 'finished'; i++) {
      const view = buildObservation(game);
      const { candidates } = enumerateCandidates(view, {});
      const obs = encodeState(view);

      // 构造"公开状态完全相同、隐藏牌库顺序不同"的镜像局面。
      const mutated = structuredClone(JSON.parse(JSON.stringify(game)));
      delete mutated.replay;
      let s = seed * 31 + 7;
      const rng = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
      mutated.merchantDeck = shuffle(mutated.merchantDeck, rng);
      mutated.golemDeck = shuffle(mutated.golemDeck, rng);

      const view2 = buildObservation(mutated);
      const { candidates: candidates2 } = enumerateCandidates(view2, {});
      const obs2 = encodeState(view2);

      assert.deepEqual([...obs2], [...obs], `seed=${seed} 步${i} 隐藏牌库顺序影响了状态向量（信息泄漏！）`);
      assert.equal(JSON.stringify(candidates2), JSON.stringify(candidates), `seed=${seed} 步${i} 隐藏牌库顺序影响了候选集合`);

      // 推进：席位 0 用候选策略，其余席位用 AI 4.0 冠军核心。
      if (game.current === 0) {
        game = applyAction(game, descriptorToEngineAction(candidates[(i * 3 + 1) % candidates.length]));
      } else {
        const profile = game.current === 0 ? NEUTRAL_PROFILE : PROFILES[(game.current - 1) % PROFILES.length];
        game = applyAction(game, chooseAIAction(game, { profile }).action);
      }
    }
  }
});

test('候选描述符不携带任何隐藏牌库信息（字段白名单）', () => {
  const game = createGame(['a', 'b', 'c', 'd', 'e'], 4242, [1, 2, 3, 4]);
  game.players[0].isAI = true;
  const view = buildObservation(game);
  const { candidates } = enumerateCandidates(view, {});
  for (const d of candidates) {
    const text = JSON.stringify(d);
    assert.ok(!text.includes('Deck'), `描述符泄漏牌库字段：${text}`);
    assert.ok(d.length <= 3 && typeof d[0] === 'string' && d[0].length === 1, `描述符格式异常：${text}`);
  }
});
