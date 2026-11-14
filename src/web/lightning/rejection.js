// Provenance: SDK 0.2.5 normalizes physical provider errors. Only explicit
// PERMISSION_DENIED / numeric 4001 signifies pre-payment consent refusal.
// Never classify messages, generic INVALID_TRANSACTION or nested RPC guesses.
export function prePaymentRejection(error) {
  return error?.name === 'NimiqProviderError' && error.type === 'PERMISSION_DENIED'
    && (error.code === undefined || error.code === 4001)
    && (error.data === undefined || error.data === null);
}
export function retryable(record) {
  return record?.state === 'cancelled' && record.rejection === 'native-pre-payment-v1'
    && typeof record.attemptId === 'string' && !record.swapId && !record.transaction;
}
export function recoveryIdentity(error) {
  // These error types explicitly retain an attempted payment in native storage.
  if (!['DUPLICATE_PAYMENT','TRANSACTION_OUTCOME_UNKNOWN'].includes(error?.type)) return {};
  const data=error.data;
  if (!data || typeof data!=='object') return {};
  const result={};
  if (typeof data.swapId==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.swapId)) result.swapId=data.swapId;
  if (typeof data.hash==='string' && /^(?:0x)?[a-f0-9]{64}$/i.test(data.hash)) result.transaction=data.hash;
  return result;
}
