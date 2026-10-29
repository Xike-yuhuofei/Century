#!/usr/bin/env node
/** P1.3 补充：最小失败改动定位（观测性模块效应分析）。
 *
 * 目的：在**同一轮、同一父代、同一配对种子**内，比较"改动包含模块 M"与"不包含 M"
 * 的配对第一名结果差异，给出每个模块的观测边际效应与样本量，用于下一轮研究的
 * 最小改动定位（例如：某层负增益主要由哪个模块改动贡献）。
 *
 * 方法：以 (round, parentId) 为可比层，层内候选共享该轮的 screen 种子窗口；
 * 对每个种子计算两侧 candidateFirst 均值差（championFirst 同种子相同，在差值中
 * 抵消），得到配对差值样本；跨层用等权均值与 bootstrap 区间汇总。
 *
 * 纪律：
 * - 这是**观测性**分析，不是因果结论；跨层汇总仍可能受生成算子差异混杂；
 * - 少于 3 层的模块不给方向性标签，区间跨 0 一律 inconclusive；
 * - 不使用隐藏牌序，不构造使用未公开信息的反事实；
 * - 深验每轮只有 1 个候选，层内无法比较，因此不使用深验数据。
 *
 * 用法：node training/scripts/ai11-module-effects.mjs --campaign ai11-6h-v4 [--out ...]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { REPO_ROOT } from '../lib/paths.mjs';
import { analyzeModuleEffects } from '../evolution/module-effects.mjs';

const args = process.argv.slice(2);
function arg(name, fallback = null) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return fallback;
  const next = args[index + 1];
  return next === undefined || next.startsWith('--') ? true : next;
}
const campaign = String(arg('campaign', ''));
if (!campaign) {
  console.error('必须指定 --campaign');
  process.exit(2);
}
const root = resolve(REPO_ROOT, 'training/reports/coevolution', campaign);
const state = JSON.parse(readFileSync(join(root, 'state.json'), 'utf8'));

function loadPairs(candidate) {
  const evidencePath = candidate?.quick?.evidencePath;
  if (!evidencePath) return null;
  const abs = resolve(REPO_ROOT, evidencePath);
  if (!existsSync(abs)) return null;
  const evidence = JSON.parse(readFileSync(abs, 'utf8'));
  return Array.isArray(evidence.pairs) ? evidence.pairs : [];
}

const analysis = analyzeModuleEffects({ state, loadPairs });

const report = {
  schema: 'century-ai11-module-effects-v1',
  generatedAt: new Date().toISOString(),
  campaign,
  sourceState: `training/reports/coevolution/${campaign}/state.json`,
  method: 'same-(round,parent,seed) candidateFirst 差值；跨层等权均值 + 10000 次 bootstrap 95% 区间',
  rounds: state.rounds.length,
  strata: analysis.strata,
  modules: analysis.modules,
  removals: analysis.removals,
  limitations: [
    '观测性关联，不是因果；同层父代相同但生成算子可能不同',
    'screen 层每候选仅 4 对（2–5 人各 1），单层效应方差大，方向性标签依赖跨层一致性',
    '深验每轮仅 1 个候选，无法在层内比较，因此未使用深验数据',
    '不得据此自动淘汰模块；只能作为下一轮研究简报的最小改动候选线索',
  ],
};

const outPath = arg('out', null);
const text = JSON.stringify(report, null, 2);
if (outPath) {
  const abs = resolve(REPO_ROOT, String(outPath));
  writeFileSync(abs, text);
  console.log(JSON.stringify({
    written: abs,
    rounds: report.rounds,
    strata: report.strata,
    modules: report.modules.filter(m => m.strata > 0).map(m => ({
      moduleId: m.moduleId, strata: m.strata, effect: m.effect, direction: m.direction,
    })),
  }, null, 2));
} else {
  console.log(text);
}
