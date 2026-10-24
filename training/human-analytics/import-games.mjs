/** 任务 A：对局数据导入（schema 校验 / 合法性验证 / 完成状态 / 去重 / 元数据 / 异常报告）。
 *
 * 输入格式唯一权威来源：web-v1/src/replay.ts 的 replayJSON()（PR #28 自动导出）。
 * 结构：
 *   { format: 'century-replay', version: 1, coverage: string,
 *     replay: { version: 1, fromStart: boolean,
 *               initial: <Game 不含 replay>,       // 含 merchantDeck/golemDeck（隐藏信息，仅内部重放用）
 *               turns: [ { turnNumber, round, playerTurn, playerId, cardId?, actions[1..2],
 *                          before: Player, after: Player, completed, triggersEnd } ] },
 *     current: <Game 不含 replay> }               // 对局终态快照（含所有人手牌与剩余牌库，属隐藏信息）
 *
 * 验证分两层：
 *   1) 结构校验：镜像 web-v1 validateReplay 的判据（本工具侧独立实现，只读）；
 *   2) 引擎重放校验：用正式引擎从 initial 逐手重放 actions，逐回合比对
 *      before/after 玩家状态与 cardId；终态与 current 比对（牌库序、市场、钱币）。
 *
 * 隐藏信息纪律：initial/current 中的 merchantDeck、golemDeck 与手牌仅用于内部
 * 重放与一致性校验；任何输出（指标/案例/报告）都不得包含，cases.mjs 有泄漏检查。
 */

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { loadEngine } from './engine-link.mjs';

export const SUPPORTED_MIN_PLAYERS = 2;
export const SUPPORTED_MAX_PLAYERS = 5; // 6 人为非官方扩展，超出验收范围，明确拒绝

const COLOR_NAMES = ['黄', '绿', '蓝', '粉'];

// ---------- 基础工具 ----------

