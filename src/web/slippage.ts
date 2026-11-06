// Manual maximum, independent of the provider-owned Auto estimate.
export function customSlippageBps(value: string): number | null {
  const normalized = value.replace(',', '.');
  if (/^\d{1,2}(?:\.\d{0,2})?$/.exec(normalized)?.[0] !== normalized) return null;
  const bps = Math.round(Number(normalized) * 100);
  return bps >= 1 && bps <= 2000 ? bps : null;
}
