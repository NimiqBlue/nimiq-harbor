import { DEFAULT_SWAP_DEADLINE_MINUTES } from '../shared/swap-deadline';
import { useEffect, useRef, useState } from 'react';
import { formatUnits, type Hex } from 'viem';
import { APPROVAL_TOKEN, APPROVAL_SPENDER } from '../shared/usdt0-approval';
import { NimiqSpinner } from './NimiqSpinner';
import { ApiError } from './api';
import { TOKENS } from '../swap/registry';
import { displayAmount } from './swap-display';
import { executionApi, validatePrepared, validateBuilt, walletGuard, withExecutionLock, recoveryOrderEvidence, signExecution, readExecutionJournal, type PreparedExecution } from './fusion-execution';
import { approvalApi, approvalReadiness, checkApprovalTransaction, requestApprovalTransaction, readApprovalJournal, saveApprovalJournal, sameApprovalJournal, clearApprovalJournal, assertNoSwapJournal, validateApprovalStatus, InsufficientApprovalPol, ApprovalAllowanceMismatch, ApprovalTransactionRejected, type ApprovalJournal } from './usdt0-approval';
import { recoverApprovalSwap } from './approval-swap-recovery';
import { createStatusMonitor, monitorKey } from './swap-status-monitor';
import type { VerifiedSwapReceipt } from './public-swap-recovery';
import type { FusionExecutionProps } from './FusionExecution';