/** 确定性序列化：键排序，数组保序。用于哈希与深度比较。 */
export function canonicalStringify(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const deepEqual = (a, b) => canonicalStringify(a) === canonicalStringify(b);

/** 记录身份哈希：initial + turns 决定一局（current 是派生快照，不参与）。 */
export function recordHash(record) {
  return createHash('sha256').update(canonicalStringify({ initial: record.replay.initial, turns: record.replay.turns })).digest('hex');
}

// ---------- 结构校验（判据镜像 web-v1 validateReplay，独立只读实现） ----------

function validateStructural(record, data, anomalies) {
  const error = (code, message) => anomalies.push({ level: 'error', code, message });
  if (!record || typeof record !== 'object') { error('not-object', '顶层不是 JSON 对象'); return false; }
  if (record.format !== 'century-replay') { error('bad-format', `format 应为 'century-replay'，实际 ${JSON.stringify(record.format ?? null)}`); return false; }
  if (record.version !== 1) { error('bad-version', `导出版本应为 1，实际 ${JSON.stringify(record.version ?? null)}`); return false; }
  if (typeof record.coverage !== 'string') error('bad-coverage', 'coverage 缺失或不是字符串');
  if (!record.replay || typeof record.replay !== 'object') {
    error('no-replay', 'replay 为 null：旧存档无回合记录，无法做逐手分析（仅可看终态）');
    return false;
  }
  const r = record.replay;
  if (r.version !== 1) { error('bad-replay-version', `replay.version 应为 1，实际 ${JSON.stringify(r.version ?? null)}`); return false; }
  if (typeof r.fromStart !== 'boolean') { error('bad-from-start', 'replay.fromStart 缺失或不是布尔值'); return false; }
  if (r.initial && 'replay' in r.initial) error('nested-replay', 'initial 内不应再嵌套 replay');
  if (!r.initial || typeof r.initial !== 'object') { error('no-initial', 'replay.initial 缺失'); return false; }
  if (!Array.isArray(r.turns)) { error('no-turns', 'replay.turns 缺失或不是数组'); return false; }

  const init = r.initial;
  if (!Number.isSafeInteger(init.turnNumber) || init.turnNumber <= 0) { error('bad-initial-turn', `initial.turnNumber 非法：${JSON.stringify(init.turnNumber)}`); return false; }
  if (r.fromStart && init.turnNumber !== 1) error('from-start-not-1', `fromStart=true 但 initial.turnNumber=${init.turnNumber}`);
  if (!Array.isArray(init.players) || init.players.length === 0) { error('no-players', 'initial.players 缺失'); return false; }

  const n = init.players.length;
  if (n < SUPPORTED_MIN_PLAYERS || n > SUPPORTED_MAX_PLAYERS) {
    error('unsupported-players', `不支持 ${n} 人对局（本工具验收范围 ${SUPPORTED_MIN_PLAYERS}–${SUPPORTED_MAX_PLAYERS} 人；6 人为非官方扩展）`);
    return false;
  }

  const integer = v => Number.isSafeInteger(v) && v >= 0;
  const stockOk = s => Array.isArray(s) && s.length === 4 && s.every(integer);
  const idsOk = (a, catalog) => Array.isArray(a) && a.every(id => typeof id === 'string' && Object.hasOwn(catalog, id));
  const playerOk = (p, where) => {
    if (!p || typeof p !== 'object') { error('bad-player', `${where}：玩家不是对象`); return false; }
    const checks = [
      [integer(p.id) && p.id < n, `id 非法（须 0..${n - 1}）：${JSON.stringify(p.id)}`],
      [typeof p.name === 'string' && p.name.length <= 20, `name 非法：${JSON.stringify(p.name ?? null)}`],
      [stockOk(p.stock), `stock 非法（须为 4 元非负整数数组）：${JSON.stringify(p.stock)}`],
      [integer(p.copper) && integer(p.silver), `铜/银币数非法：${JSON.stringify([p.copper, p.silver])}`],
      [integer(p.turns), `turns 非法：${JSON.stringify(p.turns)}`],
      [idsOk(p.hand, data.MERCHANT_BY_ID), 'hand 含未知商人卡'],
      [idsOk(p.played, data.MERCHANT_BY_ID), 'played 含未知商人卡'],
      [idsOk(p.claimed, data.GOLEM_BY_ID), 'claimed 含未知魔像'],
    ];
    const bad = checks.find(([ok]) => !ok);
    if (bad) { error('bad-player-field', `${where}（座位 ${p.id ?? '?'}）：${bad[1]}`); return false; }
    return true;
  };

  let ok = init.players.every((p, i) => playerOk(p, `initial.players[${i}]`));
  if (!Array.isArray(init.log) || !init.log.every(l => typeof l === 'string')) { error('bad-log', 'initial.log 缺失或含非字符串'); ok = false; }
  if (!idsOk(init.golemMarket, data.GOLEM_BY_ID)) { error('bad-golem-market', 'initial.golemMarket 含未知魔像'); ok = false; }
  const marketOk = Array.isArray(init.merchantMarket) && init.merchantMarket.every(m =>
    m && Object.hasOwn(data.MERCHANT_BY_ID, m.id) && Array.isArray(m.bonus) && m.bonus.length === 4 && m.bonus.every(integer));
  if (!marketOk) { error('bad-merchant-market', 'initial.merchantMarket 非法（id 未知或 bonus 非 4 元非负数组）'); ok = false; }

  const turns = r.turns;
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const where = `turns[${i}]`;
    if (!t || typeof t !== 'object') { error('bad-turn', `${where}：不是对象`); ok = false; continue; }
    if (!Number.isSafeInteger(t.turnNumber) || t.turnNumber < init.turnNumber) { error('bad-turn-number', `${where}.turnNumber 非法或早于记录起点：${JSON.stringify(t.turnNumber)}`); ok = false; continue; }
    if (i > 0 && !(t.turnNumber > turns[i - 1].turnNumber)) { error('turn-order', `${where}.turnNumber=${t.turnNumber} 未严格递增（前一条 ${turns[i - 1].turnNumber}）`); ok = false; }
    const expectedRound = Math.floor((t.turnNumber - 1) / n) + 1;
    if (t.round !== expectedRound) { error('bad-round', `${where}.round=${JSON.stringify(t.round)}，按 ${n} 人应为 ${expectedRound}`); ok = false; }
    if (!Number.isSafeInteger(t.playerTurn) || t.playerTurn <= 0) { error('bad-player-turn', `${where}.playerTurn 非法：${JSON.stringify(t.playerTurn)}`); ok = false; }
    if (!Number.isSafeInteger(t.playerId) || t.playerId < 0 || t.playerId >= n) { error('bad-seat', `${where}.playerId 非法：${JSON.stringify(t.playerId)}`); ok = false; continue; }
    const playerFine = playerOk(t.before, `${where}.before`) & playerOk(t.after, `${where}.after`);
    if (!playerFine) { ok = false; continue; }
    if (t.before.id !== t.playerId || t.after.id !== t.playerId) { error('seat-mismatch', `${where}.before/after 的 id 与 playerId=${t.playerId} 不一致`); ok = false; }
    if (t.playerTurn !== t.before.turns + 1) { error('player-turn-mismatch', `${where}.playerTurn=${t.playerTurn} 与 before.turns+1=${t.before.turns + 1} 不符`); ok = false; }
    if (typeof t.completed !== 'boolean' || typeof t.triggersEnd !== 'boolean') { error('bad-flags', `${where}.completed/triggersEnd 须为布尔`); ok = false; }
    if (!Array.isArray(t.actions) || t.actions.length < 1 || t.actions.length > 2) { error('bad-actions', `${where}.actions 长度须为 1–2：${JSON.stringify(t.actions?.length)}`); ok = false; continue; }
    for (const a of t.actions) {
      const colors = (arr, max = 3) => Array.isArray(arr) && arr.every(c => integer(c) && c <= max);
      let actOk = false;
      if (a && a.type === 'rest') actOk = true;
      else if (a && a.type === 'discard') actOk = colors(a.colors);
      else if (a && a.type === 'acquire') actOk = Number.isSafeInteger(a.index) && a.index >= 0 && a.index < 6 && colors(a.payment) && a.payment.length === a.index;
      else if (a && a.type === 'claim') actOk = Number.isSafeInteger(a.index) && a.index >= 0 && a.index < 5;
      else if (a && a.type === 'play') actOk = Object.hasOwn(data.MERCHANT_BY_ID, a.cardId) && (a.steps === undefined || colors(a.steps, 2)) && (a.repeats === undefined || Number.isSafeInteger(a.repeats) && a.repeats >= 1 && a.repeats <= 10);
      if (!actOk) { error('bad-action', `${where} 含非法行动：${canonicalStringify(a).slice(0, 200)}`); ok = false; }
    }
    for (const a of t.actions) {
      if (a.type !== 'claim' && a.type !== 'acquire') continue;
      const catalog = a.type === 'claim' ? data.GOLEM_BY_ID : data.MERCHANT_BY_ID;
      if (!(typeof t.cardId === 'string' && Object.hasOwn(catalog, t.cardId))) { error('bad-card-id', `${where}：${a.type} 行动缺少合法 cardId（${JSON.stringify(t.cardId)}）`); ok = false; }
    }
    // 连续性约束：上一手与当前手若同 turnNumber 同席位，则上一手必然未完成（等待弃置）。
    const prev = turns[i - 1];
    if (prev && prev.turnNumber === t.turnNumber) {
      if (prev.playerId !== t.playerId || prev.completed !== false || t.actions[0]?.type !== 'discard') {
        error('continuation-invalid', `${where}：同 turnNumber 续手必须同席位、上一手 completed=false 且本手以 discard 开头`);
        ok = false;
      }
    }
  }
  if (Array.isArray(record.current?.players) && record.current.players.length !== n) {
    error('current-players-mismatch', `current.players=${record.current.players.length} 与 initial ${n} 人不一致`);
    ok = false;
  }
  return ok;
}

