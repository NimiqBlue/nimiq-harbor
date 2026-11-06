import type { VerifiedSwapReceipt } from './public-swap-recovery';
// Page-lifetime deduplication survives Swap remounts/recovery and account reselection.
// Receipt amounts are never inferred here; only the finalized verifier emits them.
const refreshed = new Set<string>();
export function claimSettlementRefresh(receipt: VerifiedSwapReceipt): boolean {
  const key = `${receipt.account}:${receipt.clientRequestId}:${receipt.orderHash}:${receipt.transactionHash}`;
  if (refreshed.has(key)) return false;
  refreshed.add(key);
  return true;
}
