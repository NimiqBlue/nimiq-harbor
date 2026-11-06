// Fixed phase diagnostics only. Never include RPC URLs, request data, upstream
// messages/codes, signatures, addresses or a cause containing those details.
export const preparationRpcMessages = Object.freeze({
  FUSION_PREPARATION_RPC_CHAIN: 'Polygon chain identity read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_HEAD: 'Polygon latest head read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_NONCE: 'Polygon permit nonce read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_DOMAIN: 'Polygon permit domain read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_BALANCE: 'Polygon input balance read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_ALLOWANCE: 'Polygon router allowance read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_INPUT_CODE: 'Polygon input token code read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_OUTPUT_CODE: 'Polygon output token code read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_ROUTER_CODE: 'Polygon router code read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_SETTLEMENT_CODE: 'Polygon settlement code read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_ORDER_NONCE: 'Polygon order invalidator read failed. No automatic retry.',
  FUSION_PREPARATION_RPC_CANONICALITY: 'Polygon canonical block recheck failed. No automatic retry.',
});
export type PreparationRpcCode = keyof typeof preparationRpcMessages;
export class PreparationRpcFailure extends Error {
  constructor(public readonly code: PreparationRpcCode) {
    super(preparationRpcMessages[code]);
    this.name = 'PreparationRpcFailure';
  }
}
/** Wrap one physical read/decode, not validation or a mutable aggregate phase.
 * Concurrent read failures identify the first observed failing fixed phase. */
export async function preparationRpc<T>(code: PreparationRpcCode, read: () => Promise<T>): Promise<T> {
  try { return await read(); }
  catch { throw new PreparationRpcFailure(code); }
}