// ---------- 引擎重放验证 + 公开时间线重建 ----------

/** 用正式引擎从 initial 重放全部行动；返回 {ok, game(终局), timeline}。
 * timeline[i] = 第 i 条 recorded turn 行动前的公开市场快照（内部重建用，
 * 输出前由 cases.mjs 剥离隐藏字段）。
 */
async function replayVerify(record, anomalies) {
  const { engine } = await loadEngine();
  const r = record.replay;
  // initial 是完整 Game 位置（含隐藏牌库序）；引擎重放需要它来补市场，
  // 但牌库序绝不进入任何输出（cases.mjs 有泄漏检查）。
  let state = structuredClone(r.initial);
  state.log = [...(state.log ?? [])];
  const timeline = [];
  const err = (code, message) => ({ level: 'error', code, message });

  try {
    for (let i = 0; i < r.turns.length; i++) {
      const t = r.turns[i];
      if (state.turnNumber !== t.turnNumber) {
        anomalies.push(err('replay-turn-skew', `第 ${i} 条记录：引擎 turnNumber=${state.turnNumber}，记录=${t.turnNumber}（行动序列与状态不符）`));
        return { ok: false };
      }
      if (state.current !== t.playerId) {
        anomalies.push(err('replay-seat-skew', `第 ${i} 条记录（第 ${t.turnNumber} 手）：引擎轮到座位 ${state.current}，记录为 ${t.playerId}`));
        return { ok: false };
      }
      if (!deepEqual(state.players[state.current], t.before)) {
        anomalies.push(err('replay-before-mismatch', `第 ${i} 条记录（第 ${t.turnNumber} 手）：行动前状态与重放不符`));
        return { ok: false };
      }
      // 公开市场快照（行动前）——公开局面时间线，供指标与案例提取使用
      timeline.push({
        turnNumber: t.turnNumber,
        round: t.round,
        merchantMarket: state.merchantMarket.map(m => ({ id: m.id, bonus: [...m.bonus] })),
        golemMarket: [...state.golemMarket],
        coins: { copper: state.copper, silver: state.silver },
      });
      // cardId 与重放市场一致性（可发现牌库序被篡改）
      for (const a of t.actions) {
        if (a.type === 'acquire' && state.merchantMarket[a.index]?.id !== t.cardId) {
          anomalies.push(err('replay-card-mismatch', `第 ${i} 条记录：acquire 记录 cardId=${t.cardId}，重放市场该位置为 ${state.merchantMarket[a.index]?.id ?? '空'}（牌库序或记录被改动）`));
          return { ok: false };
        }
        if (a.type === 'claim' && state.golemMarket[a.index] !== t.cardId) {
          anomalies.push(err('replay-card-mismatch', `第 ${i} 条记录：claim 记录 cardId=${t.cardId}，重放市场该位置为 ${state.golemMarket[a.index] ?? '空'}`));
          return { ok: false };
        }
      }
      for (const a of t.actions) {
        try {
          state = engine.applyAction(state, a);
        } catch (e) {
          anomalies.push(err('replay-illegal-action', `第 ${i} 条记录（第 ${t.turnNumber} 手）行动 ${canonicalStringify(a).slice(0, 120)} 被正式引擎拒绝：${e.message}`));
          return { ok: false };
        }
      }
      if (!deepEqual(state.players[t.playerId], t.after)) {
        anomalies.push(err('replay-after-mismatch', `第 ${i} 条记录（第 ${t.turnNumber} 手）：行动后状态与重放不符`));
        return { ok: false };
      }
      if (t.completed !== (state.phase !== 'overflow')) {
        anomalies.push(err('replay-completed-skew', `第 ${i} 条记录：completed=${t.completed} 与重放 phase=${state.phase} 不符`));
        return { ok: false };
      }
    }
    return { ok: true, game: state, timeline };
  } catch (e) {
    anomalies.push(err('replay-crash', `引擎重放异常：${e.message}`));
    return { ok: false };
  }
}

