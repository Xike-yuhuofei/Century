/** 任务 E：报告生成（Markdown 复盘报告 / 结构化 JSON / 跨局聚合）。
 *
 * 确定性纪律：所有输出不含时间戳、不含随机数、排序稳定；同一记录重复
 * 运行逐字节一致（验收要求）。文件名基取自输入文件 basename。
 */

import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { FAILURE_TYPES } from './failures.mjs';

const round2 = x => Math.round(x * 100) / 100;
const mean = a => a.length ? round2(a.reduce((s, x) => s + x, 0) / a.length) : null;
const ACTION_TYPES = ['play', 'acquire', 'claim', 'rest', 'discard'];

function anomaliesTable(anomalies) {
  if (!anomalies.length) return '无异常。';
  const order = { error: 0, warn: 1 };
  return anomalies.slice().sort((a, b) => order[a.level] - order[b.level] || a.code.localeCompare(b.code))
    .map(a => `- **${a.level === 'error' ? '错误' : '警告'}** \`${a.code}\`：${a.message}`).join('\n');
}

/** 生成单局 Markdown 复盘报告。 */
export function renderGameReport(analysis) {
  const { metrics, failures, casesBundle } = analysis;
  const g = metrics.game;
  const m = g.meta;
  const lines = [];
  lines.push(`# Century 对局复盘分析 · ${g.file}`, '');
  lines.push(`- 数据来源：${g.provenance.source}${g.provenance.kind === 'human' ? '' : `；标注：**${g.provenance.kind}**`}`);
  lines.push(`- 记录哈希：\`${g.hash.slice(0, 16)}…\`（重复导入检测用）`);
  lines.push(`- 记录身份：${m.fromStart ? '从开局完整记录' : `部分记录（自第 ${m.recordedFromTurn} 手起）`}；${m.finished ? '已完成' : '**未完成**'}；${m.seatCount} 人；共 ${m.turnCount} 手 / ${m.lastRound ?? '?'} 轮；认领目标 ${m.claimedTarget} 张魔像`, '');

  lines.push('## 合法性与异常', '');
  lines.push(anomaliesTable(g.anomalies), '');

  if (m.finished && metrics.ranking) {
    lines.push('## 终局排名（复用正式引擎 ranking：平分后手优先）', '');
    lines.push('| 名次 | 席位 | 玩家 | 得分 |', '|---|---|---|---|');
    metrics.ranking.forEach((r, i) => lines.push(`| ${i + 1} | ${r.seat + 1} | ${r.name} | ${r.score} |`));
    lines.push('');
  }

  const trig = m.triggerPlayer;
  lines.push('## 对局级事件', '');
  lines.push(trig != null
    ? `- 终局触发：座位 ${trig + 1} 于第 ${m.triggerTurn} 手（第 ${m.triggerRound} 轮）认领第 ${m.claimedTarget} 张魔像；触发后进行 ${m.roundsAfterTrigger ?? '?'} 轮。`
    : '- 终局触发：无（未完成或未达认领目标）。');
  lines.push(`- 被抢目标事件：${metrics.contestedLosses.length} 次`);
  for (const e of metrics.contestedLosses) lines.push(`  - 第 ${e.turn} 手：座位 ${e.bySeat + 1} 付得起的 ${e.golemId}（${e.points} 分）被座位 ${e.claimedBySeat + 1} 认领`);
  lines.push(`- 错过认领事件（付得起却未认领）：${metrics.missedClaims.length} 次`);
  lines.push(`- 超额弃置：${metrics.overflowEvents.length} 次，共弃 ${metrics.overflowEvents.reduce((s, e) => s + e.count, 0)} 颗`, '');

  lines.push('## 逐席位特征', '');
  for (const p of metrics.players) {
    const o = p.kind.observable, c = p.kind.computed;
    lines.push(`### 座位 ${p.seat + 1} · ${p.name}`, '');
    lines.push('| 类别 | 指标 | 值 |', '|---|---|---|');
    lines.push(`| 事实 | 行动分布 | ${ACTION_TYPES.map(t => `${t === 'play' ? '打出' : t === 'acquire' ? '取卡' : t === 'claim' ? '认领' : t === 'rest' ? '休息' : '弃置'} ${o.actionsByType[t]}`).join(' · ')} |`);
    lines.push(`| 事实 | 认领 | ${o.claims.map(cl => `${cl.golemId}(${cl.points}分@第${cl.turn}手${cl.coin ? ',' + cl.coin : ''})`).join('、') || '无'} |`);
    lines.push(`| 事实 | 取卡 | ${o.actionsByType.acquire} 次，支付深度均值 ${c.avgPayDepth ?? '—'}，收回卡上奖励均值 ${c.avgBonusRetrieved ?? '—'} |`);
    lines.push(`| 事实 | 超额弃置 | ${o.overflowCount} 次共 ${o.crystalsDiscarded} 颗 |`);
    lines.push(`| 事实 | 终态 | 商队 [${(o.finalStock ?? []).join('/')}]，铜 ${o.finalCopper}、银 ${o.finalSilver}，未打出非起始卡 ${c.deadCardCount} 张 |`);
    lines.push(`| 计算 | 总分构成 | 魔像 ${c.golemPoints} + 铜币 ${c.coinPoints} + 非黄水晶 ${c.crystalPoints} = ${c.totalScore} |`);
    lines.push(`| 计算 | 容量利用 | 平均 ${c.avgCapacityUtil ?? '—'}，峰值 ${c.maxCapacity ?? '—'}/10 |`);
    lines.push(`| 计算 | 休息 | ${c.restCount} 次，低价值（≤1 张打出）休息 ${o.rests.filter(r => r.playedSize <= 1).length} 次 |`);
    lines.push(`| 计算 | 节奏 | 首次认领第 ${c.firstClaimTurn ?? '—'} 手；每 10 手认领 ${c.claimsPer10Turns}；每 10 手取卡 ${c.acquiresPer10Turns} |`);
    lines.push(`| 计算 | 竞争 | 被抢目标 ${c.contestedLosses.length} 次；错过认领 ${c.missedClaims.length} 次；「大商队无目标」${c.bigIdleTurns.length} 手 |`);
    lines.push(`| 推测 | 倾向 | ${p.kind.inferred.archetypeHint}（仅供参考，不作失败判定证据） |`);
    lines.push('');
  }

  lines.push('## 失败诊断', '');
  lines.push(`> ${failures.discipline.join(' ')}`, '');
  let anyFinding = false;
  for (const pl of failures.players) {
    if (!pl.findings.length) continue;
    anyFinding = true;
    lines.push(`### 座位 ${pl.seat + 1} · ${pl.name}`, '');
    for (const f of pl.findings) {
      lines.push(`- **[${f.label}]**（严重度：${f.severity}）`);
      for (const e of f.evidence) lines.push(`  - 证据：${e}`);
    }
    lines.push('');
  }
  if (!anyFinding) lines.push('本局无达到阈值的失败标签。', '');
  const inconclusive = failures.players.flatMap(pl => pl.inconclusives.map(i => ({ ...i, seat: pl.seat, name: pl.name })));
  if (inconclusive.length) {
    lines.push('### 无法判断（证据不足）', '');
    for (const i of inconclusive) lines.push(`- 座位 ${i.seat + 1} · ${i.name} · [${i.label}]：${i.reason}`);
    lines.push('');
  }

  if (casesBundle) {
    lines.push('## 关键战术案例（供第六阶段反事实分析）', '');
    lines.push(`共提取 ${casesBundle.selected} / ${casesBundle.totalEligible} 个候选局面；${casesBundle.hiddenInfoPolicy[0]}`, '');
    lines.push('| 案例 ID | 手 | 席位 | 类型 | 行动 |', '|---|---|---|---|---|');
    for (const c of casesBundle.cases.slice(0, 20)) {
      lines.push(`| ${c.id} | ${c.turnNumber} | ${c.seat + 1} | ${c.kinds.join('/')} | ${c.action.type}${c.cardId ? ` ${c.cardId}` : ''} |`);
    }
    lines.push('');
    lines.push('完整公开局面见同名 `*.cases.json`。', '');
  }

  lines.push('## 指标语义说明', '');
  lines.push('- **事实（observable）**：直接来自对局记录的计数与序列。');
  lines.push('- **计算（computed）**：由事实经确定性算法推导（与正式引擎/牌表一致）。');
  lines.push('- **推测（inferred）**：战略推测，仅供参考，不进入失败判定。');
  lines.push('- 本报告不依据输赢判定单步对错；失败标签均有可检测证据与阈值。', '');
  return lines.join('\n');
}

