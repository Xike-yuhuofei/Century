/** LLM 决策数据存储（Node-only）。
 *
 * 设计目标：
 * - 原始数据只追加、永不覆盖：每个对局一个目录，决策/回合 JSONL 带 SHA-256 哈希链；
 * - 支持中断恢复：逐回合落盘，result.json 原子写入；
 * - 支持查询/筛选/去重/批量分析：finalize 生成 SQLite 索引；
 * - 支持完整导出与独立重放：result.json 保存完整 replay，decision 记录保存观察与候选；
 * - 版本化 Schema：run/game/decision envelope 均带 schema 字段；
 * - 模型版本与实验身份可追溯：run.json 保存 provider、模型、代码提交与配置。
 *
 * 本模块不写任何密钥；调用方只能传入已脱敏的 ProviderInfo。
 */

import {
  existsSync, mkdirSync, appendFileSync, readFileSync, writeFileSync,
  readdirSync, statSync, renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrateSchema } from './schema.mjs';

export const RUN_SCHEMA = 'century-llm-run-v1';
export const GAME_SCHEMA = 'century-llm-game-v1';
export const DECISION_ENVELOPE_SCHEMA = 'century-llm-decision-envelope-v1';
export const TURN_ENVELOPE_SCHEMA = 'century-llm-turn-envelope-v1';
export const MANIFEST_SCHEMA = 'century-llm-dataset-manifest-v1';
export const DEFAULT_ROOT = resolve('training/reports/llm-player');

export function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

export function codeVersion() {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const status = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim();
    return {
      commit,
      dirty: status.length > 0,
      dirtyFiles: status ? status.split('\n').slice(0, 50) : [],
    };
  } catch {
    return { commit: null, dirty: null, dirtyFiles: [] };
  }
}

