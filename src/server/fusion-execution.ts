import { randomUUID } from 'node:crypto';
import { FusionOrder, Extension } from '@1inch/fusion-sdk';
import { recoverTypedDataAddress, hashTypedData, keccak256, stringToHex, type Hex } from 'viem';
import { z } from 'zod';
import { AppError } from './config.js';
import { publicationDiagnostic } from './fusion-publication-diagnostics.js';
import type { ProtectedPublicationResponse } from './fusion-publication-evidence.js';
import { FusionAdapter, type Fetch } from '../fusion/adapter.js';
import { FusionStore } from '../fusion/service.js';
import { quoteRequest, FUSION_BASE, evmAddress, uint, positive, type QuoteRequest } from '../fusion/policy.js';
import { prepareFusionPermit, encodeFusionPermit, buildLocalPermitOrder } from '../fusion/permit-preparation.js';
import { ExecutionStore, type ExecutionRecord } from './fusion-execution-store.js';
import type { ExecutionChain } from './fusion-execution-chain.js';
import type { FusionExecutionView } from '../shared/fusion-execution.js';
import { DEFAULT_SWAP_DEADLINE_MINUTES, fixedSwapDeadlineMinutesSchema, swapOrderDeadline } from '../shared/swap-deadline.js';
import { OrderDeadlineUnavailable } from '../fusion/order-deadline.js';
import { PreparationFailure } from '../fusion/preparation-freshness.js';
import { PreparationRpcFailure } from '../shared/fusion-preparation-rpc.js';
import { buildFailure, type BuildPhase } from './fusion-build-diagnostics.js';
import { fusionNetFloor } from '../shared/fusion-net-output.js';
import { APPROVAL_TOKEN } from '../shared/usdt0-approval.js';

export const executionSignature=z.string().regex(/^0x[0-9a-fA-F]{128}(1b|1c)$/i).refine(sig=>{
  if(!/^0x[0-9a-fA-F]{128}(1b|1c)$/i.test(sig))return false;
  const r=BigInt(`0x${sig.slice(2,66)}`),s=BigInt(`0x${sig.slice(66,130)}`);
  return r>0n && r<0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n && s>0n && s<=0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
}).transform(v=>v.toLowerCase() as Hex);
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v=>v.toLowerCase() as Hex);
const statusSchema=z.object({
  orderHash:hash.optional(),maker:evmAddress.optional(),status:z.enum(['pending','filled','false-predicate','not-enough-balance-or-allowance','expired','partially-filled','wrong-permit','cancelled','invalid-signature','invalid-maker-traits','awaiting-signatures','unpublished']),
  order:z.object({salt:uint,maker:evmAddress,receiver:z.string(),makerAsset:evmAddress,takerAsset:evmAddress,makingAmount:positive,takingAmount:positive,makerTraits:uint}),
  // Official status examples permit null. It is not extension evidence; the
  // exact saved salt/hash and independent receipt remain mandatory below.
  extension:z.string().regex(/^0x[0-9a-fA-F]*$/).max(10000).nullable(),
  fills:z.array(z.object({txHash:hash,filledMakerAmount:positive,filledAuctionTakerAmount:positive,takerFeeAmount:uint.nullable()})).max(1),
});
function invalid(message:string):never {throw new AppError(409,'FUSION_EXECUTION_CONFLICT',message);}
// A failed local construction is not an uncertain publication. Keep the permit
// state/reservation intact; never expose operator diagnostics or infer non-use.
function minimumUnavailable(r:ExecutionRecord) {
  return (r.state==='permit-exposed' || r.state==='expired') && !r.built && !r.orderSignature && r.dispatchStarted===undefined &&
    r.buildFailure?.phase==='order-construction' && r.buildFailure.code==='FUSION_BUILD_SAVED_MINIMUM' &&
    r.buildFailure.evidence?.stage==='local-validation' && r.buildFailure.evidence.assertion==='net-output-below-saved-floor';
}
export function executionView(r:ExecutionRecord):FusionExecutionView {
  return {...(r.authorization ? {authorization:r.authorization,...(r.approvalTransactionHash ? {approvalTransactionHash:r.approvalTransactionHash} : {})} : {}),id:r.id,account:r.request.account,clientRequestId:r.clientRequestId,request:r.request,state:r.state,
    ...(minimumUnavailable(r) ? {buildOutcome:'minimum-unavailable-not-published' as const} : {}),
    settlementVerified:r.settlementVerified,orderHash:r.built?.orderHash ?? null,createdAt:r.createdAt,expiresAt:r.expiresAt,
    permit:{nonce:r.snapshot.nonce,deadline:r.permitDeadline},minimumReceiveAmount:r.built?.minimumReceiveAmount ?? null,
    deadline:r.built ? Number(r.built.deadline) : null,...(r.confirmedMinimumReceiveAmount === undefined ? {} : {confirmedMinimumReceiveAmount:r.confirmedMinimumReceiveAmount,previewId:r.previewId}),...(r.minimumPolicy === undefined ? {} : {minimumPolicy:r.minimumPolicy,previewMinimumReceiveAmount:r.previewMinimumReceiveAmount,previewId:r.previewId}),...(r.orderDeadline === undefined ? {} : {deadlineMinutes:r.deadlineMinutes,orderDeadline:r.orderDeadline}),providerStatus:r.providerStatus ?? null,transactionHash:r.transactionHash ?? null};
}
export function recoveryTypedData(challenge:{id:string;session:string;account:string;origin:string;expires:number}) {
  return {domain:{name:'Harbor execution recovery',version:'1',chainId:137},primaryType:'Recovery' as const,
    types:{Recovery:[{name:'account',type:'address'},{name:'session',type:'bytes32'},{name:'origin',type:'string'},{name:'challenge',type:'string'},{name:'deadline',type:'uint256'}]},
    message:{account:challenge.account as Hex,session:keccak256(stringToHex(challenge.session)),origin:challenge.origin,challenge:challenge.id,deadline:BigInt(Math.floor(challenge.expires/1000))}};
}
/** No SDK signer/provider and no automatic retries. Only the fixed official
 * presigned order POST is reachable after cryptographic checks + durable claim. */
