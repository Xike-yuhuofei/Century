/** 墙钟批次准入的纯函数（可在测试中固定时间，不依赖 performance.now）。
 *
 * 背景（c83f C04/C12 + agent-a C9）：
 * - 旧门槛只乘候选数 M，漏掉信念世界数 W，实际整批是 W×M 条轨迹；
 * - 严格按 W×M×5ms 预检会在 100ms 下普遍饥饿，把有益仲裁退回冠军；
 * - 实测 48 转移轨迹约 2.2–2.8ms（0.05–0.06ms/转移），因此 balanced
 *   模式用 2.5ms 保底，并在时间不足 W 个世界时执行**全候选**缩减批次。
 *
 * 本模块只做算术；批次执行仍由 champion-guided.ts 保证"全候选共同键集"。
 */

export type BatchAdmission = 'legacy' | 'balanced';

export const LEGACY_TRIAL_FLOOR_MS = 5;
export const BALANCED_TRIAL_FLOOR_MS = 2.5;

export function trialFloorMs(admission: BatchAdmission): number {
  return admission === 'balanced' ? BALANCED_TRIAL_FLOOR_MS : LEGACY_TRIAL_FLOOR_MS;
}

/** 完整批次（W×M）与最小批次（1×M，全候选）的启动门槛。 */
export function batchFloors(admission: BatchAdmission, worlds: number, candidates: number): {
  fullBatchFloorMs: number; minBatchFloorMs: number; trialFloorMs: number;
} {
  const floor = trialFloorMs(admission);
  return {
    trialFloorMs: floor,
    fullBatchFloorMs: worlds * candidates * floor,
    minBatchFloorMs: candidates * floor,
  };
}

/** balanced 模式下，给定剩余窗口可容纳的世界数（1..worlds；不足最小批次返回 0）。 */
export function fitWorlds(remainingMs: number, worlds: number, candidates: number): number {
  const minBatchFloorMs = candidates * BALANCED_TRIAL_FLOOR_MS;
  if (!(remainingMs >= minBatchFloorMs)) return 0;
  return Math.min(worlds, Math.max(1, Math.floor(remainingMs / (candidates * BALANCED_TRIAL_FLOOR_MS))));
}
