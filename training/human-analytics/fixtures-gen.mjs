/** 合成对局生成器（测试管线专用，数据来源明确标注为 AI 模拟）。
 *
 * 用途：没有真实人类对局文件时，为导入/分析/报告管线提供合规测试数据。
 * 生成方式：正式引擎（web-v1/dist/js/engine.js）createGame 固定种子 +
 * 一个确定性脚本化合法策略（非正式冠军 AI），导出使用正式导出函数
 * replayJSON（与网页 PR #28 自动导出完全同格式）。
 *
 * 诚实性约束：本生成器产物一律标注 provenance=simulated-scripted，
 * 在 fixtures 文件名与报告「数据来源」一节可见；不得冒充真人数据。
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadEngine } from './engine-link.mjs';

const NAMES = ['玩家甲', '玩家乙', '玩家丙', '玩家丁', '玩家戊'];

function chooseDiscardColors(stock, excess) {
  // 确定性弃置：优先弃黄（终局不计分），再按绿→蓝→粉从多到少
  const colors = [];
  const piles = [...stock];
  const order = [0, 1, 2, 3].sort((a, b) => piles[b] - piles[a] || a - b);
  let left = excess;
  for (const c of order) {
    while (piles[c] > 0 && left > 0) { piles[c]--; colors.push(c); left--; }
    if (!left) break;
  }
  return colors;
}

function upgradeSteps(stock, maxSteps) {
  // 确定性升级：优先升黄→绿，再绿→蓝；至少 1 步才返回非空
  const steps = [];
  const s = [...stock];
  for (let i = 0; i < maxSteps; i++) {
    let src = -1;
    for (const c of [0, 1, 2]) { if (s[c] > 0) { src = c; break; } }
    if (src < 0) break;
    steps.push(src); s[src]--; s[src + 1]++;
  }
  return steps;
}

function chooseAcquirePayment(stock, count) {
  // 支付 count 颗：优先黄，再绿、蓝、粉
  const payment = [];
  const s = [...stock];
  for (const c of [0, 1, 2, 3]) {
    while (s[c] > 0 && payment.length < count) { s[c]--; payment.push(c); }
    if (payment.length >= count) break;
  }
  return payment;
}

/** 脚本化策略：能认领先认领（分高优先），否则打出引擎卡，否则取卡（浅位优先），否则休息。 */
function scriptedAction(engine, data, g) {
  const { count, tradeLimit } = engine;
  const p = g.players[g.current];
  if (g.phase === 'overflow') {
    const excess = count(p.stock) - 10;
    return { type: 'discard', colors: chooseDiscardColors(p.stock, excess) };
  }
  const claimable = engine.legalClaimIndices(g);
  if (claimable.length) {
    let best = claimable[0];
    for (const i of claimable) {
      const pts = data.GOLEM_BY_ID[g.golemMarket[i]].points;
      const bestPts = data.GOLEM_BY_ID[g.golemMarket[best]].points;
      if (pts > bestPts || (pts === bestPts && i < best)) best = i;
    }
    return { type: 'claim', index: best };
  }
  for (const cardId of p.hand) {
    const card = data.MERCHANT_BY_ID[cardId];
    if (!card) continue;
    if (card.kind === 'create') return { type: 'play', cardId };
    if (card.kind === 'trade') {
      const limit = tradeLimit(p.stock, cardId);
      if (limit >= 1) return { type: 'play', cardId, repeats: Math.min(3, limit) };
    }
    if (card.kind === 'upgrade') {
      const steps = upgradeSteps(p.stock, card.steps ?? 0);
      if (steps.length >= 1) return { type: 'play', cardId, steps };
    }
  }
  for (let index = 0; index < g.merchantMarket.length; index++) {
    if (count(p.stock) >= index) return { type: 'acquire', index, payment: chooseAcquirePayment(p.stock, index) };
  }
  return { type: 'rest' };
}

