// JSON-safe browser/backend execution contract. No signatures in status/history.
import type { QuoteRequest } from '../fusion/policy.js';
export type FusionExecutionState = 'prepared'|'approval-pending'|'approval-confirmed'|'permit-exposed'|'built'|'submitting'|'pending'|'unknown'|'filled'|'expired'|'cancelled'|'failed';
export interface FusionExecutionView {
  authorization?:'onchain-approval'; approvalTransactionHash?:string;
  id:string; account:string; clientRequestId:string; request:QuoteRequest;
  state:FusionExecutionState; settlementVerified:boolean; orderHash:string|null;
  createdAt:number; expiresAt:number; permit:{nonce:string;deadline:number};
  minimumReceiveAmount:string|null; deadline:number|null;
  deadlineMinutes?:number; orderDeadline?:number;
  confirmedMinimumReceiveAmount?:string; previewId?:string;
  minimumPolicy?:'sdk-executable-v1'; previewMinimumReceiveAmount?:string;
  buildOutcome?:'minimum-unavailable-not-published';
  providerStatus:string|null; transactionHash:string|null;
}
