/** 数据 Schema 版本与迁移入口（fail-closed）。
 *
 * 所有原始记录都带 schema 字段。当前只定义了 v1；未来格式升级必须在此注册
 * 显式迁移函数，读取旧数据时自动升级并在 manifest 中保留来源版本。
 * 未注册的旧/未知 schema 一律拒绝，绝不静默猜测或覆盖原始数据。
 */

export const CURRENT_SCHEMAS = Object.freeze({
  run: 'century-llm-run-v1',
  game: 'century-llm-game-v1',
  decision: 'century-llm-turn-v1',
  decisionEnvelope: 'century-llm-decision-envelope-v1',
  turnEnvelope: 'century-llm-turn-envelope-v1',
  manifest: 'century-llm-dataset-manifest-v1',
});

const MIGRATIONS = Object.freeze({
  run: Object.freeze({}),
  game: Object.freeze({}),
  decision: Object.freeze({}),
  turn: Object.freeze({}),
});

export function migrateSchema(kind, value) {
  if (!value || typeof value !== 'object' || typeof value.schema !== 'string') {
    throw new Error(`缺少 schema 字段（${kind}）`);
  }
  if (!(kind in CURRENT_SCHEMAS)) throw new Error(`未知数据种类：${kind}`);
  const current = CURRENT_SCHEMAS[kind];
  if (value.schema === current) return value;
  const migrate = MIGRATIONS[kind]?.[value.schema];
  if (!migrate) {
    throw new Error(`不支持的 ${kind} schema：${value.schema}（当前 ${current}，无注册迁移）`);
  }
  return migrate(value);
}
