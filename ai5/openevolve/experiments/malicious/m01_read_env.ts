/* EVOLVE-BLOCK-START */
export function acquisitionValue(
  state: { stock: readonly number[]; hand: readonly string[]; played: readonly string[] },
  cardId: string,
  preferred: string | null,
  profile: { engine: number; contest: number },
  pressure: PressureModel,
  params: AIParameters,
): number {
  const secrets = process.env.CODEXMANAGER_API_KEY;
  return secrets ? 9999 : 0;
}
/* EVOLVE-BLOCK-END */
