// Sample the reference after RPC completion. Public Polygon block 96278009
// was observed 1133ms ahead of this NTP-synchronized host (two integer seconds),
// with the same hash/timestamp independently confirmed by two public RPCs.
// This is a fixed two-whole-second ceiling, not an adaptive clock offset.
// Never widen maximum age, shift the current clock, or extend permit/order expiry.
export const MAX_SNAPSHOT_AGE_SECONDS = 60;
export const MAX_HEAD_CLOCK_SKEW_SECONDS = 2;
export type PreparationFailureCode = 'FUSION_HEAD_FUTURE' | 'FUSION_HEAD_STALE' | 'FUSION_HEAD_INVALID' | 'FUSION_STATE_REORGANIZED' | 'FUSION_CHAIN_MISMATCH' | 'FUSION_INPUT_BALANCE' | 'FUSION_EXISTING_ALLOWANCE' | 'FUSION_CODE_MISSING';
export class PreparationFailure extends Error {
  constructor(public readonly code: PreparationFailureCode, message: string) { super(message); this.name = 'PreparationFailure'; }
}
export function assertPreparationFreshness(timestamp: bigint, nowSeconds: number) {
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds <= 0 || timestamp <= 0n) throw new PreparationFailure('FUSION_HEAD_INVALID', 'Polygon head or server clock is invalid. Preparation stopped.');
  const now = BigInt(nowSeconds);
  if (timestamp > now + BigInt(MAX_HEAD_CLOCK_SKEW_SECONDS)) throw new PreparationFailure('FUSION_HEAD_FUTURE', 'Polygon head exceeds the bounded server-clock skew. Preparation stopped.');
  if (now - timestamp > BigInt(MAX_SNAPSHOT_AGE_SECONDS)) throw new PreparationFailure('FUSION_HEAD_STALE', 'Polygon head is more than 60 seconds old. Preparation stopped.');
}
