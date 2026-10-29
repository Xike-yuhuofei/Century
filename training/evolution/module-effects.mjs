/** P1.3 补充：最小失败改动定位（观测性模块效应分析，纯函数）。
 *
 * 以 (round, parentId) 为可比层：层内候选共享该轮的 screen 种子窗口。对每个种子
 * 计算"改动包含模块 M"与"不包含 M"两侧 candidateFirst 均值差；同种子的 championFirst
 * 在差值中抵消。跨层用等权均值 + bootstrap 区间汇总。
 *
 * 纪律：这是观测性关联，不是因果；少于 3 层或无区间证据一律 inconclusive。
 */

function mean(list) {
  return list.reduce((sum, x) => sum + x, 0) / list.length;
}

function bootstrapCI(values, { iterations = 10000, seed = 0x9e3779b9 } = {}) {
  if (values.length < 2) return { lower: null, upper: null, mean: values.length ? values[0] : null };
  let state32 = seed >>> 0;
  const rand = () => {
    state32 = (state32 + 0x6d2b79f5) >>> 0;
    let t = state32;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const means = [];
  for (let i = 0; i < iterations; i += 1) {
    const sample = [];
    for (let j = 0; j < values.length; j += 1) {
      sample.push(values[Math.floor(rand() * values.length)]);
    }
    means.push(mean(sample));
  }
  means.sort((a, b) => a - b);
  const q = p => means[Math.min(means.length - 1, Math.max(0, Math.floor(p * means.length)))];
  return { lower: Number(q(0.025).toFixed(4)), upper: Number(q(0.975).toFixed(4)), mean: Number(mean(values).toFixed(4)) };
}

/** 以 (round, parentId) 分层；层内必须存在共享 seed 且 championFirst 一致。 */
function buildStrata(round, loadPairs) {
  const groups = new Map();
  for (const candidate of round.candidates ?? []) {
    if (!candidate.lineage) continue;
    if (!Number.isFinite(candidate.quick?.score?.firstPlaceDelta)) continue;
    const pairs = loadPairs(candidate);
    if (!pairs || !pairs.length) continue;
    const key = String(candidate.parentId ?? 'bootstrap');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ candidate, pairs });
  }
  const strata = [];
  for (const [parentId, members] of groups) {
    if (members.length < 2) continue;
    const seedMap = new Map();
    for (const member of members) {
      for (const pair of member.pairs) {
        if (pair.status !== 'finished') continue;
        if (!Number.isFinite(pair.seed) || !Number.isFinite(pair.candidateFirst)) continue;
        const entry = seedMap.get(pair.seed) ?? {
          seatCount: pair.seatCount,
          championFirst: pair.championFirst,
          values: new Map(),
        };
        entry.values.set(member.candidate.candidateId, pair.candidateFirst);
        if (entry.championFirst !== pair.championFirst || entry.seatCount !== pair.seatCount) {
          entry.inconsistent = true;
        }
        seedMap.set(pair.seed, entry);
      }
    }
    strata.push({
      round: round.round,
      parentId,
      members,
      seeds: [...seedMap.entries()].filter(([, v]) => !v.inconsistent),
    });
  }
  return strata;
}

/**
 * @param {object} options
 * @param {object} options.state campaign state（含 rounds[].candidates[]）
 * @param {(candidate: object) => Array<object>|null} options.loadPairs 返回该候选的配对记录
 */
