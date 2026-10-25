/** 模拟评估分片计划（纯函数）：按种子区间连续切分，绝不重叠，合并后保持原 100 局覆盖。 */
export function planSimShards({ games, shards, seedBase }) {
  if (!Number.isSafeInteger(games) || games < 1) throw new Error('games 必须为正整数');
  if (!Number.isSafeInteger(shards) || shards < 1) throw new Error('shards 必须为正整数');
  if (!Number.isSafeInteger(seedBase) || seedBase < 0) throw new Error('seedBase 必须为非负整数');
  if (!Number.isSafeInteger(seedBase + games)) throw new Error('种子区间不在安全整数范围');
  const count = Math.min(shards, games);
  const base = Math.floor(games / count);
  const remainder = games % count;
  const plan = [];
  let cursor = seedBase;
  for (let i = 0; i < count; i++) {
    const shardGames = base + (i < remainder ? 1 : 0);
    plan.push({ index: i, games: shardGames, seedBase: cursor });
    cursor += shardGames;
  }
  return plan;
}
