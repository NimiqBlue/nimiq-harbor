// Operator-only evidence inside the encrypted execution record. This is not a
// terminal state, permit revocation, public response, or authorization to replay.
import { readBuildEvidence, type BuildEvidence } from '../fusion/build-evidence.js';
import { AppError } from './config.js';
import { preparationRpcMessages } from '../shared/fusion-preparation-rpc.js';
import { readQuoteFailure, type QuoteFailureEvidence } from '../fusion/read-evidence.js';
export type BuildPhase = 'provider-quote'|'post-quote-snapshot'|'order-construction'|'order-validation'|'order-save';
const codes = new Set([
  ...Object.keys(preparationRpcMessages),
  'FUSION_UPSTREAM_UNAVAILABLE','FUSION_INVALID_RESPONSE','FUSION_ORDER_UNKNOWN',
  'FUSION_INVALID_PERMIT','FUSION_EXECUTION_CONFLICT','FUSION_DEADLINE_UNAVAILABLE',
  'FUSION_PREPARATION_RPC','FUSION_HEAD_INVALID','FUSION_HEAD_FUTURE','FUSION_HEAD_STALE',
  'FUSION_STATE_REORGANIZED','FUSION_CHAIN_MISMATCH','FUSION_INPUT_BALANCE',
  'FUSION_EXISTING_ALLOWANCE','FUSION_CODE_MISSING','FUSION_INVALID_SIGNATURE',
  'SESSION_REQUIRED','SESSION_EXPIRED','CSRF_REJECTED',
  'FUSION_BUILD_QUOTE','FUSION_BUILD_QUOTE_SCHEMA','FUSION_BUILD_QUOTE_ID_MISSING',
  'FUSION_BUILD_QUOTE_WHITELIST_ZERO','FUSION_BUILD_QUOTE_AMOUNT_MISMATCH',
  'FUSION_BUILD_PARTICIPANTS','FUSION_BUILD_INPUT',
  'FUSION_BUILD_DOMAIN','FUSION_BUILD_FILL_POLICY','FUSION_BUILD_EXPIRY',
  'FUSION_BUILD_SAVED_MINIMUM','FUSION_BUILD_PERMIT',
]);
export interface BuildFailure {phase:BuildPhase;code:string;at:number;evidence?:BuildEvidence;quote?:QuoteFailureEvidence}
export function buildFailure(phase:BuildPhase,error:unknown,at:number):BuildFailure {
  // Never retain an exception message, cause, upstream body or arbitrary code.
  const code=error instanceof AppError && codes.has(error.code)?error.code:'FUSION_BUILD_UNCLASSIFIED';
  const evidence=readBuildEvidence(error);
  const quote=readQuoteFailure(error);
  return {phase,code,at,...(evidence?{evidence}:{}),...(quote?{quote}:{})};
}