// ---------- 主入口 ----------

const PLAYER_MIN = SUPPORTED_MIN_PLAYERS;

/** 导入并验证单个对局文件。永不抛出：错误进 anomalies，ok=false。
 * @param {string} path
 * @param {{knownHashes?: Map<string,string>}} opts 批内去重用
 */
export async function importGameFile(path, opts = {}) {
  const anomalies = [];
  const file = basename(path);
  const base = { file, anomalies, ok: false, reason: null, hash: null, record: null, game: null, timeline: null, meta: null, provenance: null };

  let raw;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (e) {
    anomalies.push({ level: 'error', code: 'read-failed', message: `无法读取文件：${e.message}` });
    return base;
  }
  let record;
  try {
    record = JSON.parse(raw);
  } catch (e) {
    anomalies.push({ level: 'error', code: 'bad-json', message: `JSON 解析失败：${e.message}` });
    return base;
  }

  const { data } = await loadEngine();
  const structOk = validateStructural(record, data, anomalies);
  base.record = record;

  // 去重哈希（结构基本可用即可计算；无 replay 时退化为 whole-record 哈希）
  base.hash = record.replay
    ? recordHash(record)
    : createHash('sha256').update(canonicalStringify(record)).digest('hex');
  if (opts.knownHashes) {
    if (opts.knownHashes.has(base.hash)) {
      anomalies.push({ level: 'error', code: 'duplicate', message: `与已导入记录 ${opts.knownHashes.get(base.hash)} 重复（同 initial+turns 哈希 ${base.hash.slice(0, 12)}…）` });
    } else {
      opts.knownHashes.set(base.hash, file);
    }
  }

  // 元数据提取（不依赖重放成功）
  const n = record.replay?.initial?.players.length ?? record.current?.players.length ?? 0;
  const turns = record.replay?.turns ?? [];
  const lastTurn = turns[turns.length - 1];
  base.meta = {
    schemaFormat: record.format ?? null,
    schemaVersion: record.version ?? null,
    gameVersion: record.current?.version ?? record.replay?.initial?.version ?? null,
    seatCount: n,
    aiSeats: (record.current?.players ?? record.replay?.initial?.players ?? [])
      .filter(p => p.isAI).map(p => p.id),
    recordedFromTurn: record.replay?.initial?.turnNumber ?? null,
    fromStart: record.replay?.fromStart ?? null,
    turnCount: turns.length,
    lastTurnNumber: lastTurn?.turnNumber ?? null,
    lastRound: lastTurn?.round ?? null,
    finished: record.current?.phase === 'finished',
    phase: record.current?.phase ?? null,
    triggerPlayer: record.current?.triggerPlayer ?? null,
    claimedTarget: n >= PLAYER_MIN && n < 4 ? 6 : n >= 4 ? 5 : null, // 引擎规则：<4 人 6 张，≥4 人 5 张
    coverage: record.coverage ?? null,
  };
  const aiSeats = base.meta.aiSeats;
  // 数据来源判定（诚实性纪律）：
  //   - 文件带本工具定义的 provenance 扩展字段（如 fixtures-gen 的 simulated-scripted）→ 按其标注；
  //   - 否则：任一席位 isAI → mixed-human-ai；全真人席位 → human（真实网页导出缺省视为真人）。
  const stamp = record.provenance;
  if (stamp && stamp.kind && typeof stamp.kind === 'string') {
    base.provenance = {
      kind: stamp.kind,
      aiSeats,
      source: `${stamp.generator ?? '未知生成器'}（${stamp.note ?? '无说明'}）`,
      note: stamp.note ?? null,
    };
    if (stamp.kind !== 'human') {
      anomalies.push({ level: 'warn', code: 'simulated-data', message: `数据来源为「${stamp.kind}」（AI 模拟/脚本生成），非真人数据——聚合报告将单独标注` });
    }
  } else {
    base.provenance = {
      kind: aiSeats.length === 0 ? 'human' : 'mixed-human-ai',
      aiSeats,
      source: 'web-v1 auto-export (century-replay v1)',
      note: aiSeats.length === 0 ? '全部席位为真人' : `座位 [${aiSeats.join(', ')}] 为 AI 席位`,
    };
  }
  if (record.current?.phase === 'overflow') {
    anomalies.push({ level: 'warn', code: 'unfinished', message: '对局未完成（phase=overflow，等待弃置中）——终局相关诊断将输出「无法判断」' });
  } else if (record.current && record.current.phase !== 'finished') {
    anomalies.push({ level: 'warn', code: 'unfinished', message: '对局未完成（进行中）——终局相关诊断将输出「无法判断」' });
  }
  if (record.replay && record.replay.fromStart === false) {
    anomalies.push({ level: 'warn', code: 'partial-record', message: `非完整记录：从第 ${record.replay.initial.turnNumber} 手开始记录，之前行动缺失——节奏类指标仅覆盖记录区间` });
  }

  if (!structOk) return base;

  const verified = await replayVerify(record, anomalies);
  if (!verified.ok) return base;

  // 终态一致性：重放终局应与 current 完全一致（log 有 45 条上限，跳过比较）
  const cur = record.current;
  if (cur) {
    const finalState = {
      players: verified.game.players, current: verified.game.current,
      merchantMarket: verified.game.merchantMarket, golemMarket: verified.game.golemMarket,
      copper: verified.game.copper, silver: verified.game.silver,
      phase: verified.game.phase, triggerPlayer: verified.game.triggerPlayer, turnNumber: verified.game.turnNumber,
    };
    const actual = {
      players: cur.players, current: cur.current,
      merchantMarket: cur.merchantMarket, golemMarket: cur.golemMarket,
      copper: cur.copper, silver: cur.silver,
      phase: cur.phase, triggerPlayer: cur.triggerPlayer, turnNumber: cur.turnNumber,
    };
    if (!deepEqual(finalState, actual)) {
      anomalies.push({ level: 'error', code: 'final-state-mismatch', message: '重放终态与导出快照 current 不一致（记录可能被拼接或篡改）' });
      return base;
    }
  }

  base.ok = anomalies.every(a => a.level !== 'error');
  base.game = verified.game;
  base.timeline = verified.timeline;
  if (base.ok) base.reason = 'ok';
  return base;
}

/** 批量导入：文件数组 → 结果数组（保序），做批内去重。 */
export async function importGameFiles(paths) {
  const known = new Map();
  const results = [];
  for (const p of paths) results.push(await importGameFile(p, { knownHashes: known }));
  return results;
}

export { COLOR_NAMES };