function atomicWriteJson(path, value) {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  renameSync(tmp, path);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function newRunId(prefix = 'llm10') {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '');
  return `${prefix}-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
}

export class RunStore {
  constructor({ root = DEFAULT_ROOT, runId = newRunId(), create = false, runConfig = {}, providerInfo = null } = {}) {
    this.root = resolve(root);
    this.dir = join(this.root, runId);
    this.runId = runId;
    if (create) {
      mkdirSync(join(this.dir, 'games'), { recursive: true });
      const now = new Date().toISOString();
      this.run = {
        schema: RUN_SCHEMA,
        runId,
        createdAt: now,
        updatedAt: now,
        status: 'running',
        codeVersion: codeVersion(),
        provider: providerInfo,
        config: runConfig,
        schemaVersions: {
          run: RUN_SCHEMA, game: GAME_SCHEMA,
          decisionEnvelope: DECISION_ENVELOPE_SCHEMA,
          turnEnvelope: TURN_ENVELOPE_SCHEMA,
        },
        environment: {
          node: process.version,
          platform: process.platform,
          arch: process.arch,
        },
        notes: [],
      };
      atomicWriteJson(join(this.dir, 'run.json'), this.run);
    } else {
      const path = join(this.dir, 'run.json');
      if (!existsSync(path)) throw new Error(`运行不存在：${path}`);
      this.run = migrateSchema('run', readJson(path));
    }
  }

  static open(root, runId) {
    return new RunStore({ root, runId });
  }

  static create(options) {
    return new RunStore({ ...options, create: true });
  }

  get path() { return this.dir; }

  updateRun(patch) {
    this.run = { ...this.run, ...patch, updatedAt: new Date().toISOString() };
    atomicWriteJson(join(this.dir, 'run.json'), this.run);
    return this.run;
  }

  note(message) {
    this.run.notes = [...(this.run.notes ?? []), { at: new Date().toISOString(), message: String(message).slice(0, 500) }].slice(-100);
    this.updateRun({});
  }

  gameDir(gameId) {
    const safe = String(gameId).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
    return join(this.dir, 'games', safe);
  }

  ensureGame(gameId, meta) {
    const dir = this.gameDir(gameId);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'game.json');
    if (!existsSync(path)) {
      atomicWriteJson(path, {
        schema: GAME_SCHEMA,
        gameId,
        createdAt: new Date().toISOString(),
        ...meta,
      });
    }
    return dir;
  }

  readGameMeta(gameId) {
    const path = join(this.gameDir(gameId), 'game.json');
    if (!existsSync(path)) return null;
    return readJson(path);
  }

  loadEnvelopes(gameId, kind) {
    const path = join(this.gameDir(gameId), kind === 'decision' ? 'decisions.jsonl' : 'turns.jsonl');
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean);
    return lines.map((line, index) => {
      try { return JSON.parse(line); } catch (error) {
        throw new Error(`${path} 第 ${index + 1} 行不是合法 JSON：${error.message}`);
      }
    });
  }

  appendEnvelope(gameId, kind, record, extra = {}) {
    const dir = this.ensureGame(gameId, extra.gameMeta ?? {});
    const path = join(dir, kind === 'decision' ? 'decisions.jsonl' : 'turns.jsonl');
    const previous = this.loadEnvelopes(gameId, kind).at(-1) ?? null;
    const recordHash = sha256(JSON.stringify(record));
    const envelope = {
      schema: kind === 'decision' ? DECISION_ENVELOPE_SCHEMA : TURN_ENVELOPE_SCHEMA,
      seq: (previous?.seq ?? 0) + 1,
      gameId,
      prevHash: previous?.recordHash ?? null,
      recordHash,
      recordedAt: new Date().toISOString(),
      record,
    };
    appendFileSync(path, JSON.stringify(envelope) + '\n');
    return envelope;
  }

  appendDecision(gameId, record, extra) {
    return this.appendEnvelope(gameId, 'decision', record, extra);
  }

  appendTurn(gameId, record, extra) {
    return this.appendEnvelope(gameId, 'turn', record, extra);
  }

  /** 配对结果 JSONL（哈希链；与逐局原始数据分离）。 */
  appendPair(record) {
    const path = join(this.dir, 'pairs.jsonl');
    const previous = this.loadPairs().at(-1) ?? null;
    const recordHash = sha256(JSON.stringify(record));
    const envelope = {
      schema: 'century-llm-pair-envelope-v1',
      seq: (previous?.seq ?? 0) + 1,
      prevHash: previous?.recordHash ?? null,
      recordHash,
      recordedAt: new Date().toISOString(),
      record,
    };
    appendFileSync(path, JSON.stringify(envelope) + '\n');
    return envelope;
  }

  loadPairs() {
    const path = join(this.dir, 'pairs.jsonl');
    if (!existsSync(path)) return [];
    return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  pairRecords() {
    return this.loadPairs().map(envelope => envelope.record);
  }

  writeResult(gameId, result) {
    const dir = this.ensureGame(gameId, result.gameMeta ?? {});
    atomicWriteJson(join(dir, 'result.json'), result);
    return result;
  }

  readResult(gameId) {
    const path = join(this.gameDir(gameId), 'result.json');
    return existsSync(path) ? readJson(path) : null;
  }

  /** 中断恢复失败时保留原始证据并改名，随后从干净状态重开。
   * 原始文件不删除、不覆盖；新数据写入新文件。 */
  archivePartial(gameId, reason = 'partial') {
    const dir = this.gameDir(gameId);
    if (!existsSync(dir)) return null;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archived = [];
    for (const name of ['decisions.jsonl', 'turns.jsonl', 'result.json']) {
      const source = join(dir, name);
      if (!existsSync(source)) continue;
      const target = join(dir, name.replace(/\.(jsonl|json)$/, `.partial-${stamp}.$1`));
      renameSync(source, target);
      archived.push({ from: name, to: target.split('/').pop() });
    }
    const record = { at: new Date().toISOString(), reason, archived };
    atomicWriteJson(join(dir, `partial-archive-${stamp}.json`), record);
    this.note(`归档未完成对局 ${gameId}：${reason}（${archived.length} 个文件）`);
    return record;
  }

  listGames() {
    const dir = join(this.dir, 'games');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(x => statSync(join(dir, x)).isDirectory()).sort();
  }

  /** 合并逐局 JSONL、校验哈希链、生成 SQLite 索引与 manifest。 */
  finalize({ analysisPath = null } = {}) {
    const games = this.listGames();
    const allDecisions = [];
    const allTurns = [];
    const gameSummaries = [];
    const integrity = { decisionChains: [], turnChains: [], errors: [] };
    const decisionIds = new Set();
    const duplicates = [];
    for (const gameDirName of games) {
      const meta = this.readGameMeta(gameDirName);
      const result = this.readResult(gameDirName);
      const decisions = this.loadEnvelopes(gameDirName, 'decision');
      const turns = this.loadEnvelopes(gameDirName, 'turn');
      // 哈希链校验
      let prev = null;
      let chainOk = true;
      for (const env of decisions) {
        const expected = sha256(JSON.stringify(env.record));
        if (env.recordHash !== expected) { chainOk = false; integrity.errors.push(`${gameDirName} decision seq ${env.seq} recordHash 不匹配`); }
        if ((env.prevHash ?? null) !== prev) { chainOk = false; integrity.errors.push(`${gameDirName} decision seq ${env.seq} prevHash 断链`); }
        prev = env.recordHash;
        if (decisionIds.has(env.record?.decisionId)) duplicates.push(env.record?.decisionId);
        decisionIds.add(env.record?.decisionId);
        allDecisions.push({ gameId: gameDirName, ...env });
      }
      integrity.decisionChains.push({ gameId: gameDirName, records: decisions.length, ok: chainOk });
      prev = null;
      let turnChainOk = true;
      for (const env of turns) {
        const expected = sha256(JSON.stringify(env.record));
        if (env.recordHash !== expected) { turnChainOk = false; integrity.errors.push(`${gameDirName} turn seq ${env.seq} recordHash 不匹配`); }
        if ((env.prevHash ?? null) !== prev) { turnChainOk = false; integrity.errors.push(`${gameDirName} turn seq ${env.seq} prevHash 断链`); }
        prev = env.recordHash;
        allTurns.push({ gameId: gameDirName, ...env });
      }
      integrity.turnChains.push({ gameId: gameDirName, records: turns.length, ok: turnChainOk });
      const fallbackCount = decisions.filter(d => d.record?.source === 'fallback').length;
      const llmCount = decisions.filter(d => d.record?.source === 'llm').length;
      gameSummaries.push({
        gameId: gameDirName,
        mode: meta?.mode ?? null,
        seed: meta?.seed ?? null,
        focusSeat: meta?.focusSeat ?? null,
        arm: meta?.arm ?? null,
        pairId: meta?.pairId ?? null,
        status: result?.status ?? 'incomplete',
        decisionCount: decisions.length,
        llmDecisions: llmCount,
        fallbackCount,
        fallbackRate: decisions.length ? fallbackCount / decisions.length : null,
        winnerSeat: result?.winnerSeat ?? null,
        focusFirst: result?.focusFirst ?? null,
        anomaly: result?.anomaly ?? result?.status !== 'finished',
        moves: result?.moves ?? null,
        wallMs: result?.wallMs ?? null,
        replayConsistent: result?.replayConsistency?.ok ?? null,
        meta,
      });
    }
    const manifest = {
      schema: MANIFEST_SCHEMA,
      runId: this.runId,
      generatedAt: new Date().toISOString(),
      codeVersion: this.run.codeVersion,
      provider: this.run.provider,
      config: this.run.config,
      counts: {
        games: games.length,
        finishedGames: gameSummaries.filter(g => g.status === 'finished').length,
        decisions: allDecisions.length,
        llmDecisions: allDecisions.filter(d => d.record?.source === 'llm').length,
        fallbackDecisions: allDecisions.filter(d => d.record?.source === 'fallback').length,
        turns: allTurns.length,
        duplicateDecisionIds: duplicates.length,
        orphanDecisions: this.countOrphans(allDecisions, allTurns),
      },
      duplicateDecisionIds: [...new Set(duplicates)],
      integrity,
      games: gameSummaries,
      analysisPath,
    };
    atomicWriteJson(join(this.dir, 'manifest.json'), manifest);

    // 合并文件（派生视图；不覆盖逐局原始 JSONL）
    const mergedDecisionsPath = join(this.dir, 'decisions.jsonl');
    const mergedTurnsPath = join(this.dir, 'turns.jsonl');
    writeFileSync(mergedDecisionsPath, allDecisions.map(x => JSON.stringify({ gameId: x.gameId, ...x })).join('\n') + (allDecisions.length ? '\n' : ''));
    writeFileSync(mergedTurnsPath, allTurns.map(x => JSON.stringify({ gameId: x.gameId, ...x })).join('\n') + (allTurns.length ? '\n' : ''));
    this.buildSqliteIndex(gameSummaries, allDecisions);
    this.updateRun({ status: this.run.status === 'running' ? 'finalized' : this.run.status });
    return manifest;
  }

  countOrphans(decisions, turns) {
    // 失败/超时决策可能没有对应回合（进程中断）；只统计，不删除、不修改。
    const applied = new Set(turns.map(t => t.record?.decisionId).filter(Boolean));
    return decisions.filter(d => d.record?.decisionId && !applied.has(d.record.decisionId)).length;
  }

  buildSqliteIndex(gameSummaries, decisions) {
    const path = join(this.dir, 'index.sqlite');
    let db;
    try {
      db = new DatabaseSync(path);
      db.exec(`
        PRAGMA journal_mode=WAL;
        CREATE TABLE IF NOT EXISTS run (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS games (
          game_id TEXT PRIMARY KEY, mode INTEGER, seed INTEGER, focus_seat INTEGER,
          arm TEXT, pair_id TEXT, status TEXT, winner_seat INTEGER, focus_first INTEGER,
          decision_count INTEGER, fallback_count INTEGER, anomaly INTEGER,
          result_json TEXT
        );
        CREATE TABLE IF NOT EXISTS decisions (
          decision_id TEXT PRIMARY KEY, game_id TEXT, mode INTEGER, seed INTEGER,
          focus_seat INTEGER, arm TEXT, turn_number INTEGER, seat INTEGER,
          source TEXT, fallback_cause TEXT, selected_action_id TEXT,
          executed_action TEXT, primary_goal TEXT, reason TEXT, strategy_tags TEXT,
          provider TEXT, model TEXT, latency_ms REAL, total_tokens INTEGER,
          created_at TEXT, record_hash TEXT, record_json TEXT
        );
        CREATE TABLE IF NOT EXISTS decision_tags (
          decision_id TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(decision_id, tag)
        );
        CREATE INDEX IF NOT EXISTS idx_decisions_game ON decisions(game_id);
        CREATE INDEX IF NOT EXISTS idx_decisions_source ON decisions(source);
        CREATE INDEX IF NOT EXISTS idx_decisions_mode ON decisions(mode);
        CREATE INDEX IF NOT EXISTS idx_decisions_model ON decisions(model);
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON decision_tags(tag);
        CREATE INDEX IF NOT EXISTS idx_games_arm ON games(arm);
      `);
      db.exec('DELETE FROM run; DELETE FROM games; DELETE FROM decisions; DELETE FROM decision_tags;');
      const insertRun = db.prepare('INSERT INTO run(key, value) VALUES (?, ?)');
      insertRun.run('run.json', JSON.stringify(this.run));
      const insertGame = db.prepare(`INSERT INTO games VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertDecision = db.prepare(`INSERT INTO decisions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const insertTag = db.prepare('INSERT OR IGNORE INTO decision_tags(decision_id, tag) VALUES (?, ?)');
      for (const game of gameSummaries) {
        insertGame.run(
          game.gameId, game.mode ?? null, game.seed ?? null, game.focusSeat ?? null,
          game.arm ?? null, game.pairId ?? null, game.status ?? null,
          game.winnerSeat ?? null, game.focusFirst === true ? 1 : game.focusFirst === false ? 0 : null,
          game.decisionCount ?? 0, game.fallbackCount ?? 0, game.anomaly ? 1 : 0,
          JSON.stringify(this.readResult(game.gameId) ?? null),
        );
      }
      for (const env of decisions) {
        const r = env.record ?? {};
        insertDecision.run(
          r.decisionId ?? null, env.gameId, r.seatCount ?? null, r.seed ?? null,
          r.focusSeat ?? null, null, r.turnNumber ?? null, r.seat ?? null,
          r.source ?? null, r.fallbackCause ?? null, r.selectedActionId ?? null,
          JSON.stringify(r.executedAction ?? null), r.parsed?.primaryGoal ?? null,
          r.parsed?.reason ?? null, JSON.stringify(r.parsed?.strategyTags ?? []),
          r.provider?.id ?? null, r.effectiveModel ?? null, r.totalLatencyMs ?? null,
          r.usage?.totalTokens ?? null, r.createdAt ?? null, env.recordHash ?? null,
          JSON.stringify(r),
        );
        for (const tag of r.parsed?.strategyTags ?? []) {
          if (typeof tag === 'string' && tag) insertTag.run(r.decisionId ?? null, tag);
        }
      }
    } catch (error) {
      this.note(`SQLite 索引生成失败：${error.message}`);
    } finally {
      try { db?.close(); } catch { /* 已关闭 */ }
    }
    return path;
  }

  /** 完整导出（含逐局 replay 与全部决策）到独立 JSON。 */
  exportJson(outPath = join(this.dir, 'export', 'dataset.json')) {
    mkdirSync(join(this.dir, 'export'), { recursive: true });
    const games = this.listGames().map(gameId => ({
      gameId,
      meta: this.readGameMeta(gameId),
      result: this.readResult(gameId),
      decisions: this.loadEnvelopes(gameId, 'decision'),
      turns: this.loadEnvelopes(gameId, 'turn'),
    }));
    const payload = {
      schema: 'century-llm-dataset-v1',
      run: this.run,
      manifestPath: join(this.dir, 'manifest.json'),
      games,
    };
    atomicWriteJson(resolve(outPath), payload);
    return outPath;
  }
}
