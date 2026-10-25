/** D5：失败诊断回流（可复现标签 + 研究提示 + 课程配置）。
 *
 * 输入只读取现有公开诊断产物：
 * - training/diagnostics/analyze.mjs 的 analysis.json（事实/启发式/推测分层）；
 * - training/human-analytics/failures.mjs 的 failures 输出（finding/inconclusive）。
 *
 * 标签（与任务书一一对应）：
 *   engine-deficiency  引擎不足
 *   claim-delay        认领延迟
 *   rest-waste         休息浪费
 *   capacity-waste     资源容量浪费
 *   endgame-error      终局错误
 *   contest-loss       竞争抢牌失败
 *
 * 纪律（防把诊断当奖励真值）：
 * - 每个标签必须给出确定性阈值与证据；证据不足 → inconclusive，零信号 → absent；
 * - 标签只生成研究提示与课程配置，**不修改任何奖励函数/评分真值**；
 * - `toResearchHints` 返回 advisoryOnly=true、notRewardTruth=true、rewardModified=false；
 * - 输出无墙钟、无随机源；同一输入重复运行逐字节一致。
 */

import {
  SCHEMAS, assertCondition, deepFreeze, sha256Canonical,
} from './core.mjs';

export const FAILURE_LABELS = Object.freeze([
  { code: 'engine-deficiency', label: '引擎不足' },
  { code: 'claim-delay', label: '认领延迟' },
  { code: 'rest-waste', label: '休息浪费' },
  { code: 'capacity-waste', label: '资源容量浪费' },
  { code: 'endgame-error', label: '终局错误' },
  { code: 'contest-loss', label: '竞争抢牌失败' },
]);

const LABEL_BY_CODE = new Map(FAILURE_LABELS.map(x => [x.code, x]));
const STATUS_ORDER = { absent: 0, inconclusive: 1, finding: 2 };

function label(code, status, evidence, rule) {
  assertCondition(LABEL_BY_CODE.has(code), `未知失败标签：${code}`);
  return {
    code,
    label: LABEL_BY_CODE.get(code).label,
    status,
    evidence: evidence.map(e => String(e).slice(0, 240)),
    rule,
  };
}

/** 从 diagnostics/analyze.mjs 的 analysis.json 提取标签。 */
export function labelsFromDiagnosticsAnalysis(analysis) {
  assertCondition(analysis && Array.isArray(analysis.findings), 'analysis.findings 缺失');
  const rows = [];
  for (const finding of analysis.findings) {
    const f = finding.facts ?? {};
    const labels = [];
    const golems = f.golems ?? null;
    const acquired = f.merchantsAcquired ?? null;
    const conversion = f.conversionPer100Actions ?? null;
    const lowEngine = (golems !== null && golems <= 1 && acquired !== null && acquired <= 2)
      || (conversion !== null && conversion < 8);
    labels.push(lowEngine
      ? label('engine-deficiency', 'finding', [
        `终局魔像 ${golems ?? 'n/a'}、获取商人卡 ${acquired ?? 'n/a'}、每百行动得分 ${conversion ?? 'n/a'}`,
        '判定阈值：魔像≤1 且获卡≤2，或每百行动得分<8',
      ], 'low-engine-and-conversion')
      : label('engine-deficiency', 'absent', ['引擎产出/转换未低于阈值'], 'low-engine-and-conversion'));

    const contested = f.contestedMisses ?? 0;
    labels.push(contested >= 3
      ? label('contest-loss', 'finding', [`${contested} 次他人获取时本席账面付得起位置费`], 'contested>=3')
      : contested >= 1
        ? label('contest-loss', 'inconclusive', [`仅 ${contested} 次竞争机会（阈值 3）`], 'contested>=3')
        : label('contest-loss', 'absent', ['无竞争机会信号'], 'contested>=3'));
    labels.push(contested >= 3
      ? label('claim-delay', 'finding', [`竞争机会 ${contested} 次未转化为获取`], 'contested>=3')
      : label('claim-delay', 'inconclusive', contested >= 1 ? [`仅 ${contested} 次机会（阈值 3）`] : ['无认领延迟信号'], 'contested>=3'));

    const restRatio = f.restRatio ?? null;
    const meanRest = f.gameMeanRestRatio ?? null;
    const restWaste = restRatio !== null && meanRest !== null && restRatio > meanRest * 1.5 && restRatio > 0.15;
    labels.push(restWaste
      ? label('rest-waste', 'finding', [`休息占比 ${restRatio} 高于全场均值 ${meanRest} 的 1.5 倍`], 'rest-ratio>1.5x-and>0.15')
      : label('rest-waste', 'absent', [`休息占比 ${restRatio ?? 'n/a'}（全场 ${meanRest ?? 'n/a'}）未达阈值`], 'rest-ratio>1.5x-and>0.15'));

    labels.push(label('capacity-waste', 'absent', ['diagnostics/analyze 不提供弃置/容量事实'], 'needs-human-analytics'));
    labels.push(label('endgame-error', 'absent', ['diagnostics/analyze 不提供终局触发时点事实'], 'needs-human-analytics'));
    rows.push({
      seed: finding.seed,
      loserSeat: finding.loserSeat,
      winnerSeat: finding.winnerSeat,
      labels,
      heuristics: [...(finding.heuristics ?? [])],
      speculations: [...(finding.speculations ?? [])],
    });
  }
  return {
    schema: SCHEMAS.failureLabels,
    source: 'training/diagnostics/analyze.mjs analysis.json',
    sourceGames: analysis.gamesAnalyzed ?? rows.length,
    rows,
    discipline: 'diagnostics 事实层 + 确定性阈值；不把 heuristics/speculations 当证据',
  };
}