export function analyzeModuleEffects({ state, loadPairs, bootstrapIterations = 10000, bootstrapSeed = 0x9e3779b9 }) {
  const strata = [];
  for (const round of state.rounds ?? []) {
    for (const stratum of buildStrata(round, loadPairs)) strata.push(stratum);
  }

  const moduleIds = [...new Set(
    strata.flatMap(s => s.members.flatMap(m => m.candidate.lineage.modulesChanged ?? [])),
  )].sort();

  const modules = [];
  for (const moduleId of moduleIds) {
    const perStratum = [];
    const seatEffects = new Map();
    for (const stratum of strata) {
      const withM = stratum.members.filter(m => (m.candidate.lineage.modulesChanged ?? []).includes(moduleId));
      const withoutM = stratum.members.filter(m => !(m.candidate.lineage.modulesChanged ?? []).includes(moduleId));
      if (!withM.length || !withoutM.length) continue;
      const diffs = [];
      for (const [seed, info] of stratum.seeds) {
        const sideMean = list => {
          const values = list.map(m => info.values.get(m.candidate.candidateId)).filter(Number.isFinite);
          return values.length ? mean(values) : null;
        };
        const a = sideMean(withM);
        const b = sideMean(withoutM);
        if (a === null || b === null) continue;
        diffs.push({ seed, seatCount: info.seatCount, diff: a - b });
      }
      if (diffs.length < 2) continue;
      perStratum.push({
        round: stratum.round,
        parentId: stratum.parentId,
        seeds: diffs.length,
        effect: Number(mean(diffs.map(d => d.diff)).toFixed(4)),
      });
      for (const d of diffs) {
        if (!seatEffects.has(d.seatCount)) seatEffects.set(d.seatCount, []);
        seatEffects.get(d.seatCount).push(d.diff);
      }
    }
    if (!perStratum.length) {
      modules.push({
        moduleId,
        strata: 0,
        seedComparisons: 0,
        effect: null,
        ci: { lower: null, upper: null, mean: null },
        direction: 'inconclusive',
        positiveStrata: 0,
        negativeStrata: 0,
        bySeatCount: {},
        note: '没有可比的同父代/同种子层',
      });
      continue;
    }
    const effects = perStratum.map(p => p.effect);
    const effect = Number(mean(effects).toFixed(4));
    const ci = bootstrapCI(effects, { iterations: bootstrapIterations, seed: bootstrapSeed });
    const bySeatCount = {};
    for (const [seatCount, list] of [...seatEffects.entries()].sort((a, b) => a[0] - b[0])) {
      bySeatCount[String(seatCount)] = {
        seeds: list.length,
        effect: Number(mean(list).toFixed(4)),
      };
    }
    const direction = perStratum.length < 3 ? 'inconclusive'
      : ci.lower !== null && ci.lower > 0 ? 'positive-association'
        : ci.upper !== null && ci.upper < 0 ? 'negative-association'
          : 'inconclusive';
    modules.push({
      moduleId,
      strata: perStratum.length,
      seedComparisons: perStratum.reduce((sum, p) => sum + p.seeds, 0),
      effect,
      ci,
      direction,
      positiveStrata: effects.filter(e => e > 0).length,
      negativeStrata: effects.filter(e => e < 0).length,
      bySeatCount,
    });
  }

  const removals = new Map();
  for (const stratum of strata) {
    for (const member of stratum.members) {
      const operator = member.candidate.lineage?.operator ?? '';
      const match = /ablation:remove-(M\d+)/.exec(operator);
      if (!match) continue;
      const moduleId = match[1];
      const entry = removals.get(moduleId) ?? { observations: 0, sumDelta: 0 };
      entry.observations += 1;
      entry.sumDelta += Number(member.candidate.quick?.score?.firstPlaceDelta ?? 0);
      removals.set(moduleId, entry);
    }
  }

  return {
    strata: strata.length,
    modules: modules.sort((a, b) => (a.effect ?? 0) - (b.effect ?? 0)),
    removals: [...removals.entries()].map(([moduleId, entry]) => ({
      moduleId,
      observations: entry.observations,
      meanQuickDelta: Number((entry.sumDelta / entry.observations).toFixed(4)),
      note: '消融候选的父代是捐赠精英，未与同层候选做配对，仅作计数观测',
    })).sort((a, b) => a.meanQuickDelta - b.meanQuickDelta),
  };
}
