// Provider-owned estimate, not a Harbor pool-depth/volatility model. The pinned
// Fusion SDK maps QuoterResponse.autoK to Quote.slippage (percent). Auto never
// silently accepts more than 1%; wider limits require an explicit manual choice.
export const MAX_AUTO_SLIPPAGE_BPS = 100;
export function providerAutoSlippageBps(percent: number): number | null {
  const scaled = percent * 100;
  const bps = Math.round(scaled);
  // Reject missing/zero/wide/non-basis-point estimates rather than rounding up.
  return Number.isFinite(scaled) && Math.abs(scaled - bps) < 1e-8 && bps >= 1 && bps <= MAX_AUTO_SLIPPAGE_BPS ? bps : null;
}
