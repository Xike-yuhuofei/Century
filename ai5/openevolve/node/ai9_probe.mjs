/** AI 9.0 多模块行为探针：在公开 fixture 上比较候选与官方模块输出。
 *
 * 作用：
 * - 证明候选代码可加载、可调用、输出有限；
 * - 区分"编译通过但行为等同官方"（identical_to_official）与真实行为变化；
 * - 为每个模块提供独立回归证据（M01–M12）。
 *
 * 信息边界：fixture 只来自正式引擎创建的公开观察与公开卡牌全集；不读取牌库顺序，
 * 不写文件到 fixture 目录之外。
 *
 * 用法：node ai9_probe.mjs --candidate <dist/js> --out <json> [--modules M01,M02]
 */
import { writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  moduleRegistry, getModule, sha256, clampNumber,
} from './module_registry.mjs';
import { REPO_ROOT } from './module_registry.mjs';

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const candidateRoot = arg('candidate');
const outPath = arg('out');
const requested = arg('modules') ? String(arg('modules')).split(',').map(s => s.trim()).filter(Boolean) : null;
if (!candidateRoot || !outPath) { console.error('用法: node ai9_probe.mjs --candidate <dist/js> --out <json>'); process.exit(2); }

const OFFICIAL_ROOT = join(REPO_ROOT, 'web-v1/dist/js');
const CHAMPION = JSON.parse(
  (await import('node:fs')).readFileSync(join(REPO_ROOT, 'training/champions/champion.json'), 'utf8'),
).parameters;

async function loadModules(root) {
  const data = await import(pathToFileURL(join(root, 'data.js')).href);
  const engine = await import(pathToFileURL(join(root, 'engine.js')).href);
  const ai = await import(pathToFileURL(join(root, 'ai.js')).href);
  const files = {
    'ai/evolve/modules.ts': await import(pathToFileURL(join(root, 'ai/evolve/modules.js')).href),
    'ai/evaluator.ts': await import(pathToFileURL(join(root, 'ai/evaluator.js')).href),
    'ai/knowledge.ts': await import(pathToFileURL(join(root, 'ai/knowledge.js')).href),
  };
  return { data, engine, ai, files };
}

function observationFixtures(official) {
  const fixtures = [];
  for (const seatCount of [2, 5]) {
    for (let i = 0; i < 2; i++) {
      const seed = 1_650_002_000 + seatCount * 10 + i;
      const game = official.engine.createGame(
        Array.from({ length: seatCount }, (_, k) => `S${k}`), seed,
        Array.from({ length: seatCount - 1 }, (_, k) => k + 1),
      );
      game.players[0].isAI = true;
      for (let seat = 0; seat < seatCount; seat++) {
        fixtures.push({
          name: `${seatCount}p-seat${seat}-seed${seed}`,
          view: official.ai.buildObservation(game, seat),
        });
      }
    }
  }
  return fixtures;
}

function stateOf(view) {
  const me = view.players[view.playerId];
  return { stock: me.stock, hand: [...me.hand], played: [...me.played] };
}

function unseenMerchants(view, data) {
  const known = new Set(view.merchantMarket.map(x => x.id));
  for (const p of view.players) for (const id of [...p.hand, ...p.played]) known.add(id);
  return data.MERCHANT_DECK.filter(c => !known.has(c.id)).map(c => c.id);
}

function makeCases(moduleId, ctx) {
  const { fixture, data } = ctx;
  const view = fixture.view;
  const me = view.players[view.playerId];
  const preferred = view.golemMarket[0] ?? null;
  const marketCard = view.merchantMarket[0]?.id ?? data.MERCHANT_DECK[0].id;
  const state = stateOf(view);
  const pressure = { mean: {}, peak: {} };
  for (const m of view.merchantMarket) { pressure.mean[m.id] = 0.3; pressure.peak[m.id] = 0.5; }
  const base = { fixture: fixture.name, args: null };
  switch (moduleId) {
    case 'M01':
      return view.golemMarket.map(id => ({ ...base, label: `goal=${id}`, args: [view, id, CHAMPION] }));
    case 'M02':
      return view.merchantMarket.map(m => ({
        ...base, label: `card=${m.id}`,
        args: [state, m.id, preferred, { engine: 1, contest: 1 }, pressure, CHAMPION, null],
      }));
    case 'M03': {
      const kinds = ['create', 'upgrade', 'trade'];
      return kinds.map(kind => {
        const card = data.MERCHANT_DECK.find(c => c.kind === kind) ?? data.MERCHANT_DECK[0];
        return {
          ...base, label: `${kind}:${card.id}`,
          args: [card, me.stock, preferred ? data.GOLEM_BY_ID[preferred] : null],
        };
      });
    }
    case 'M04':
      return [{ ...base, label: 'keep', args: [me.stock, view.golemMarket, preferred, CHAMPION] }];
    case 'M05':
      return [
        { ...base, label: 'rest-played', args: [{ ...state, golemMarket: view.golemMarket, steps: 3, terminal: false, played: [marketCard] }, preferred, CHAMPION] },
        { ...base, label: 'rest-empty', args: [{ ...state, hand: [], played: [], golemMarket: view.golemMarket, steps: 6, terminal: false }, preferred, CHAMPION] },
      ];
    case 'M06':
      return [
        { ...base, label: 'terminal-true', args: [{ ...state, golemMarket: view.golemMarket, steps: 9, terminal: true }, CHAMPION] },
        { ...base, label: 'terminal-false', args: [{ ...state, golemMarket: view.golemMarket, steps: 9, terminal: false }, CHAMPION] },
      ];
    case 'M07':
      return view.merchantMarket.flatMap(m => ([
        { ...base, label: `${m.id}-mean`, args: [view, m.id, 'mean', CHAMPION] },
        { ...base, label: `${m.id}-peak`, args: [view, m.id, 'peak', CHAMPION] },
      ]));
    case 'M08':
      return view.golemMarket.map(id => ({ ...base, label: `goal=${id}`, args: [view, id, CHAMPION] }));
    case 'M09':
      return [{
        ...base, label: 'unseen',
        args: [view, preferred, unseenMerchants(view, data), CHAMPION],
      }];
    case 'M10': {
      const actions = [
        { type: 'rest' },
        { type: 'claim', index: 0 },
        ...(me.hand.length ? [{ type: 'play', cardId: me.hand[0] }] : []),
        ...(view.merchantMarket.length ? [{ type: 'acquire', index: 0, payment: [] }] : []),
      ];
      return [{ ...base, label: 'rank', args: [view, actions, CHAMPION] }];
    }
    case 'M11':
      return [{ ...base, label: 'policy', args: [view, {}, CHAMPION] }];
    case 'M12':
      return [{ ...base, label: 'budget', args: [view, 100, CHAMPION] }];
    default:
      throw new Error(`探针缺少模块用例：${moduleId}`);
  }
}