function amount(raw:string,address:string){const t=Object.values(TOKENS).find(t=>t.address.toLowerCase()===address);return t?`${displayAmount(formatUnits(BigInt(raw),t.decimals))} ${t.symbol==='USDT'?'USDT0':t.symbol}`:raw;}
export function ApprovalExecution({wallet,enabled,intent,previewFloor,previewId,previewValidUntil,onActivityChange,onSettlement,reviewBlockedReason='',deadlineMinutes=DEFAULT_SWAP_DEADLINE_MINUTES,settingsRevision=0}:FusionExecutionProps){
  const [journal,setJournal]=useState<ApprovalJournal|null>(null);
  const [blocked,setBlocked]=useState(false);
  const [busy,setBusy]=useState(false);
  const [message,setMessage]=useState('');
  const [cost,setCost]=useState<bigint|null>(null);
  const [reviewed,setReviewed]=useState<ReturnType<typeof validateBuilt>|null>(null);
  const [hashInput,setHashInput]=useState('');
  const [receipt,setReceipt]=useState<VerifiedSwapReceipt|null>(null);
  const generation=useRef(0),terminalReceiptAttempt=useRef(''),settlementCallback=useRef(onSettlement);settlementCallback.current=onSettlement;
  const active=useRef(false),mounted=useRef(true);
  const key=JSON.stringify({intent,deadlineMinutes,settingsRevision});
  const latest=useRef({wallet,key,enabled});latest.current={wallet,key,enabled};
  const context=useRef<{provider:NonNullable<typeof wallet.provider>;selection:number;key:string;invalid:boolean}|null>(null);
  useEffect(()=>{mounted.current=true;const load=()=>{generation.current++;setReceipt(null);try{setJournal(readApprovalJournal(localStorage));}catch{setBlocked(true);setMessage('Approval recovery is unreadable. New spending is blocked; do not clear storage.');}};load();window.addEventListener('storage',load);return()=>{mounted.current=false;window.removeEventListener('storage',load);if(context.current)context.current.invalid=true;};},[]);
  useEffect(()=>{onActivityChange?.(busy || Boolean(journal));},[busy,journal,onActivityChange]);
  useEffect(()=>{const c=context.current;if(c && (c.key!==key || c.provider!==wallet.provider || c.selection!==wallet.selectionRevision || !enabled)){c.invalid=true;setReviewed(null);setMessage('Review changed. Keep the saved approval recovery; no order will be sent automatically.');}},[key,wallet.provider,wallet.selectionRevision,enabled]);
  useEffect(()=>{const p=wallet.provider;if(!p)return;const invalidate=()=>{generation.current++;setReceipt(null);if(context.current)context.current.invalid=true;setReviewed(null);};p.on?.('accountsChanged',invalidate);p.on?.('chainChanged',invalidate);p.on?.('disconnect',invalidate);return()=>{p.removeListener?.('accountsChanged',invalidate);p.removeListener?.('chainChanged',invalidate);p.removeListener?.('disconnect',invalidate);};},[wallet.provider]);
  const write=(j:ApprovalJournal)=>{saveApprovalJournal(localStorage,j);if(mounted.current)setJournal(j);return j;};
  const exact=(j:ApprovalJournal)=>{if(!sameApprovalJournal(readApprovalJournal(localStorage),j))throw new Error('Saved approval changed');};
  const guard=async(p:PreparedExecution,j:ApprovalJournal)=>{
    const c=context.current;if(!c)throw new Error('Review unavailable');
    exact(j);
    await walletGuard(c.provider,p.request.account,()=>mounted.current && !c.invalid && latest.current.enabled && latest.current.key===c.key && latest.current.wallet.provider===c.provider && latest.current.wallet.selectionRevision===c.selection);
    exact(j);if(p.orderDeadline===undefined || p.orderDeadline*1000<=Date.now()+30_000)throw new Error('Order deadline expired');
  };
  const run=async(work:()=>Promise<void>)=>{
    if(active.current)return;active.current=true;setBusy(true);setMessage('');
    try{await withExecutionLock(work);}catch(e){setReviewed(null);if(mounted.current)setMessage(e instanceof InsufficientApprovalPol || e instanceof ApprovalAllowanceMismatch?e.message:e instanceof ApiError && (e.status===401 || e.status===404)?'The original Swap session or private operation is unavailable. Keep this approval recovery saved. Reconnecting the wallet alone does not restore session ownership. No transaction, order or recovery signature was retried.':'Approval/swap could not be verified. Keep recovery saved. Check status; never resend an uncertain transaction. Approval does not expire with the order. Reset residual allowance to zero when needed (requires POL).');}
    finally{active.current=false;if(mounted.current)setBusy(false);}
  };
  const review=()=>run(async()=>{
    if(!enabled || !intent || intent.tokenIn.toLowerCase()!==APPROVAL_TOKEN || !wallet.provider || !wallet.account || wallet.chainId!==137 || !previewId || !previewFloor || !previewValidUntil || previewValidUntil<=Date.now() || reviewBlockedReason)throw new Error('Not ready');
    assertNoSwapJournal(localStorage);
    context.current={provider:wallet.provider,selection:wallet.selectionRevision,key,invalid:false};
    const j=write({version:1,account:wallet.account.toLowerCase(),clientRequestId:crypto.randomUUID(),phase:'preparing',requested:false,updatedAt:Date.now()});
    const request={...intent,account:wallet.account};
    await walletGuard(wallet.provider,wallet.account,()=>Boolean(context.current && !context.current.invalid && latest.current.wallet.provider===wallet.provider && latest.current.wallet.selectionRevision===wallet.selectionRevision && latest.current.key===key));exact(j);
    const estimate=await approvalReadiness(wallet.account,request.amount,0n,true);exact(j);setCost(estimate);
    await walletGuard(wallet.provider,wallet.account,()=>Boolean(context.current && !context.current.invalid && latest.current.enabled && latest.current.wallet.provider===wallet.provider && latest.current.wallet.selectionRevision===wallet.selectionRevision && latest.current.key===key));exact(j);
    const p=validatePrepared(await executionApi.prepare(request,j.clientRequestId,deadlineMinutes,{previewId,minimumReceiveAmount:previewFloor.toString(),minimumPolicy:'sdk-executable-v1'}),request,Date.now(),deadlineMinutes,true);
    if(p.authorization!=='onchain-approval' || p.clientRequestId!==j.clientRequestId || p.minimumPolicy!=='sdk-executable-v1' || p.previewId!==previewId || p.previewMinimumReceiveAmount!==previewFloor.toString())throw new Error('Review mismatch');
    await guard(p,j);write({...j,id:p.id,prepared:p,phase:'prepared',updatedAt:Date.now()});setMessage('Approve only the exact sell amount, then separately review and sign the Fusion order.');
  });
  const approve=()=>run(async()=>{
    let j=journal;const p=j?.prepared,c=context.current;if(!j || !p || !c || j.requested || j.phase!=='prepared')throw new Error('Approval already requested');
    await guard(p,j);setCost(await approvalReadiness(p.request.account,p.request.amount,0n,true));await guard(p,j);
    // Durable local latch precedes server arm and physical wallet request. Lost
    // server replies remain protected too; no same-attempt transaction retry.
    j=write({...j,requested:true,phase:'approval-pending',updatedAt:Date.now()});
    validateApprovalStatus(await approvalApi.request(p.id),j);await guard(p,j);
    setMessage('Confirm the exact USDT0 approval transaction in your wallet. Gas is paid in POL.');
    let txHash:Hex;
    try{txHash=await requestApprovalTransaction(c.provider,p.request.account,p.request.amount,()=>guard(p,j!));}
    catch(error){
      if(!(error instanceof ApprovalTransactionRejected))throw error;
      await guard(p,j);exact(j);
      const cancelled=validateApprovalStatus(await approvalApi.rejected(p.id),j);exact(j);
      const readback=validateApprovalStatus(await executionApi.status(p.id),j);exact(j);
      if(cancelled.state!=='cancelled' || readback.state!=='cancelled')throw new Error('Cancellation not confirmed',{cause:error});
      j=write({...j,phase:'cancelled',updatedAt:Date.now()});clearApprovalJournal(localStorage,j,true);setJournal(null);setReviewed(null);context.current=null;setMessage('Approval transaction declined. No hash was returned. Matched rejection cancellation confirmed; you can start a fresh review.');return;
    }
    exact(j);j=write({...j,transactionHash:txHash,updatedAt:Date.now()});
    // Do not depend on a wallet snapshot to retain a returned transaction hash.
    await guard(p,j);setMessage('Approval transaction saved. Wait for Polygon finality, then Check approval. No order has been signed or published.');
  });
  const checkApproval=()=>run(async()=>{
    let j=journal;if(!j)throw new Error('No saved approval');exact(j);
    if(!j.id){const s=await executionApi.recover(j.clientRequestId,j.account as Hex);exact(j);const candidate=s as {id?:unknown};if(typeof candidate.id!=='string')throw new Error('Missing operation');j=write({...j,id:candidate.id,updatedAt:Date.now()});}
    const txHash=j.transactionHash ?? (/^0x[0-9a-f]{64}$/i.test(hashInput)?hashInput.toLowerCase() as Hex:undefined);
    if(!txHash || !j.prepared)throw new Error('Approval hash or preparation missing');
    const prepared=j.prepared;
    if(!j.transactionHash)j=write({...j,transactionHash:txHash,updatedAt:Date.now()});
    // Server saves the hash even for pending/reverted transactions so later
    // zero-allowance expiry recovery can prove that exact broadcast is mined.
    const response=await approvalApi.confirm(j.id!,txHash);exact(j);
    await checkApprovalTransaction(prepared,txHash);exact(j);
    const s=validateApprovalStatus(response,j);
    if(s.state!=='approval-confirmed')throw new Error('Approval not confirmed');
    write({...j,prepared:{...prepared,approvalTransactionHash:txHash},phase:'approval-confirmed',updatedAt:Date.now()});setMessage('Exact approval independently finalized. Continue only if this review is still current. The approval itself has no expiry.');
  });
  const build=()=>run(async()=>{
    let j=journal;if(!j?.prepared || j.phase!=='approval-confirmed' || j.resetRequested)throw new Error('Approval missing');const p=j.prepared;
    await guard(p,j);await checkApprovalTransaction(p,j.transactionHash!);await guard(p,j);
    j=write({...j,phase:'building',updatedAt:Date.now()});
    const b=validateBuilt(await approvalApi.build(p.id),p,'0x',BigInt(p.previewMinimumReceiveAmount!));await guard(p,j);
    write({...j,phase:'built',orderHash:b.built.orderHash,order:recoveryOrderEvidence(b.built),updatedAt:Date.now()});setReviewed(b);setMessage('Review the final executable minimum. Swap signs and publishes only this Fusion order, with no token permit.');
  });
  const publish=()=>run(async()=>{
    let j=journal;if(!j?.prepared || !reviewed || !context.current || j.phase!=='built' || j.resetRequested)throw new Error('Order review missing');const p=j.prepared,c=context.current;
    const b=validateBuilt(reviewed.built,p,'0x',BigInt(p.previewMinimumReceiveAmount!));
    await checkApprovalTransaction(p,j.transactionHash!);await guard(p,j);
    j=write({...j,phase:'order-requested',updatedAt:Date.now()});
    const signature=await signExecution(c.provider,p.request.account,b.typedData,()=>guard(p,j!));await guard(p,j);
    j=write({...j,phase:'submitting',updatedAt:Date.now()});
    const s=validateApprovalStatus(await executionApi.submit(p.id,signature),j);exact(j);
    write({...j,phase:s.state==='pending'?'pending':'unknown',updatedAt:Date.now()});setReviewed(null);setMessage('Publication attempted once. Check swap status for independently verified settlement; acceptance is not a fill guarantee.');
  });
  const checkPublic=async(automatic=false)=>{
    const j=readApprovalJournal(localStorage),w=latest.current.wallet,revision=generation.current;
    if(!j || !w.provider || w.chainId!==137 || w.account?.toLowerCase()!==j.account)return 'unknown';
    const isCurrent=()=>mounted.current && (!automatic || document.visibilityState==='visible') && generation.current===revision && latest.current.wallet.provider===w.provider && latest.current.wallet.selectionRevision===w.selectionRevision && latest.current.wallet.account?.toLowerCase()===j.account && latest.current.wallet.chainId===137 && sameApprovalJournal(readApprovalJournal(localStorage),j);
    await walletGuard(w.provider,j.account as Hex,isCurrent);
    const result=await recoverApprovalSwap(j,isCurrent);
    if(!isCurrent())throw new Error('Stale approval status');
    if(result.state==='filled' && result.receipt){
      write({...j,phase:'filled',updatedAt:Date.now()});setReviewed(null);setReceipt(result.receipt);settlementCallback.current?.(result.receipt);
      setMessage('Swap completed. Exact settlement verified on finalized Polygon.');
    }else setMessage(result.state==='pending'?'Swap pending. Checking automatically with bounded read-only evidence. No signature or order is retried.':'Actual received amount is not yet verified. Keep recovery saved and use Check swap status. Missing legacy order evidence cannot be inferred from a quote or balance.');
    return result.state;
  };
  const monitored=Boolean(journal?.order && ['submitting','pending','unknown'].includes(journal.phase));
  useEffect(()=>{
    if(!monitored || !journal || !wallet.provider || wallet.chainId!==137 || wallet.account?.toLowerCase()!==journal.account)return;
    let alive=true,visibilityRevision=0;
    const monitor=createStatusMonitor(`approval:${monitorKey(journal.account,journal.clientRequestId)}`,{
      now:Date.now,visible:()=>document.visibilityState==='visible',available:()=>!active.current,
      exhausted:()=>{if(alive)setMessage('Automatic read-only checks paused at the safety limit. Keep recovery saved; use Check swap status. No order will be retried.');},
      schedule:(work,delay)=>{const timer=setTimeout(work,delay);return()=>clearTimeout(timer);},
      check:async()=>{const revision=visibilityRevision;let outcome:'pending'|'stop'|'paused'='stop';await run(async()=>{if(await checkPublic(true)==='pending')outcome='pending';});return !alive || revision!==visibilityRevision?'paused':outcome;},
    });
    const visibility=()=>{visibilityRevision++;generation.current++;monitor.visibilityChanged();};
    document.addEventListener('visibilitychange',visibility);
    return()=>{alive=false;monitor.cancel();generation.current++;document.removeEventListener('visibilitychange',visibility);};
  },[monitored,journal?.account,journal?.clientRequestId,wallet.provider,wallet.account,wallet.chainId,wallet.selectionRevision]);
  // Persisted/server-recovered filled is not a receipt. One bounded fresh read,
  // including after remount; the once-per-selection latch prevents failure loops.
  useEffect(()=>{
    if(journal?.phase!=='filled' || receipt || busy || !wallet.provider || wallet.chainId!==137 || wallet.account?.toLowerCase()!==journal.account)return;
    const key=`${monitorKey(journal.account,journal.clientRequestId)}:${wallet.selectionRevision}`;
    if(terminalReceiptAttempt.current===key)return;
    terminalReceiptAttempt.current=key;void run(()=>checkPublic(true).then(()=>{}));
  },[journal?.phase,journal?.clientRequestId,wallet.provider,wallet.account,wallet.chainId,wallet.selectionRevision,busy,receipt]);
  const recover=()=>run(async()=>{
    let j=journal;if(!j)throw new Error('Recovery missing');exact(j);
    if(!j.id){const raw=await executionApi.recover(j.clientRequestId,j.account as Hex);exact(j);const s=raw as {id?:unknown};if(typeof s.id!=='string')throw new Error('No saved operation');j=write({...j,id:s.id,updatedAt:Date.now()});}
    if(j.order && await checkPublic()==='filled')return;
    exact(j);
    const s=validateApprovalStatus(await executionApi.reconcile(j.id!),j);exact(j);
    if(s.state==='filled' && s.settlementVerified){write({...j,phase:'filled',updatedAt:Date.now()});setMessage('Server reports verified settlement. Actual received amount still needs fresh public receipt evidence.');}
    else if(s.state==='expired'){write({...j,phase:'expired',updatedAt:Date.now()});setMessage('Finalized unused order expiry and zero allowance verified. This saved activity can be closed.');}
    else setMessage('Not terminal. The approval does not expire when the order expires. Keep recovery, or explicitly reset allowance to zero and check finalized unused expiry. No automatic transaction or order retries.');
  });
  const reset=()=>run(async()=>{
    let j=journal;const p=j?.prepared;if(!j || !p || !j.requested || j.resetRequested || !wallet.provider || !wallet.account || wallet.account.toLowerCase()!==j.account)throw new Error('Reset unavailable');
    const provider=wallet.provider,selection=wallet.selectionRevision;
    const resetGuard=async()=>{exact(j!);await walletGuard(provider,p.request.account,()=>mounted.current && latest.current.wallet.provider===provider && latest.current.wallet.selectionRevision===selection);exact(j!);};
    await resetGuard();await approvalReadiness(p.request.account,'0',BigInt(p.request.amount),true);await resetGuard();
    j=write({...j,resetRequested:true,updatedAt:Date.now()});setReviewed(null);
    const resetHash=await requestApprovalTransaction(provider,p.request.account,'0',resetGuard);exact(j);write({...j,resetHash,updatedAt:Date.now()});setMessage('Revocation transaction saved, not yet verified. Check swap status after finality and order expiry. Revoking does not cancel an already published order or prove it did not fill.');
  });
  const close=()=>run(async()=>{if(!journal)throw new Error('No journal');clearApprovalJournal(localStorage,journal,['filled','expired','cancelled'].includes(journal.phase));setJournal(null);setReviewed(null);context.current=null;setMessage('Local activity closed. No server record or transaction was deleted.');});
  const visibleReceipt=receipt && journal?.phase==='filled' && receipt.account===journal.account && receipt.clientRequestId===journal.clientRequestId && receipt.orderHash===journal.orderHash && wallet.account?.toLowerCase()===receipt.account && wallet.chainId===137?receipt:null;
  const outputToken=visibleReceipt && Object.values(TOKENS).find(t=>t.address.toLowerCase()===visibleReceipt.tokenOut);
  const p=journal?.prepared;
  const currentReview=Boolean(context.current && !context.current.invalid && context.current.key===key);
  let permitBlocked=true;try{permitBlocked=Boolean(readExecutionJournal(localStorage));}catch{/* unreadable remains blocking */}
  return <div className="fusion-execution approval-execution">
    {!journal && <button className="primary" disabled={busy || blocked || permitBlocked || !enabled || !intent || intent.tokenIn.toLowerCase()!==APPROVAL_TOKEN || !wallet.account || wallet.chainId!==137 || !previewFloor || !previewId || !previewValidUntil || previewValidUntil<=Date.now() || Boolean(reviewBlockedReason)} onClick={()=>void review()}>Review</button>}
    {p && journal?.phase==='prepared' && !journal.requested && currentReview && <section aria-label="Exact USDT0 approval review" className="swap-consent"><h3>Approve USDT0 · requires POL</h3><p className="approval-exact-amount">Approve exactly {formatUnits(BigInt(p.request.amount),6)} USDT0 — not unlimited. Only the 1inch router on Polygon can use this allowance.</p><p>Estimated approval fee budget: {cost===null?'unavailable':`${formatUnits(cost,18)} POL`} (includes a 20% gas-unit cushion; wallet fees may differ).</p><p>The amount is limited; the permission has no automatic expiry. If the swap does not complete, unused approval may remain after the order expires. Revoking it needs a separate transaction paid in POL. Fusion settlement remains resolver-paid.</p><p>Preview minimum is indicative. Review the final executable minimum separately before signing the order.</p><p>Order deadline: {new Date(p.orderDeadline!*1000).toISOString()}</p><details><summary>Exact approval details</summary><p>Amount: {p.request.amount} base units</p><p>Owner: <code>{p.request.account}</code></p><p>Token: <code>{APPROVAL_TOKEN}</code></p><p>Spender: <code>{APPROVAL_SPENDER}</code></p><p>Native value: 0 POL · chain 137</p></details><button className="primary" disabled={busy || !enabled} onClick={()=>void approve()}>Approve exact USDT0</button></section>}
    {journal?.requested && <section className="recovery-block" aria-label="USDT0 approval recovery"><p>Saved approval activity for <code>{journal.account}</code>.</p><h3>Spending permission</h3><p>This flow requests an exact-amount approval, not unlimited spending.</p>{p && <p className="approval-exact-amount">Requested limit: {formatUnits(BigInt(p.request.amount),6)} USDT0</p>}{!['filled','expired','cancelled'].includes(journal.phase) && <p className="approval-residual-notice">Unused approval may remain if the swap does not complete. Order expiry does not revoke it. Check status before deciding whether to revoke.</p>}<p>Never repeat an uncertain broadcast. A pending or rejected wallet response is not proof that no transaction exists.</p>{journal.transactionHash && <p>Approval transaction: <code>{journal.transactionHash}</code></p>}{!journal.transactionHash && <label>Approval transaction hash from wallet<input aria-label="Approval transaction hash" value={hashInput} onChange={e=>setHashInput(e.target.value)} /></label>}
    {['approval-pending','approval-confirmed'].includes(journal.phase) && <button disabled={busy || Boolean(journal.resetRequested)} onClick={()=>void checkApproval()}>Check approval</button>}
    {journal.phase==='approval-confirmed' && currentReview && !journal.resetRequested && <button disabled={busy || !enabled} onClick={()=>void build()}>Build order review</button>}
    <button disabled={busy} onClick={()=>void recover()}>Check swap status</button>
    {!['filled','expired','cancelled'].includes(journal.phase) && <div className="approval-revoke-panel"><p>Revoke sets the router allowance to zero and costs POL. It does not cancel a published order or prove the swap did not fill. Check pending transactions first. If the allowance has changed, use your wallet to revoke it.</p><button className="approval-revoke-action" disabled={busy || !enabled || !p || !wallet.provider || wallet.chainId!==137 || wallet.account?.toLowerCase()!==journal.account || Boolean(journal.resetRequested)} onClick={()=>void reset()}>Revoke USDT0 approval · requires POL</button>{(!wallet.provider || wallet.chainId!==137 || wallet.account?.toLowerCase()!==journal.account) && <p>To revoke here, connect the saved account on Polygon.</p>}</div>}
    {journal.resetHash && <p>Revocation transaction: <code>{journal.resetHash}</code></p>}
    {journal.resetRequested && <p>Revocation requested — not yet verified. Do not resend it. Check its result in your wallet, then Check swap status after finality and order expiry. Keep this recovery saved.</p>}
    </section>}
    {reviewed && p && currentReview && <section className="swap-consent" aria-label="Fusion order review"><h3>Review Fusion order</h3><p>Sell ≈ {amount(p.request.amount,p.request.tokenIn)}</p><p>Final minimum received: ≈ {amount(reviewed.minimum.toString(),p.request.tokenOut)}</p><p>Order deadline: {new Date(reviewed.built.deadline*1000).toISOString()}</p><p>Swap signs and publishes this order once. No permit signature. No guaranteed fill. Your independent approval remains until spent or reset, even after order expiry.</p><details><summary>Exact order details</summary><p>Input: {p.request.amount} base units · {p.request.tokenIn}</p><p>Minimum output: {reviewed.minimum.toString()} base units · {p.request.tokenOut}</p><p>Maker and receiver: {p.request.account}</p><p>Router: {APPROVAL_SPENDER}</p><p>Order hash: {reviewed.built.orderHash}</p></details><button className="primary" disabled={busy || !enabled} onClick={()=>void publish()}>Swap</button></section>}
    {journal && (!journal.requested || ['filled','expired','cancelled'].includes(journal.phase)) && <button disabled={busy} onClick={()=>void close()}>{journal.requested?'Close completed activity':'Discard unsigned local attempt'}</button>}
    {journal?.phase==='filled' && <section className="swap-receipt" aria-label="Verified swap receipt">{visibleReceipt && outputToken?<><p><strong>Received {formatUnits(BigInt(visibleReceipt.receivedAmount),outputToken.decimals)} {outputToken.symbol==='USDT'?'USDT0':outputToken.symbol}</strong></p><p>Actual net amount from finalized Polygon transfers.</p><a href={`https://polygonscan.com/tx/${visibleReceipt.transactionHash}`} target="_blank" rel="noopener noreferrer">View transaction on PolygonScan ↗</a><details><summary>Exact receipt details</summary><p>{visibleReceipt.receivedAmount} base units · <code>{visibleReceipt.tokenOut}</code></p><p>Account: <code>{visibleReceipt.account}</code></p><p>Request: <code>{visibleReceipt.clientRequestId}</code></p><p>Order: <code>{visibleReceipt.orderHash}</code></p><p>Transaction: <code>{visibleReceipt.transactionHash}</code></p></details></>:<p>Actual received amount and transaction are not yet independently verified. Keep the saved activity and use Check swap status; legacy missing order proof cannot be inferred.</p>}</section>}
    {busy && <div role="status" aria-label="Checking approval activity"><NimiqSpinner /> Checking approval activity…</div>}
    {message && <p role="status">{message}</p>}
  </div>;
}