const HUMAN_TYPE_MAP = Object.freeze({
  'goal-competition': ['contest-loss', 'claim-delay'],
  'missed-claims': ['claim-delay', 'endgame-error'],
  'rest-cost-high': ['rest-waste'],
  'capacity-waste': ['capacity-waste'],
  'resource-mismatch': ['capacity-waste'],
  'merchant-efficiency': ['engine-deficiency'],
  'engine-overbuild': ['engine-deficiency'],
  'endgame-pacing': ['endgame-error'],
});

/** 从 human-analytics/failures.mjs 输出提取标签。 */
export function labelsFromHumanAnalytics(failures) {
  assertCondition(failures && Array.isArray(failures.players), 'failures.players 缺失');
  const rows = [];
  for (const player of failures.players) {
    const byCode = new Map();
    for (const finding of player.findings ?? []) {
      const codes = HUMAN_TYPE_MAP[finding.type] ?? [];
      for (const code of codes) {
        const entry = byCode.get(code) ?? { status: 'absent', evidence: [], rules: [] };
        entry.status = 'finding';
        entry.evidence.push(`${finding.type}: ${(finding.evidence ?? []).slice(0, 2).join('；')}`);
        entry.rules.push(`human-analytics:${finding.type}`);
        byCode.set(code, entry);
      }
    }
    for (const inconclusive of player.inconclusives ?? []) {
      const codes = HUMAN_TYPE_MAP[inconclusive.type] ?? [];
      for (const code of codes) {
        if (byCode.get(code)?.status === 'finding') continue;
        const entry = byCode.get(code) ?? { status: 'absent', evidence: [], rules: [] };
        entry.status = 'inconclusive';
        entry.evidence.push(`${inconclusive.type}: ${inconclusive.reason}`);
        entry.rules.push(`human-analytics:${inconclusive.type}`);
        byCode.set(code, entry);
      }
    }
    const labels = FAILURE_LABELS.map(({ code }) => {
      const entry = byCode.get(code) ?? { status: 'absent', evidence: ['无该类证据'], rules: ['human-analytics:absent'] };
      return label(code, entry.status, entry.evidence, entry.rules.join('+'));
    });
    rows.push({ seat: player.seat, name: player.name ?? null, labels });
  }
  return {
    schema: SCHEMAS.failureLabels,
    source: 'training/human-analytics/failures.mjs failures.json',
    sourceGames: failures.game ? [failures.game] : [],
    rows,
    discipline: '只使用 finding/inconclusive 结构化结论；不重算对局',
  };
}

/** 从单局可观察事实计算标签（轻量演示/开发对局用）。 */
export function labelsFromGameFacts(facts) {
  assertCondition(facts && typeof facts === 'object', 'game facts 必须为对象');
  const labels = [];
  const golems = facts.golems ?? null;
  const acquired = facts.merchantsAcquired ?? null;
  const conversion = facts.conversionPer100Actions ?? null;
  const lowEngine = (golems !== null && golems <= 1 && acquired !== null && acquired <= 2)
    || (conversion !== null && conversion < 8);
  labels.push(lowEngine
    ? label('engine-deficiency', 'finding', [`魔像 ${golems}, 获卡 ${acquired}, 每百行动得分 ${conversion}`], 'low-engine-and-conversion')
    : label('engine-deficiency', 'absent', ['引擎产出未低于阈值'], 'low-engine-and-conversion'));

  const contested = facts.contestedMisses ?? null;
  labels.push(contested !== null && contested >= 3
    ? label('contest-loss', 'finding', [`竞争机会 ${contested} 次`], 'contested>=3')
    : label('contest-loss', contested !== null && contested >= 1 ? 'inconclusive' : 'absent',
      [`竞争机会 ${contested ?? 'n/a'} 次`], 'contested>=3'));
  labels.push(contested !== null && contested >= 3
    ? label('claim-delay', 'finding', [`竞争机会 ${contested} 次未转化`], 'contested>=3')
    : label('claim-delay', contested !== null && contested >= 1 ? 'inconclusive' : 'absent',
      [`竞争机会 ${contested ?? 'n/a'} 次`], 'contested>=3'));

  const restRatio = facts.restRatio ?? null;
  const meanRest = facts.gameMeanRestRatio ?? null;
  labels.push(restRatio !== null && meanRest !== null && restRatio > meanRest * 1.5 && restRatio > 0.15
    ? label('rest-waste', 'finding', [`休息占比 ${restRatio} vs 全场 ${meanRest}`], 'rest-ratio>1.5x-and>0.15')
    : label('rest-waste', 'absent', [`休息占比 ${restRatio ?? 'n/a'} vs 全场 ${meanRest ?? 'n/a'}`], 'rest-ratio>1.5x-and>0.15'));

  const discarded = facts.crystalsDiscarded ?? null;
  labels.push(discarded !== null && discarded >= 3
    ? label('capacity-waste', 'finding', [`弃置 ${discarded} 颗水晶`], 'discarded>=3')
    : label('capacity-waste', discarded !== null && discarded >= 1 ? 'inconclusive' : 'absent',
      [`弃置 ${discarded ?? 'n/a'} 颗`], 'discarded>=3'));

  const triggerRank = facts.triggerRank ?? null;
  const triggerCount = facts.triggerCount ?? null;
  const postTriggerMissed = facts.postTriggerMissed ?? null;
  const endgameBad = (triggerRank !== null && triggerCount !== null && triggerRank === triggerCount)
    || (postTriggerMissed !== null && postTriggerMissed >= 2);
  labels.push(endgameBad
    ? label('endgame-error', 'finding', [
      `触发时排名 ${triggerRank}/${triggerCount}；触发后错过认领 ${postTriggerMissed ?? 'n/a'} 次`,
    ], 'trigger-last-or-post-trigger-missed>=2')
    : label('endgame-error', 'absent', ['无终局节奏错误信号'], 'trigger-last-or-post-trigger-missed>=2'));
  return labels;
}