/** 写单局全套输出。返回文件路径列表。 */
export function writeGameReports(analysis, outDir) {
  mkdirSync(outDir, { recursive: true });
  const base = basename(analysis.metrics.game.file).replace(/\.json$/i, '');
  const files = {};
  files.metrics = resolve(outDir, `${base}.metrics.json`);
  files.failures = resolve(outDir, `${base}.failures.json`);
  files.cases = resolve(outDir, `${base}.cases.json`);
  files.report = resolve(outDir, `${base}.report.md`);
  writeFileSync(files.metrics, JSON.stringify(analysis.metrics, null, 2));
  writeFileSync(files.failures, JSON.stringify(analysis.failures, null, 2));
  writeFileSync(files.cases, JSON.stringify(analysis.casesBundle, null, 2));
  writeFileSync(files.report, renderGameReport(analysis));
  return files;
}

// ---------- 跨局聚合 ----------

function aggNumbers(values) {
  if (!values.length) return { n: 0, mean: null, min: null, max: null };
  return { n: values.length, mean: mean(values), min: Math.min(...values), max: Math.max(...values) };
}

/** 聚合多局 metrics+failures → {json, markdown}。 */
export function aggregateAnalyses(entries, js5 = null) {
  // entries: [{file, metrics, failures}]
  const games = entries.map(e => e.metrics.game);
  const provenanceCounts = {};
  for (const g of games) provenanceCounts[g.provenance.kind] = (provenanceCounts[g.provenance.kind] ?? 0) + 1;

  const finished = entries.filter(e => e.metrics.game.meta.finished);
  const perType = Object.fromEntries(FAILURE_TYPES.map(([code, label]) => {
    const rows = entries.map(e => {
      const seatFindings = e.failures.players.flatMap(pl => pl.findings.filter(f => f.type === code).map(f => ({ seat: pl.seat, severity: f.severity })));
      return { file: e.metrics.game.file, findings: seatFindings, inconclusive: e.failures.players.reduce((s, pl) => s + pl.inconclusives.filter(i => i.type === code).length, 0) };
    });
    const seatCount = rows.reduce((s, r) => s + r.findings.length, 0);
    const sev = { high: 0, medium: 0, low: 0 };
    for (const r of rows) for (const f of r.findings) sev[f.severity]++;
    return [code, { label, games: rows.filter(r => r.findings.length).length, seatFindings: seatCount, severity: sev, topGames: rows.filter(r => r.findings.length).sort((a, b) => b.findings.length - a.findings.length || a.file.localeCompare(b.file)).slice(0, 5).map(r => `${r.file}(${r.findings.length})`) }];
  }));

  // 逐玩家（按名字跨局聚合）
  const byName = new Map();
  for (const e of entries) {
    for (const p of e.metrics.players) {
      const key = p.name;
      if (!byName.has(key)) byName.set(key, { name: p.name, games: 0, scores: [], claims: [], acquires: [], rests: [], contested: [], missed: [], overflow: [] });
      const acc = byName.get(key);
      acc.games++;
      if (e.metrics.game.meta.finished) acc.scores.push(p.kind.computed.totalScore);
      acc.claims.push(p.kind.observable.claims.length);
      acc.acquires.push(p.kind.observable.actionsByType.acquire);
      acc.rests.push(p.kind.observable.actionsByType.rest);
      acc.contested.push(p.kind.computed.contestedLosses.length);
      acc.missed.push(p.kind.computed.missedClaims.length);
      acc.overflow.push(p.kind.observable.crystalsDiscarded);
    }
  }
  const playersAgg = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)).map(a => ({
    name: a.name, games: a.games,
    avgScore: mean(a.scores), avgClaims: mean(a.claims), avgAcquires: mean(a.acquires), avgRests: mean(a.rests),
    avgContested: mean(a.contested), avgMissed: mean(a.missed), avgCrystalsDiscarded: mean(a.overflow),
  }));

  const seatCounts = {};
  for (const g of games) seatCounts[g.meta.seatCount] = (seatCounts[g.meta.seatCount] ?? 0) + 1;

  const json = {
    schema: 'century-human-analytics-aggregate-v1',
    inputs: entries.map(e => e.metrics.game.file).sort(),
    gameCount: entries.length,
    finishedCount: finished.length,
    seatCountDistribution: seatCounts,
    provenance: { counts: provenanceCounts, note: entries.some(e => e.metrics.game.provenance.kind !== 'human') ? '包含非真人来源的对局（见各局 provenance 标注）' : '全部为真人对局' },
    failureTypes: perType,
    players: playersAgg,
    contestedLossesTotal: entries.reduce((s, e) => s + e.metrics.contestedLosses.length, 0),
    missedClaimsTotal: entries.reduce((s, e) => s + e.metrics.missedClaims.length, 0),
    overflowTotal: entries.reduce((s, e) => s + e.metrics.overflowEvents.length, 0),
    ...(js5 ? { js5Diagnostics: js5 } : {}),
  };

  const md = [];
  md.push('# Century 对局复盘 · 跨局聚合报告', '');
  md.push(`- 对局数：${entries.length}（已完成 ${finished.length}）；人数分布：${Object.entries(seatCounts).sort().map(([k, v]) => `${k}人×${v}`).join('、') || '—'}`);
  md.push(`- 数据来源：${JSON.stringify(provenanceCounts)} —— ${json.provenance.note}`);
  md.push(`- 输入：${json.inputs.map(f => `\`${f}\``).join('、')}`, '');
  md.push('## 失败类型跨局统计', '');
  md.push('| 类型 | 出现对局数 | 标签席位次 | 高/中/低 | 高频对局 |', '|---|---|---|---|---|');
  for (const [code, t] of Object.entries(perType)) {
    md.push(`| ${t.label} \`${code}\` | ${t.games} | ${t.seatFindings} | ${t.severity.high}/${t.severity.medium}/${t.severity.low} | ${t.topGames.join('、') || '—'} |`);
  }
  md.push('');
  md.push('## 逐玩家跨局（按名字聚合）', '');
  md.push('| 玩家 | 局数 | 均分 | 认领/局 | 取卡/局 | 休息/局 | 被抢/局 | 错过/局 | 弃晶/局 |', '|---|---|---|---|---|---|---|---|---|');
  for (const p of playersAgg) {
    md.push(`| ${p.name} | ${p.games} | ${p.avgScore ?? '—'} | ${p.avgClaims ?? '—'} | ${p.avgAcquires ?? '—'} | ${p.avgRests ?? '—'} | ${p.avgContested ?? '—'} | ${p.avgMissed ?? '—'} | ${p.avgCrystalsDiscarded ?? '—'} |`);
  }
  md.push('');
  md.push(`## 事件总量`, '');
  md.push(`- 被抢目标 ${json.contestedLossesTotal} 次；错过认领 ${json.missedClaimsTotal} 次；超额弃置 ${json.overflowTotal} 次`, '');
  if (js5) {
    md.push('## JS5 决策诊断（AI 模拟数据，非真人）', '');
    md.push(`- 来源：${js5.source}（schema \`${js5.schema}\`）`);
    md.push(`- 决策 ${js5.decisions} 条；门控 ${js5.gated}；覆盖冠军建议 ${js5.overridden}；关联对局胜负已知 ${js5.withOutcome}`, '');
    md.push('> 本节为 training/joint/diagnostics.mjs 的 AI 决策日志摘要，数据来源为模拟对局，不得视作真人对局证据。', '');
  }
  return { json, markdown: md.join('\n') };
}

