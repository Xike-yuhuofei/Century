/** CI 变更范围分类（纯函数，可单元测试）。
 *
 * 设计原则：
 * - 失败关闭：无法确定 diff 时按全量代码检查处理，绝不因为 diff 失败而跳过测试。
 * - 共享模块显式白名单：引擎、AI 决策、卡牌数据、依赖锁、训练公共库、审计工具、
 *   CI 自身变更都会触发对应的高成本检查。
 * - 文档/报告类变更不触发 web/training 大规模测试；但规则校验与 CI 元测试始终运行。
 */

export const DEFAULT_SCOPE = Object.freeze({
  build: false,
  web: false,
  training: false,
  ai5: false,
  ui: false,
  simulation: false,
  audit: false,
  research: false,
  promotion: false,
  pages: false,
  rules: true,
  governance: true,
  docsOnly: false,
});

/** 文档/说明类路径：不进入代码测试范围。 */
export function isDocPath(file) {
  const p = file.replaceAll('\\', '/');
  if (p.endsWith('.md')) return true;
  if (p.startsWith('docs/')) return true;
  if (p.startsWith('.screenshots/')) return true;
  if (p.startsWith('web-v1/design-5p/')) return true;
  if (p.startsWith('web-v1/benchmarks/')) return true;
  if (p.startsWith('training/reports/') && p.endsWith('.md')) return true;
  return false;
}

const hasPrefix = (files, prefixes) => files.some(f => prefixes.some(p => f.startsWith(p)));
const hasExact = (files, paths) => files.some(f => paths.includes(f));

/** web 侧代码变更（含测试/构建脚本），文档除外。 */
function isWebChange(files) {
  return files.some(f => !isDocPath(f) && (
    f.startsWith('web-v1/src/') ||
    f.startsWith('web-v1/tests/') ||
    f.startsWith('web-v1/scripts/') ||
    f === 'web-v1/index.html' ||
    f === 'web-v1/tsconfig.json' ||
    f === 'web-v1/package.json' ||
    f === 'web-v1/package-lock.json'
  ));
}

/** UI 相关变更（页面、样式、构建脚本、浏览器冒烟脚本）。 */
function isUiChange(files) {
  return files.some(f => !isDocPath(f) && (
    f.startsWith('web-v1/src/') ||
    f.startsWith('web-v1/scripts/') ||
    f === 'web-v1/index.html' ||
    f === 'web-v1/package.json' ||
    f === 'web-v1/package-lock.json' ||
    f === 'data/cards.json'
  ));
}

/**
 * 分类变更集合。
 * @param {string[]} files 变更文件（仓库相对路径）
 * @param {{labels?: string[], forceFull?: boolean, forceAll?: boolean, forcePromotion?: boolean}} [options]
 */
