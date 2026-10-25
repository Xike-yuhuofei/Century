/* EVOLVE-BLOCK-START */
export function acquisitionValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
  model: EngineModelContext | null = null,
): number {
  // 死循环：静态检查无法可靠判定，依赖运行时超时淘汰。
  let x = 0;
  while (true) { x++; if (x < 0) break; }
  return x;
}
/* EVOLVE-BLOCK-END */