function assertFinite(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`非有限输出：${value}`);
    return;
  }
  if (Array.isArray(value)) { for (const item of value) assertFinite(item); return; }
  if (value && typeof value === 'object') { for (const item of Object.values(value)) assertFinite(item); }
}

function normalize(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Number(value.toFixed(6)) : String(value);
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
}

const official = await loadModules(OFFICIAL_ROOT);
const candidate = await loadModules(candidateRoot);
const registry = moduleRegistry();
const moduleIds = requested ?? registry.modules.map(m => m.id);
const fixtures = observationFixtures(official);

const rows = [];
const moduleSummaries = {};
let probeErrors = 0;
for (const moduleId of moduleIds) {
  const module = getModule(moduleId, registry);
  const officialFn = official.files[module.file]?.[module.functionName];
  const candidateFn = candidate.files[module.file]?.[module.functionName];
  if (typeof officialFn !== 'function' || typeof candidateFn !== 'function') {
    throw new Error(`${moduleId} 函数导出缺失：official=${typeof officialFn} candidate=${typeof candidateFn}`);
  }
  let cases = 0;
  let mismatches = 0;
  let errors = 0;
  const moduleRows = [];
  for (const fixture of fixtures) {
    for (const testCase of makeCases(moduleId, { fixture, data: official.data })) {
      cases += 1;
      let officialValue = null;
      let candidateValue = null;
      let error = null;
      try { officialValue = normalize(officialFn(...testCase.args)); assertFinite(officialValue); }
      catch (e) { error = `official:${e.message}`; }
      try { candidateValue = normalize(candidateFn(...testCase.args)); assertFinite(candidateValue); }
      catch (e) { error = `${error ? `${error};` : ''}candidate:${e.message}`; }
      if (error) { errors += 1; probeErrors += 1; }
      const same = !error && JSON.stringify(officialValue) === JSON.stringify(candidateValue);
      if (!same && !error) mismatches += 1;
      moduleRows.push({
        fixture: testCase.fixture, label: testCase.label,
        official: officialValue, candidate: candidateValue,
        same, error,
      });
    }
  }
  moduleSummaries[moduleId] = {
    functionName: module.functionName,
    file: module.file,
    cases,
    mismatches,
    errors,
    identicalToOfficial: errors === 0 && mismatches === 0,
  };
  rows.push(...moduleRows.map(row => ({ moduleId, ...row })));
}

const output = {
  ok: probeErrors === 0,
  candidateRoot,
  officialRoot: OFFICIAL_ROOT,
  modules: moduleSummaries,
  cases: rows.length,
  probeErrors,
  mismatchCount: rows.filter(r => !r.same && !r.error).length,
  identicalToOfficial: rows.length > 0 && rows.every(r => r.same),
  changedModules: Object.entries(moduleSummaries).filter(([, s]) => !s.identicalToOfficial).map(([id]) => id),
  sample: rows.filter(r => !r.same || r.error).slice(0, 24),
  fixtureSeeds: [1_650_002_020, 1_650_002_021, 1_650_002_050, 1_650_002_051],
};
output.probeSha256 = sha256(JSON.stringify({ modules: moduleSummaries, mismatchCount: output.mismatchCount, probeErrors }));
writeFileSync(outPath, JSON.stringify(output, null, 2));
console.log(JSON.stringify({
  ok: output.ok,
  modules: moduleSummaries,
  changedModules: output.changedModules,
  mismatchCount: output.mismatchCount,
  probeErrors,
}));
process.exit(output.ok ? 0 : 1);