/** 合并多份标签结果：finding 优先，统计证据条数与出现次数。 */
export function mergeLabels(labelCollections) {
  const merged = new Map(FAILURE_LABELS.map(({ code }) => [code, {
    code, label: LABEL_BY_CODE.get(code).label, status: 'absent', evidence: [], occurrences: 0,
  }]));
  for (const collection of labelCollections) {
    const rows = collection.rows ?? [];
    for (const row of rows) {
      for (const item of row.labels ?? []) {
        const target = merged.get(item.code);
        assertCondition(target, `未知标签：${item.code}`);
        if (STATUS_ORDER[item.status] > STATUS_ORDER[target.status]) target.status = item.status;
        if (item.status !== 'absent') {
          target.occurrences += 1;
          target.evidence.push(...item.evidence.map(e => `${row.seed ?? row.seat ?? 'row'}: ${e}`));
        }
      }
    }
  }
  return {
    schema: SCHEMAS.failureLabels,
    labels: [...merged.values()].map(item => ({
      ...item,
      evidence: [...new Set(item.evidence)].slice(0, 12),
    })),
    ruleVersion: 'ai7-failure-labels-v1',
  };
}

const LABEL_TARGET_HINTS = Object.freeze({
  'engine-deficiency': ['engineValue', 'keepValue', 'searchBudget'],
  'claim-delay': ['candidateCap', 'overrideMargin', 'goalValue'],
  'rest-waste': ['restValue', 'searchBudget'],
  'capacity-waste': ['keepValue', 'acquisitionValue'],
  'endgame-error': ['goalValue', 'overrideMargin'],
  'contest-loss': ['acquisitionValue', 'overrideMargin', 'candidateCap'],
});

export const RESEARCH_HINT_DISCIPLINE = deepFreeze({
  advisoryOnly: true,
  notRewardTruth: true,
  rewardModified: false,
  canPromote: false,
  note: '失败标签只用于研究提示与课程配置，不进入任何奖励/评分真值',
});

/** 标签 → 研究提示 + 课程配置（显式 advisoryOnly，禁止奖励化）。 */
export function toResearchHints(mergedLabels) {
  assertCondition(mergedLabels && Array.isArray(mergedLabels.labels), 'mergedLabels.labels 缺失');
  const actionLabels = mergedLabels.labels.filter(l => l.status !== 'absent');
  const touched = new Set();
  const suggestedTargets = [];
  const promptHints = [];
  for (const item of actionLabels) {
    for (const target of LABEL_TARGET_HINTS[item.code] ?? []) {
      if (!touched.has(target)) { touched.add(target); suggestedTargets.push(target); }
    }
    promptHints.push(`研究提示（${item.label}）：${item.evidence[0] ?? '见诊断证据'}；优先探索 ${LABEL_TARGET_HINTS[item.code]?.join('/') ?? '相关目标'}，需独立回归验证。`);
  }
  const curriculum = {
    schema: 'century-evolution-curriculum-v1',
    focusLabels: actionLabels.map(l => ({ code: l.code, label: l.label, status: l.status, occurrences: l.occurrences })),
    targetPriority: suggestedTargets,
    advisoryOnly: true,
    notRewardTruth: true,
    rewardModified: false,
  };
  return deepFreeze({
    schema: 'century-evolution-research-hints-v1',
    discipline: RESEARCH_HINT_DISCIPLINE,
    suggestedTargets,
    promptHints,
    curriculum,
    hintDigest: sha256Canonical({ suggestedTargets, promptHints, curriculum }),
  });
}