/** 写聚合输出。 */
export function writeAggregateReport(entries, outDir, js5 = null) {
  mkdirSync(outDir, { recursive: true });
  const { json, markdown } = aggregateAnalyses(entries, js5);
  const files = {
    json: resolve(outDir, 'aggregate.json'),
    report: resolve(outDir, 'aggregate.md'),
  };
  writeFileSync(files.json, JSON.stringify(json, null, 2));
  writeFileSync(files.report, markdown);
  return files;
}

/** 从目录收集 *.metrics.json（并匹配同名 *.failures.json）。 */
export function collectAnalysisEntries(dir) {
  const entries = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.metrics.json')) continue;
    const metrics = JSON.parse(readFileSync(resolve(dir, f), 'utf-8'));
    const failFile = resolve(dir, f.replace(/\.metrics\.json$/, '.failures.json'));
    const failures = JSON.parse(readFileSync(failFile, 'utf-8'));
    entries.push({ file: f, metrics, failures });
  }
  return entries;
}

/** 解析 js5 决策 JSONL（training/joint/diagnostics.mjs 输出）为聚合摘要。 */
export function summarizeJs5Diagnostics(path) {
  const lines = readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
  const decisions = lines.map(l => JSON.parse(l));
  return {
    schema: 'century-js5-diagnostics-decisions',
    source: path,
    decisions: decisions.length,
    gated: decisions.filter(d => d.gated === true).length,
    overridden: decisions.filter(d => d.overridden === true).length,
    withOutcome: decisions.filter(d => d.candidateWon != null).length,
  };
}