export class FusionExecutionService {
  constructor(private readonly adapter:FusionAdapter,private readonly journal:ExecutionStore,private readonly budget:FusionStore,
    private readonly chain:ExecutionChain,private readonly apiKey:string,private readonly fetcher:Fetch=fetch,private readonly now:()=>number=Date.now){}
  get(session:string,id:string) {
    const r=this.journal.get(id,session);
    if(!r)throw new AppError(404,'FUSION_EXECUTION_NOT_FOUND','Execution not found in this session.');
    return r;
  }
  recover(session:string,requestId:string,account:string) {
    const r=this.journal.find(requestId,session);
    if(!r || r.request.account!==evmAddress.parse(account))throw new AppError(404,'FUSION_EXECUTION_NOT_FOUND','Execution not found in this session.');
    return executionView(r);
  }
  unsignedCancellation(session:string,id:string) {
    const receipt=this.journal.unsignedCancellation(id,session);
    if(!receipt)throw new AppError(404,'FUSION_EXECUTION_NOT_FOUND','Unsigned cancellation not found in this session.');
    return receipt;
  }
  cancelUnsigned(session:string,id:string,clientRequestId:string,authorize:()=>void=()=>{}) {
    const prior=this.journal.unsignedCancellation(id,session);
    if(prior) { if(prior.clientRequestId!==clientRequestId)invalid('Cancellation identity changed.');return prior; }
    const r=this.get(session,id);
    if(r.clientRequestId!==clientRequestId)invalid('Cancellation identity changed.');
    authorize();
    if(!this.journal.cancelUnsigned(r,this.now()))invalid('Unsigned cancellation cannot be proven. Keep recovery saved.');
    return this.unsignedCancellation(session,id);
  }
  history(session:string,account:string){return this.journal.list(session,evmAddress.parse(account)).map(executionView);}
  recoveryChallenge(session:string,account:string,origin:string) {
    const challenge=this.journal.createRecovery(session,evmAddress.parse(account),origin,this.now());
    const typedData=recoveryTypedData(challenge);
    return {challengeId:challenge.id,expiresAt:challenge.expires,typedData:{...typedData,message:{...typedData.message,deadline:typedData.message.deadline.toString()}}};
  }
  async recoverOwnership(session:string,challengeId:string,signatureInput:unknown,origin:string,authorize:()=>void=()=>{}) {
    const signature=executionSignature.parse(signatureInput),challenge=this.journal.recovery(challengeId,session,this.now());
    if(!challenge || challenge.origin!==origin)invalid('Ownership challenge expired or belongs to another session.');
    let maker='';
    try{maker=await recoverTypedDataAddress({...recoveryTypedData(challenge),signature});}catch{/* invalid proof */}
    if(maker.toLowerCase()!==challenge.account)throw new AppError(400,'FUSION_INVALID_SIGNATURE','Recovery requires a fresh non-spending wallet ownership signature.');
    authorize();this.journal.reattach(challengeId,session,this.now());
    return {executions:this.history(session,challenge.account)};
  }
  async prepare(session:string,requestId:string,input:QuoteRequest,authorize:()=>void=()=>{},deadlineMinutesInput:unknown=DEFAULT_SWAP_DEADLINE_MINUTES,review?:{previewId:string;minimumReceiveAmount:string;minimumPolicy?:'sdk-executable-v1'|undefined}) {
    const request=quoteRequest.parse(input);z.string().uuid().parse(requestId);
    const approval=request.tokenIn===APPROVAL_TOKEN;
    const deadlineMinutes=fixedSwapDeadlineMinutesSchema.parse(deadlineMinutesInput);
    if(review)review=z.object({previewId:z.string().uuid(),minimumReceiveAmount:positive,minimumPolicy:z.literal('sdk-executable-v1').optional()}).strict().parse(review);
    const sameReview=(r:ExecutionRecord)=>r.minimumPolicy===review?.minimumPolicy && (review===undefined || (r.previewId===review.previewId && (r.minimumPolicy ? r.previewMinimumReceiveAmount : r.confirmedMinimumReceiveAmount)===review.minimumReceiveAmount));
    // An explicit Review may reconcile bounded maker reservations from a lost
    // session. Expiry alone cannot release a genuinely filled order: its permit
    // nonce is consumed. Reuse exact-order finalized settlement AND unused-expiry
    // verification, with the original revision CAS and dispatch/no-replay guards.
    // No private prior view is returned, no ownership is moved, and no signature,
    // permit-bearing quote or order publication is requested by reconciliation.
    for(const prior of this.journal.unresolvedForExpiry(request.account)) {
      await this.reconcile(prior.session,prior.id,authorize);
    }
    if(this.journal.wasUnsignedCancelled(requestId,session))invalid('This unsigned request was cancelled. Start a new explicit review.');
    const existing=this.journal.find(requestId,session);
    if(existing) {
      if(JSON.stringify(existing.request)!==JSON.stringify(request) || (existing.deadlineMinutes ?? 10)!==deadlineMinutes || !sameReview(existing))invalid('Request ID belongs to a different intent.');
      if(existing.state==='prepared' && this.journal.hasUnresolved(request.account))throw new AppError(409,'FUSION_RECONCILIATION_REQUIRED','Another signed permit or order for this maker requires reconciliation before preparing a signature.');
      return executionView(existing);
    }
    if(this.journal.list(session,request.account).length>=100)throw new AppError(429,'FUSION_HISTORY_LIMIT','Execution history limit reached. Contact the operator; do not discard unresolved orders.');
    if(this.journal.hasUnresolved(request.account))throw new AppError(409,'FUSION_RECONCILIATION_REQUIRED','This maker has an unresolved saved order. Recover ownership and reconcile it before requesting another spending signature.');
    let confirmedMinimumReceiveAmount:string|undefined;
    if(review) {
      const preview=this.budget.get(z.string().uuid().parse(review.previewId),session);
      if(!preview || preview.expiresAt<=this.now() || JSON.stringify(preview.request)!==JSON.stringify(request))invalid('Fresh same-session quote required before permit consent.');
      const preset=preview.raw.presets[preview.raw.recommended_preset];
      if(preset.auctionDuration+preset.startAuctionIn>deadlineMinutes*60)throw new AppError(409,'FUSION_DEADLINE_UNAVAILABLE','The quoted provider auction cannot fit the selected deadline. No permit was requested.');
      confirmedMinimumReceiveAmount=fusionNetFloor(preview.raw.toTokenAmount,request.slippageBps,preset.tokenFee,preset.bankFee,preview.raw.fee.bps).toString();
      if(confirmedMinimumReceiveAmount!==positive.parse(review.minimumReceiveAmount))invalid('Reviewed net minimum changed.');
      // v1 preview is indicative only. Verify SDK structure/deadline here; its
      // refreshed executable net is reviewed explicitly before the ORDER signature.
      // Legacy clients retain the floor they were promised before permit consent.
      try { this.adapter.preflight(request,preview.raw,swapOrderDeadline(this.now(),deadlineMinutes),Math.floor(this.now()/1000),review.minimumPolicy==='sdk-executable-v1'); }
      catch(e) {
        if(e instanceof OrderDeadlineUnavailable)throw new AppError(409,'FUSION_DEADLINE_UNAVAILABLE','The SDK auction cannot fit the selected deadline. No permit was requested.');
        throw e;
      }
    }
    const snapshot=await this.snapshot(request,undefined,approval?0n:undefined);authorize();
    if(review && this.budget.get(review.previewId,session)!.expiresAt<=this.now())invalid('Quote expired during preparation; no signature requested.');
    const createdAt=this.now(),deadline=swapOrderDeadline(createdAt,deadlineMinutes);
    try{if(!approval)prepareFusionPermit({chainId:137,account:request.account,token:request.tokenIn,value:request.amount,deadline},snapshot,Math.floor(this.now()/1000));}
    catch(e){if(e instanceof PreparationFailure)throw new AppError(409,e.code,e.message);throw new AppError(409,'FUSION_PERMIT_PREFLIGHT','Token permit state is stale or incompatible.');}
    const r:ExecutionRecord={...(approval ? {authorization:'onchain-approval' as const} : {}),id:randomUUID(),session,clientRequestId:requestId,request,createdAt,...(review ? {previewId:review.previewId,...(review.minimumPolicy ? {minimumPolicy:review.minimumPolicy,previewMinimumReceiveAmount:confirmedMinimumReceiveAmount!} : {confirmedMinimumReceiveAmount:confirmedMinimumReceiveAmount!})} : {}),deadlineMinutes,orderDeadline:deadline,expiresAt:deadline*1000,permitDeadline:deadline,snapshot,state:'prepared',settlementVerified:false};
    try{this.journal.insert(r);}catch(e){
      const prior=this.journal.find(requestId,session);
      if(!prior) {
        if(this.journal.hasUnresolved(request.account))throw new AppError(409,'FUSION_RECONCILIATION_REQUIRED','This maker has an unresolved signed permit or order. Recover and reconcile it.');
        throw e;
      }
      if(JSON.stringify(prior.request)!==JSON.stringify(request) || (prior.deadlineMinutes ?? 10)!==deadlineMinutes || !sameReview(prior))invalid('Request ID belongs to a different intent.');
      if(prior.state==='prepared' && this.journal.hasUnresolved(request.account))throw new AppError(409,'FUSION_RECONCILIATION_REQUIRED','Another signed permit or order for this maker requires reconciliation.');
      return executionView(prior);
    }
    return executionView(r);
  }
  private async snapshot(request:QuoteRequest,built?:ExecutionRecord['built'],expectedApprovalAllowance?:bigint) {
    try{return await this.chain.snapshot(request,this.now,built,expectedApprovalAllowance);}
    catch(e){
      if(e instanceof PreparationRpcFailure)throw new AppError(503,e.code,e.message);
      if(e instanceof PreparationFailure)throw new AppError(409,e.code,e.message);
      throw new AppError(503,'FUSION_PREPARATION_RPC','Polygon preparation reads could not be validated. No automatic retry.');
    }
  }
  private async fresh(r:ExecutionRecord) {
    if(r.authorization==='onchain-approval') {
      if(r.permitDeadline-Math.floor(this.now()/1000)<30 || !r.approvalTransactionHash || !this.chain.verifyApproval)invalid('Approval or order deadline unavailable. Keep recovery and reset any residual allowance.');
      await this.chain.verifyApproval(r,r.approvalTransactionHash as Hex);
      return this.snapshot(r.request,r.built,BigInt(r.request.amount));
    }
    if(r.permitDeadline-Math.floor(this.now()/1000)<30)invalid('Permit is expired or too close to expiry.');
    const fresh=await this.snapshot(r.request,r.built);
    if(fresh.nonce!==r.snapshot.nonce || fresh.domainSeparator!==r.snapshot.domainSeparator)invalid('Permit nonce or domain changed. Never sign a replacement for an unresolved order.');
    try {prepareFusionPermit({chainId:137,account:r.request.account,token:r.request.tokenIn,value:r.request.amount,deadline:r.permitDeadline},fresh,Math.floor(this.now()/1000));}
    catch(e){if(e instanceof PreparationFailure)throw new AppError(409,e.code,e.message);invalid('Permit snapshot is stale or reorganized.');}
    return fresh;
  }
  buildView(r:ExecutionRecord) {
    if(!r.built)invalid('No exact order has been saved.');
    // Explicit build response only; status/history never export spending authority.
    return {...executionView(r),order:r.built.order,extension:r.built.extension,orderHash:r.built.orderHash,minimumReceiveAmount:r.built.minimumReceiveAmount,deadline:Number(r.built.deadline)};
  }
  async build(session:string,id:string,signatureInput:unknown,authorize:()=>void=()=>{}) {
    let r=this.get(session,id);
    if(r.authorization==='onchain-approval')invalid('This operation requires on-chain approval, not a token permit.');
    if(r.state==='built')return this.buildView(r);
    if(r.state!=='prepared')invalid('Execution already dispatched or requires reconciliation.');
    const signature=executionSignature.parse(signatureInput);
    const snapshot=await this.fresh(r);authorize();
    const permitInput={chainId:137,account:r.request.account,token:r.request.tokenIn,value:r.request.amount,deadline:r.permitDeadline};
    let encoded;
    try{encoded=await encodeFusionPermit(permitInput,snapshot,signature,Math.floor(this.now()/1000));}
    catch{throw new AppError(400,'FUSION_INVALID_SIGNATURE','Permit must be signed by the exact saved maker.');}
    authorize();this.budget.reserveQuote(this.now());
    try {
      if(!this.journal.expose(r,signature,this.now()))invalid('Signed permit exposure already claimed or another maker intent is unresolved. Reconcile; never retry the provider quote.');
    }catch{invalid('Signed permit exposure cannot be reserved. Reconcile before requesting another signature.');}
    r=this.get(session,id);
    // The encrypted signature and global reservation are durable BEFORE exposing
    // spending authority, even when the provider hangs or this process dies.
    // Sequential continuation phases, never shared with concurrent RPC reads.
    // Retain only bounded failure evidence; the exposure barrier remains intact.
    const exposed=r; // Immutable exposure revision, even if later readback changes r.
    let phase:BuildPhase='provider-quote';
    try {
      const raw=await this.adapter.quote(r.request,encoded.permit);authorize();
      if(!raw.source)invalid('Executable estimate must include a bounded provider-resolved source.');
      phase='post-quote-snapshot';
      const refreshed=await this.fresh(r);authorize();
      phase='order-construction';
      let built;
      try { built=await buildLocalPermitOrder(r.request,raw,refreshed,r.permitDeadline,signature,Math.floor(this.now()/1000),r.orderDeadline,r.confirmedMinimumReceiveAmount,r.minimumPolicy); }
      catch(e) {
        if(e instanceof OrderDeadlineUnavailable)throw new AppError(409,'FUSION_DEADLINE_UNAVAILABLE','Provider auction does not fit the selected deadline. The deadline was not extended and no order was built. The exposed permit still requires expiry reconciliation.');
        throw e;
      }
      authorize();
      phase='order-validation';
      // Independent SDK reconstruction verifies extension hash, receiver/domain and
      // exact token permit. Persist only after every validation, never rebuild on submit.
      const order=FusionOrder.fromDataAndExtension(built.order,Extension.decode(built.extension));
      if(order.getOrderHash(137)!==built.orderHash || order.extension.encode()!==built.extension || order.settlementExtensionContract.toString().toLowerCase()!=='0x2ad5004c60e16e54d5007c80ce329adde5b51ef5')invalid('SDK saved order reconstruction mismatch.');
      phase='order-save';
      const updated:ExecutionRecord={...r,built,quoteId:raw.quoteId!,state:'built',expiresAt:Math.min(this.now()+30_000,Number(built.deadline)*1000)};
      if(!this.journal.update(updated,'permit-exposed'))invalid('Execution changed after permit exposure; reconcile without rebuilding.');
      r=this.get(session,id);
      if(r.state!=='built')invalid('Execution changed while constructing order.');
      return this.buildView(r);
    } catch(error) {
      // Use the exact exposed revision: a concurrent reconciliation or save must
      // win over this diagnostic. Failure to record never masks the real error.
      let saved=false;
      try { saved=this.journal.update({...exposed,buildFailure:buildFailure(phase,error,this.now())},'permit-exposed'); } catch { /* storage unavailable; retain original failure */ }
      // Only the exact durable CAS winner may report this definite outcome.
      // Stale/reconciled revisions and failed persistence retain the original error.
      if(saved && minimumUnavailable(this.get(session,id)))throw new AppError(409,'FUSION_MINIMUM_UNAVAILABLE','No order published: executable output is below your saved minimum. The minimum was not lowered. The signed permit remains independently usable until expiry; recovery is required.');
      throw error;
    }
  }
  async requestApproval(session:string,id:string,authorize:()=>void=()=>{}) {
    const r=this.get(session,id);
    if(r.authorization!=='onchain-approval' || r.state!=='prepared' || r.permitDeadline-Math.floor(this.now()/1000)<30)invalid('Approval request is unavailable or already requested. Never resend automatically.');
    await this.snapshot(r.request,undefined,0n);authorize();
    if(r.permitDeadline-Math.floor(this.now()/1000)<30 || !this.journal.reserveApproval(r))invalid('Approval reservation changed. Recover status.');
    return executionView(this.get(session,id));
  }
  async confirmApproval(session:string,id:string,hashInput:unknown,authorize:()=>void=()=>{}) {
    let r=this.get(session,id);const txHash=hash.parse(hashInput);
    if(r.authorization!=='onchain-approval' || !['approval-pending','approval-confirmed'].includes(r.state))invalid('Approval cannot be attached to this operation.');
    if(r.approvalTransactionHash && r.approvalTransactionHash!==txHash)invalid('Approval transaction identity changed.');
    // Persist the hash even while mining/finality is unavailable. Never broadcast.
    if(!r.approvalTransactionHash) {
      authorize();if(!this.journal.update({...r,approvalTransactionHash:txHash},r.state))invalid('Approval journal changed.');r=this.get(session,id);
    }
    if(!this.chain.verifyApproval)invalid('Approval verification unavailable.');
    try { await this.chain.verifyApproval(r,txHash);await this.snapshot(r.request,undefined,BigInt(r.request.amount)); }
    catch {throw new AppError(409,'FUSION_APPROVAL_UNVERIFIED','Approval is not yet independently finalized and exact. Check status; do not send another transaction.');}
    authorize();if(!this.journal.update({...r,state:'approval-confirmed'},r.state))invalid('Approval changed during verification.');
    return executionView(this.get(session,id));
  }
  cancelRejectedApproval(session:string,id:string,authorize:()=>void=()=>{}) {
    const r=this.get(session,id);
    if(r.authorization!=='onchain-approval' || r.state!=='approval-pending' || r.approvalTransactionHash || r.built || r.dispatchStarted || this.journal.dispatched(id))invalid('Approval rejection cannot release this operation.');
    // Same-session client assertion, only for physical EIP-1193 rejection before
    // a hash was returned; never use this for timeout/disconnect/invalid replies.
    authorize();if(!this.journal.update({...r,state:'cancelled'},r.state))invalid('Approval changed before rejection cancellation.');
    return executionView(this.get(session,id));
  }
  async buildApproved(session:string,id:string,authorize:()=>void=()=>{}) {
    const r=this.get(session,id);
    if(r.authorization!=='onchain-approval' || r.state!=='approval-confirmed')invalid('Confirm the exact approval first.');
    await this.fresh(r);authorize();this.budget.reserveQuote(this.now());
    // Claim before the provider call. Even a failed/lost reply is never rebuilt.
    if(!this.journal.update({...r,state:'unknown'},r.state))invalid('Order construction already claimed.');
    const claimed:ExecutionRecord={...r,state:'unknown',revision:(r.revision??0)+1};
    const raw=await this.adapter.quote(r.request,undefined,false,undefined,true);authorize();
    if(!raw.source)invalid('Executable estimate requires a bounded provider source.');
    const snapshot=await this.fresh(r);authorize();
    const built=await buildLocalPermitOrder(r.request,raw,snapshot,r.permitDeadline,undefined,Math.floor(this.now()/1000),r.orderDeadline,r.confirmedMinimumReceiveAmount,r.minimumPolicy,'onchain-approval');
    const order=FusionOrder.fromDataAndExtension(built.order,Extension.decode(built.extension));
    if(order.extension.makerPermit!=='0x' || order.getOrderHash(137)!==built.orderHash || order.settlementExtensionContract.toString().toLowerCase()!=='0x2ad5004c60e16e54d5007c80ce329adde5b51ef5')invalid('No-permit Fusion reconstruction failed.');
    if(!this.journal.update({...claimed,built,quoteId:raw.quoteId!,state:'built',expiresAt:Math.min(this.now()+30_000,Number(built.deadline)*1000)},'unknown'))invalid('Order changed during construction.');
    return this.buildView(this.get(session,id));
  }
  async submit(session:string,id:string,signatureInput:unknown,authorize:()=>void=()=>{}) {
    const r=this.get(session,id);
    if(this.journal.dispatched(id))return executionView(r); // Never replay an attempted publication.
    if(r.state!=='built' || !r.built || !r.quoteId)invalid('Build and review an exact saved order first.');
    if(r.orderDeadline!==undefined && (Number(r.built.deadline)!==r.orderDeadline || r.permitDeadline!==r.orderDeadline))invalid('Saved order/permit deadline differs from the immutable preparation.');
    if(this.now()>=r.expiresAt || BigInt(r.built.deadline)<=BigInt(Math.floor(this.now()/1000)+15))invalid('Saved estimate/order expired; it cannot be submitted.');
    const signature=executionSignature.parse(signatureInput);
    const order=FusionOrder.fromDataAndExtension(r.built.order,Extension.decode(r.built.extension));
    if(r.authorization==='onchain-approval' && order.extension.makerPermit!=='0x')invalid('Approval orders must not contain a permit.');
    // The SDK can reconstruct fields from the extension instead of the raw
    // publication object. Bind that exact object too before accepting a signature.
    const rebuilt=order.build();
    if(Object.entries(r.built.order).some(([key,value])=>String(rebuilt[key as keyof typeof rebuilt]).toLowerCase()!==String(value).toLowerCase()) || order.extension.encode().toLowerCase()!==r.built.extension.toLowerCase())invalid('Saved order roundtrip mismatch.');
    const data=order.getTypedData(137);
    // viem and SDK independently agree on the domain and saved digest.
    if(hashTypedData(data)!==r.built.orderHash || order.getOrderHash(137)!==r.built.orderHash)invalid('Saved order digest mismatch.');
    let maker:string;
    try{maker=await recoverTypedDataAddress({...data,signature});}catch{maker='';}
    if(maker.toLowerCase()!==r.request.account)throw new AppError(400,'FUSION_INVALID_SIGNATURE','Order signature must recover the saved maker.');
    await this.fresh(r);authorize();
    if(this.now()>=r.expiresAt)invalid('Saved estimate expired during preflight.');
    r.orderSignature=signature;
    const dispatchStarted=this.now(),built=r.built;
    if(!this.journal.claim(r,dispatchStarted))return executionView(this.get(session,id));
    // Only claim winner can reach the network. Preserve the existing 201-only
    // acceptance rule (documented empty response); all other outcomes stay unknown.
    // Capture the exact claim revision BEFORE awaiting transport/body work. A
    // concurrent same-state or terminal reconciliation must win over this reply.
    const dispatched:ExecutionRecord={...r,state:'submitting',dispatchStarted,revision:(r.revision??0)+1};
    const signal=AbortSignal.timeout(10_000);
    let publicationResponseEvidence:ProtectedPublicationResponse|undefined;
    const diagnostic=await publicationDiagnostic(()=>this.fetcher(`${FUSION_BASE}/relayer/v2.0/137/order/submit`,{
        method:'POST',headers:{Authorization:`Bearer ${this.apiKey}`,Accept:'application/json','Content-Type':'application/json'},
        redirect:'error',signal,
        body:JSON.stringify({order:built.order,signature,quoteId:r.quoteId,extension:built.extension}),
      }),signal,this.now,{save:e=>{publicationResponseEvidence=e;},reflections:[this.apiKey,signature,r.permitSignature??'',built.extension,r.request.account]});
    const accepted=diagnostic.outcome==='http' && diagnostic.httpStatus===201;
    try {
      this.journal.update({...dispatched,state:accepted?'pending':'unknown',publicationDiagnostic:diagnostic,...(publicationResponseEvidence?{publicationResponseEvidence}:{})},'submitting');
    }catch{
      // Storage/crash can still lose the response, but never the durable claim.
      // Do not export storage errors or imply that publication can be retried.
      throw new AppError(503,'FUSION_PUBLICATION_EVIDENCE_UNAVAILABLE','Publication outcome could not be saved. Keep recovery; never resubmit.');
    }
    return executionView(this.get(session,id));
  }
  async reconcile(session:string,id:string,authorize:()=>void=()=>{}):Promise<FusionExecutionView> {
    const r=this.get(session,id);
    if(r.state==='expired')return executionView(r);
    if(!r.verifiedBlockHash && this.now()>r.permitDeadline*1000) {
      let expired=false;try{expired=await this.chain.expiredUnused(r);}catch{/* no finalized proof => retain unresolved */}
      authorize();
      if(expired) {
        this.journal.update({...r,state:'expired',settlementVerified:false},r.state);
        return executionView(this.get(session,id));
      }
    }
    if(!r.built || !this.journal.dispatched(id))return executionView(r);
    const updated:ExecutionRecord={...r,state:'unknown',settlementVerified:false};
    // Once a receipt is discovered, provider outages must not erase independent
    // chain evidence. Recheck canonical finality on every subsequent recovery.
    if(r.transactionHash) {
      try {
        const proof=await this.chain.verify(r,r.transactionHash as Hex);authorize();
        if(proof.transactionHash.toLowerCase()!==r.transactionHash.toLowerCase() || proof.spent!==r.request.amount || BigInt(proof.received)<BigInt(r.built.minimumReceiveAmount))throw new Error('Saved proof mismatch');
        updated.state='filled';updated.settlementVerified=true;updated.verifiedBlockHash=proof.blockHash;
      }catch{/* A failed hint is not a permanent transaction identity. Keep it for
        provider-outage recovery, but permit another exact-order hint to be checked. */}
      if(updated.settlementVerified || r.verifiedBlockHash) {
        authorize();this.journal.update(updated,r.state);return executionView(this.get(session,id));
      }
    }
    try {
      const provider=statusSchema.parse(await this.adapter.status(r.built.orderHash));authorize();
      if((provider.orderHash && provider.orderHash!==r.built.orderHash) || (provider.maker && provider.maker!==r.request.account) || (provider.extension!==null && provider.extension.toLowerCase()!==r.built.extension.toLowerCase()) || Object.entries(r.built.order).some(([k,v])=>String(provider.order[k as keyof typeof provider.order]).toLowerCase()!==String(v).toLowerCase()))throw new Error('Provider order mismatch');
      // The documented null extension is not evidence of an extension, but the
      // exact saved order salt binds its hash; only an independent exact-hash
      // on-chain fill can establish settlement. Never reconstruct from null.
      updated.providerStatus=provider.status;
      if(provider.status==='pending')updated.state='pending';
      if(provider.fills.length===1) {
        const fill=provider.fills[0]!;
        if(fill.filledMakerAmount!==r.request.amount || BigInt(fill.filledAuctionTakerAmount)-BigInt(fill.takerFeeAmount??'0')<BigInt(r.built.minimumReceiveAmount))throw new Error('Provider fill mismatch');
        // Persist the exact candidate before RPC/finality checks. A resolver can
        // disappear from the provider before finality; restart must retain the
        // receipt identity without ever treating this hint as settlement.
        const candidate={...updated,transactionHash:fill.txHash,state:'unknown' as const};
        authorize();
        if(!this.journal.update(candidate,r.state))return executionView(this.get(session,id));
        const saved=this.get(session,id);
        try {
          const proof=await this.chain.verify(saved,fill.txHash);authorize();
          if(proof.transactionHash.toLowerCase()!==fill.txHash || proof.spent!==r.request.amount || BigInt(proof.received)<BigInt(r.built.minimumReceiveAmount))throw new Error('Candidate proof mismatch');
          this.journal.update({...saved,state:'filled',settlementVerified:true,verifiedBlockHash:proof.blockHash},saved.state);
        }catch{/* Keep the durable hint, but next reconciliation may replace it. */}
        return executionView(this.get(session,id));
      }
    }catch{/* Unknown is recoverable but never authorizes resubmission. */}
    // Do not let concurrent stale reads/late POST replies overwrite newer state.
    authorize();this.journal.update(updated,r.state);
    return executionView(this.get(session,id));
  }
}