/** 生成一局完整对局导出（与网页导出同格式）。
 * @param {number} seatCount 2–5
 * @param {number} seed
 * @param {{maxTurns?: number}} opts maxTurns 截断可产生「未完成」对局
 */
export async function simulateGame(seatCount, seed, opts = {}) {
  const { engine, data, replay } = await loadEngine();
  const maxTurns = opts.maxTurns ?? 500;
  const names = NAMES.slice(0, seatCount);
  let g = engine.createGame(names, seed, []);
  let turns = 0;
  while (g.phase !== 'finished' && turns < maxTurns) {
    g = engine.applyAction(g, scriptedAction(engine, data, g));
    turns++;
  }
  if (g.phase !== 'finished' && opts.requireFinished) throw new Error(`seed=${seed} ${seatCount}p 对局未在 ${maxTurns} 手内结束`);
  const coverage = replay.replayCoverage(g);
  const json = replay.replayJSON(g);
  const parsed = JSON.parse(json);
  // 诚实性来源戳：本工具定义的可选扩展字段；真实网页导出没有此字段。
  parsed.provenance = {
    kind: 'simulated-scripted',
    generator: 'training/human-analytics/fixtures-gen.mjs',
    note: 'AI 模拟对局（正式引擎 + 脚本化合法策略，非正式冠军 AI），非真人数据',
    seed,
  };
  return { game: g, coverage, json: parsed, finished: g.phase === 'finished' };
}

/** 生成旧存档样例（replay=null：无回合记录，仅终态）。 */
export async function simulateLegacyGame(seatCount, seed, turnsToRun = 12) {
  const { engine, data, replay } = await loadEngine();
  const names = NAMES.slice(0, seatCount);
  let g = engine.createGame(names, seed, []);
  for (let i = 0; i < turnsToRun && g.phase !== 'finished'; i++) g = engine.applyAction(g, scriptedAction(engine, data, g));
  return {
    format: 'century-replay',
    version: 1,
    coverage: replay.replayCoverage(g),
    replay: null,
    current: { ...g, replay: undefined },
    provenance: {
      kind: 'simulated-scripted',
      generator: 'training/human-analytics/fixtures-gen.mjs',
      note: 'AI 模拟对局（正式引擎 + 脚本化合法策略，非正式冠军 AI），非真人数据',
      seed,
    },
  };
}

/** 批量生成 fixtures 目录（供验收测试与示例使用）。 */
export async function generateFixtures(outDir) {
  mkdirSync(outDir, { recursive: true });
  const made = [];
  const plans = [
    ['2p', 2, 101], ['3p', 3, 202], ['4p', 4, 303], ['5p', 5, 404],
    ['3p-unfinished', 3, 505, { maxTurns: 25 }],
  ];
  for (const [tag, seats, seed, opts] of plans) {
    const sim = await simulateGame(seats, seed, opts);
    const file = resolve(outDir, `sim-scripted-${tag}-seed${seed}.json`);
    writeFileSync(file, JSON.stringify(sim.json, null, 2));
    made.push({ file, tag, seats, finished: sim.finished, turns: sim.json.replay.turns.length });
  }
  const legacy = await simulateLegacyGame(3, 606);
  const legacyFile = resolve(outDir, 'sim-scripted-3p-legacy-seed606.json');
  writeFileSync(legacyFile, JSON.stringify(legacy, null, 2));
  made.push({ file: legacyFile, tag: '3p-legacy', seats: 3, finished: false, turns: 0 });
  return made;
}

// CLI：node fixtures-gen.mjs --out <dir>
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argOut = process.argv.includes('--out') ? resolve(process.argv[process.argv.indexOf('--out') + 1]) : resolve(import.meta.dirname, 'fixtures');
  generateFixtures(argOut).then(made => {
    for (const m of made) console.log(`[simulated-scripted] ${m.tag} ${m.seats}p turns=${m.turns} finished=${m.finished} → ${m.file}`);
  }).catch(e => { console.error(e); process.exit(1); });
}