export function classifyChanges(files, options = {}) {
  const labels = (options.labels ?? []).map(String);
  const list = [...new Set(files.map(f => f.replaceAll('\\', '/')).filter(Boolean))];
  const scope = { ...DEFAULT_SCOPE };

  const promotionByLabel = labels.includes('promotion');
  // 只把真正的晋级产物视为 promotion：参数区、当前冠军、历史归档。
  // version-lock / revalidation-required / candidates 等治理与候选资料不等同于
  // 一次正式晋级，避免信任基础类变更新增 REQUIRES_APPROVAL 阻断普通 PR。
  const promotionByPath = hasExact(list, ['web-v1/src/ai/parameters.ts', 'training/champions/champion.json']) ||
    hasPrefix(list, ['training/champions/archive/']);
  const promotion = Boolean(options.forcePromotion || promotionByLabel || promotionByPath);

  // 共享核心：任何一项变化都足以影响 web 单测、训练单测、模拟与审计。
  const coreCode = hasPrefix(list, [
    'web-v1/src/engine.ts',
    'web-v1/src/ai/',
    'web-v1/src/js/',
    'web-v1/src/om/',
    'web-v1/src/sim/',
    'web-v1/src/data.ts',
  ]) || hasExact(list, [
    'data/cards.json',
    'web-v1/package.json',
    'web-v1/package-lock.json',
    'web-v1/tsconfig.json',
  ]);

  const ciSelf = hasPrefix(list, ['.github/workflows/', 'scripts/ci/']);
  const trainingCode = list.some(f => !isDocPath(f) && f.startsWith('training/') && !f.startsWith('training/reports/'));
  const trainingEvidence = list.some(f => !isDocPath(f) && f.startsWith('training/reports/'));
  const trainingShared = hasPrefix(list, ['training/lib/', 'training/redteam/']) || hasExact(list, ['training/package.json']);
  const ai5Code = list.some(f => !isDocPath(f) && f.startsWith('ai5/'));
  const ai5Shared = hasPrefix(list, ['ai5/lib/']);
  const seedShared = hasExact(list, ['training/lib/seeds.mjs', 'training/evaluator/stats.mjs']);
  const championArtifacts = hasPrefix(list, ['training/champions/']);
  const simulatorCode = hasPrefix(list, ['training/simulator/']);
  const web = isWebChange(list);

  scope.web = web || coreCode || ciSelf;
  scope.training = trainingCode || trainingShared || ai5Shared || coreCode || ciSelf;
  scope.ai5 = ai5Code;
  scope.research = ai5Code || ai5Shared || seedShared || hasPrefix(list, ['training/redteam/']);
  scope.ui = isUiChange(list) || coreCode || ciSelf;
  scope.simulation = coreCode || ciSelf || simulatorCode || championArtifacts ||
    hasExact(list, ['web-v1/src/data.ts', 'data/cards.json']);
  scope.audit = coreCode || ciSelf || trainingCode || trainingEvidence || trainingShared || ai5Code;
  scope.promotion = promotion;
  scope.pages = isUiChange(list) || coreCode || ciSelf || hasExact(list, ['data/cards.json']);
  scope.rules = true;
  scope.governance = true;
  scope.docsOnly = list.length > 0 && list.every(isDocPath);

  if (options.forceFull) {
    scope.web = true;
    scope.training = true;
    scope.ui = true;
    scope.simulation = true;
    scope.audit = true;
    scope.pages = true;
  }
  if (options.forceAll) {
    scope.ai5 = true;
    scope.research = true;
  }
  if (promotion) {
    // 晋级必须覆盖全部代码检查，不能只跑晋级层。
    scope.web = true;
    scope.training = true;
    scope.ui = true;
    scope.simulation = true;
    scope.audit = true;
  }
  scope.build = scope.web || scope.training || scope.ai5 || scope.ui ||
    scope.simulation || scope.audit || scope.promotion || scope.research;

  const reasons = [];
  if (promotionByLabel) reasons.push('label:promotion');
  if (promotionByPath) reasons.push('promotion-artifacts');
  if (coreCode) reasons.push('shared-core');
  if (ciSelf) reasons.push('ci-self');
  if (trainingShared) reasons.push('training-shared');
  if (ai5Shared) reasons.push('ai5-shared');
  if (options.forceFull) reasons.push('force-full');

  return {
    ...scope,
    changedCount: list.length,
    files: list,
    reasons,
  };
}

/** 任何触发审计的代码/证据变更都运行 research 层（research 层包含 dev）；
 * research 作业仍只由 AI5/种子/审计工具等研究变更触发，二者解耦。 */
export function auditTier(scope) {
  return scope.audit ? 'research' : 'dev';
}

/** 汇总作业独立复算分类结果，与 changes 作业输出逐字段对账。 */
export function compareScopes(expected, actual) {
  const keys = ['build', 'web', 'training', 'ai5', 'ui', 'simulation', 'audit', 'research', 'promotion', 'pages'];
  const mismatches = keys
    .filter(k => Boolean(expected[k]) !== Boolean(actual[k]))
    .map(k => `${k}: changes=${Boolean(expected[k])} recompute=${Boolean(actual[k])}`);
  return { ok: mismatches.length === 0, mismatches };
}

export function scopeToOutputs(scope) {
  const bool = v => (v ? 'true' : 'false');
  return {
    build: bool(scope.build),
    web: bool(scope.web),
    training: bool(scope.training),
    ai5: bool(scope.ai5),
    ui: bool(scope.ui),
    simulation: bool(scope.simulation),
    audit: bool(scope.audit),
    research: bool(scope.research),
    promotion: bool(scope.promotion),
    pages: bool(scope.pages),
    rules: bool(scope.rules),
    governance: bool(scope.governance),
    docs_only: bool(scope.docsOnly),
    audit_tier: auditTier(scope),
    changed_count: String(scope.changedCount ?? 0),
    files_sample: (scope.files ?? []).slice(0, 40).join('\n'),
    reasons: (scope.reasons ?? []).join(', '),
  };
}
