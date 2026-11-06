import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { NimiqSpinner } from './NimiqSpinner';
import { ApprovalExecution } from './ApprovalExecution';
import { APPROVAL_TOKEN } from '../shared/usdt0-approval';
import { APPROVAL_JOURNAL_KEY } from './usdt0-approval';
import { formatUnits, type Hex } from 'viem';
import { TOKENS } from '../swap/registry';
import { displayAmount } from './swap-display';
import type { FusionRequest } from './fusion';
import type { WalletController } from './wallet';
import { ApiError } from './api';
import { preparationErrorMessage } from './preparation-error';
import { DEFAULT_SWAP_DEADLINE_MINUTES } from '../shared/swap-deadline';
import { claimAutomaticPublicRecovery, recoverPublicSwap, type VerifiedSwapReceipt } from './public-swap-recovery';
import { createStatusMonitor, monitorKey } from './swap-status-monitor';
import { recoveryOrderEvidence } from './fusion-execution';
import { canExitProtectedReview, exitProtectedReview, WalletSignatureRejected, releaseRejectedPermit, validateUnsignedCancellation, recoveredJournalState, canDiscardUnsigned, sameExecutionJournal, discardUnsignedJournal, recoveryPermitRequested, checkExecutionPermit, encodeExecutionPermit, executionApi, executionPermit, FUSION_SPENDER, readExecutionJournal, saveExecutionJournal, signExecution, validateBuilt, validateExecutionStatus, validateOwnershipRecoveryStatus, validatePrepared, validateRecoveryChallenge, recoveredExecutionsSchema, walletGuard, withExecutionLock, EXECUTION_JOURNAL_KEY, type ExecutionJournal, type PreparedExecution } from './fusion-execution';

type Intent = Omit<FusionRequest, 'account'>;
export type FusionExecutionProps=Parameters<typeof PermitExecution>[0];
export function FusionExecution(props:FusionExecutionProps) {
  const [,refresh]=useState(0);
  useEffect(()=>{const changed=()=>refresh(v=>v+1);window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed);},[]);
  let approval:boolean,permit=false;
  try{approval=localStorage.getItem(APPROVAL_JOURNAL_KEY)!==null;permit=localStorage.getItem(EXECUTION_JOURNAL_KEY)!==null;}catch{approval=true;}
  // Existing permit recovery retains precedence; do not reinterpret its nonce,
  // deadline or authority as an approval operation when changing token selection.
  return !permit && (approval || props.intent?.tokenIn.toLowerCase()===APPROVAL_TOKEN) ? <ApprovalExecution {...props}/> : <PermitExecution {...props}/>;
}
type ReviewedOrder = ReturnType<typeof validateBuilt>;
const minimumUnavailableMessage = 'No order published. The executable output is below your saved minimum; the minimum was not lowered. Your signed permit remains independently usable until expiry. Keep this recovery record until finalized unused expiry is verified. No automatic signatures or retries.';
function units(raw: string, address: string, compact = false) { const token = Object.values(TOKENS).find(t => t.address.toLowerCase() === address.toLowerCase()); if (!token) return raw; const exact = formatUnits(BigInt(raw),token.decimals); const shown = compact ? displayAmount(exact) : exact; return `${shown !== exact && !shown.startsWith('<') ? '≈ ' : ''}${shown} ${token.symbol === 'USDT' ? 'USDT0' : token.symbol}`; }
function RetryDeadline({ seconds }: { seconds: number }) {
  const [now,setNow]=useState(Date.now());
  useEffect(()=>{setNow(Date.now());const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[seconds]);
  const remaining=Math.max(0,Math.ceil(seconds-now/1000));
  return <div className="retry-deadline"><p>Signed permit deadline: <Deadline seconds={seconds} /></p><p>{remaining>0 ? `Expires in ${Math.floor(remaining/60)}m ${String(remaining%60).padStart(2,'0')}s. Wait before checking unused expiry for a fresh swap.` : 'The deadline has passed. Check unused expiry now; elapsed time alone does not release the permit protection.'}</p><p>Retry path: Check swap status → once finalized unused expiry is verified, Close completed activity → Review a fresh swap. Checks never retry a signature or publish an order.</p></div>;
}
function Deadline({ seconds }: { seconds: number }) { const iso = new Date(seconds * 1000).toISOString(); return <time dateTime={iso}>{iso.slice(0,10)}<span className="consent-time">{iso.slice(11,19)} UTC</span></time>; }
function PermitExecution({ wallet, enabled, intent, previewFloor, previewId, previewValidUntil, onActivityChange, onSettlement, reviewBlockedReason = '', deadlineMinutes = DEFAULT_SWAP_DEADLINE_MINUTES, settingsRevision = 0 }: { wallet: WalletController; enabled: boolean; intent: Intent | null; previewFloor: bigint | null; previewId?: string | undefined; previewValidUntil?: number | undefined; onActivityChange?: (active: boolean) => void; onSettlement?: (receipt: VerifiedSwapReceipt) => void; reviewBlockedReason?: string; deadlineMinutes?: number; settingsRevision?: number }) {
  const [receipt, setReceipt] = useState<VerifiedSwapReceipt | null>(null);
  const terminalReceiptAttempt = useRef('');
  const settlementCallback = useRef(onSettlement); settlementCallback.current = onSettlement;
  const [journal, setJournal] = useState<ExecutionJournal | null>(null);
  const [prepared, setPrepared] = useState<PreparedExecution | null>(null);
  const [order, setOrder] = useState<ReviewedOrder | null>(null);
  const [busy, setBusy] = useState(false);
  const [preparation, setPreparation] = useState<{started:number;phase:string;order?:boolean}|null>(null);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => { if(!preparation)return; const tick=()=>setElapsed(Math.max(0,Math.floor((Date.now()-preparation.started)/1000)));tick();const timer=setInterval(tick,250);return()=>clearInterval(timer); },[preparation?.started]);
  const [checkingPublic, setCheckingPublic] = useState(false);
  const [message, setMessage] = useState('');
  const [signatureNotice,setSignatureNotice]=useState('');
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [recoveryRequired, setRecoveryRequired] = useState(false);
  const [proof, setProof] = useState<ReturnType<typeof validateRecoveryChallenge> | null>(null);
  const [recoveryOptionsOpen, setRecoveryOptionsOpen] = useState(false);
  const proofContext = useRef<{provider: NonNullable<WalletController['provider']>; selection: number; generation: number; optionsGeneration: number} | null>(null);
  const proofGeneration = useRef(0);
  const current = useRef({ wallet, intent, enabled, deadlineMinutes, settingsRevision }); current.current = { wallet, intent, enabled, deadlineMinutes, settingsRevision };
  const intentKey = JSON.stringify({intent,deadlineMinutes,settingsRevision});
  const recoveryJournalKey = JSON.stringify(journal);
  const context = useRef<{ provider: NonNullable<WalletController['provider']>; account: string; selection: number; intent: string; invalid: boolean; floor: bigint } | null>(null);
  const permitBytes = useRef<Hex | null>(null);
  const mounted = useRef(true);
  const activeWork = useRef(false);
  const recoveryGeneration = useRef(0);

  useEffect(() => {
    mounted.current = true;
    const load = () => { try { setJournal(readExecutionJournal(localStorage)); } catch { setStorageBlocked(true); setMessage('Stored swap recovery data is unavailable or invalid. New swaps are blocked; do not clear storage until the previous order is reconciled.'); } };
    load(); window.addEventListener('storage', load);
    return () => { mounted.current = false; permitBytes.current = null; context.current = null; window.removeEventListener('storage', load); };
  }, []);
  // Track actual wallet changes, not visibility/revision refreshes. Native wallet
  // backgrounding temporarily clears the React snapshot but is not a new account.
  // Challenges are explicit and scoped to one wallet context, not reconnect UI.
  useEffect(() => {
    setProof(null); proofContext.current=null; setRecoveryOptionsOpen(false);
  }, [wallet.provider, wallet.selectionRevision, wallet.account, wallet.chainId, recoveryJournalKey]);
  useEffect(() => {
    const p = wallet.provider;
    if (!p) return;
    const invalidateRecovery = () => { recoveryGeneration.current++; setProof(null); proofContext.current=null; setRecoveryOptionsOpen(false); };
    const accounts = (value: unknown) => { invalidateRecovery(); const c = context.current; if (c && (!Array.isArray(value) || !value.some(a => typeof a === 'string' && a.toLowerCase() === c.account))) c.invalid = true; };
    const chain = (value: unknown) => { invalidateRecovery(); if (context.current && (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value) || Number.parseInt(value,16) !== 137)) context.current.invalid = true; };
    const disconnect = () => { invalidateRecovery(); if (context.current) context.current.invalid = true; };
    p.on?.('accountsChanged', accounts); p.on?.('chainChanged', chain); p.on?.('disconnect', disconnect);
    return () => { p.removeListener?.('accountsChanged', accounts); p.removeListener?.('chainChanged', chain); p.removeListener?.('disconnect', disconnect); };
  }, [wallet.provider]);
  useEffect(() => {
    const c = context.current;
    if (c && (!enabled || wallet.provider !== c.provider || wallet.selectionRevision !== c.selection || intentKey !== c.intent)) {
      c.invalid = true; setPrepared(null); setOrder(null); permitBytes.current = null;
      setMessage('Swap inputs changed. The previous review is invalid. Recover the saved operation before starting again.');
    }
  }, [wallet.provider, wallet.selectionRevision, intentKey, enabled]);
  useEffect(() => { onActivityChange?.(busy || Boolean(journal || prepared || order)); }, [busy, journal, prepared, order, onActivityChange]);
  const write = (j: ExecutionJournal) => { saveExecutionJournal(localStorage,j); if (mounted.current) setJournal(j); };
  const guard = async (p: PreparedExecution) => {
    const c = context.current;
    if (!c) throw new Error('Review expired. Recover the saved operation.');
    await walletGuard(c.provider, p.request.account, () => !c.invalid && mounted.current && current.current.enabled && current.current.wallet.provider === c.provider && current.current.wallet.selectionRevision === c.selection && JSON.stringify({intent:current.current.intent,deadlineMinutes:current.current.deadlineMinutes,settingsRevision:current.current.settingsRevision}) === c.intent);
    validatePrepared(p,p.request,Date.now(),current.current.deadlineMinutes);
  };
  const run = async (work: () => Promise<unknown>, publicCheck = false) => {
    if (activeWork.current) return;
    activeWork.current = true;
    setBusy(true); setCheckingPublic(publicCheck); setMessage('');
    try { await withExecutionLock(work); }
    catch (e) {
      if (e instanceof ApiError && (e.status === 401 || e.status === 404 || e.code==='FUSION_RECONCILIATION_REQUIRED')) setRecoveryRequired(true);
      setProof(null);
      let unsignedFailure = false;
      try { unsignedFailure = canDiscardUnsigned(readExecutionJournal(localStorage)); } catch { /* Unreadable evidence stays protected. */ }
      if (mounted.current) setMessage(publicCheck ? 'Saved swap check unavailable. Permit recovery remains saved; no signature or order was retried. Check the wallet connection and use Check swap status when ready.' : (e instanceof ApiError && e.code==='FUSION_MINIMUM_UNAVAILABLE' ? minimumUnavailableMessage : e instanceof ApiError ? preparationErrorMessage(e.code) : null) ?? (e instanceof ApiError && e.code==='FUSION_DEADLINE_UNAVAILABLE' ? 'The provider auction cannot fit your deadline. No order was built and the deadline was not extended. A permit already exposed remains valid until expiry; recover status before starting again.' : e instanceof WalletSignatureRejected ? 'Signature declined. No automatic retry. Recover the saved operation before starting another swap.' : unsignedFailure ? 'Preparation stopped before any signature request. Discard this local attempt to start again; no session recovery proof is needed.' : 'Swap interrupted or could not be validated. Recover status; do not submit another order. Any permit already signed remains valid independently until its expiry.'));
      permitBytes.current = null; setOrder(null); setPrepared(null);
    } finally { setPreparation(null); activeWork.current = false; if (mounted.current) { setBusy(false); setCheckingPublic(false); } }
  };
  const review = () => {
    if(activeWork.current)return;
    flushSync(() => {setSignatureNotice('');setElapsed(0);setPreparation({started:Date.now(),phase:'Checking wallet and saved activity'});});
    return run(async () => {
    if (!previewId || (previewValidUntil !== undefined && previewValidUntil <= Date.now()) || !enabled || !intent || previewFloor === null || previewFloor <= 0n || !wallet.account || !wallet.provider || wallet.chainId !== 137 || readExecutionJournal(localStorage) || localStorage.getItem(APPROVAL_JOURNAL_KEY)!==null) throw new Error('Not ready');
    const request = { ...intent, account: wallet.account };
    context.current = { provider: wallet.provider, account: wallet.account.toLowerCase(), selection: wallet.selectionRevision, intent: intentKey, invalid: false, floor: previewFloor };
    const j: ExecutionJournal = { version: 1, account: wallet.account.toLowerCase() as `0x${string}`, clientRequestId: crypto.randomUUID(), state: 'preparing', permitRequested: false, updatedAt: Date.now() };
    write(j); // Write-ahead before any network mutation; lost replies recover by ID.
    await walletGuard(wallet.provider, wallet.account, () => Boolean(context.current && !context.current.invalid && current.current.wallet.provider === wallet.provider && current.current.wallet.selectionRevision === wallet.selectionRevision));
    setPreparation(value=>value && {...value,phase:'Preparing exact token permission · validating Polygon state'});
    const p = validatePrepared(await executionApi.prepare(request,j.clientRequestId,deadlineMinutes,{previewId,minimumReceiveAmount:previewFloor.toString(),minimumPolicy:'sdk-executable-v1'}),request,Date.now(),deadlineMinutes);
    if (p.minimumPolicy !== 'sdk-executable-v1' || p.previewId !== previewId || p.previewMinimumReceiveAmount !== previewFloor.toString()) throw new Error('Prepared minimum policy differs from review');
    if (p.clientRequestId && p.clientRequestId !== j.clientRequestId) throw new Error('Preparation request ID mismatch');
    setPreparation(value=>value && {...value,phase:'Checking the prepared permission'});
    await guard(p);
    write({ ...j,id:p.id,state:'prepared',publicRecovery:{request:p.request,permit:p.permit},updatedAt:Date.now() }); setPrepared(p);
    });
  };
  const permit = () => run(async () => {
    if (!prepared || !journal || !context.current) throw new Error('Review missing');
    const p = prepared; const c = context.current;
    if (readExecutionJournal(localStorage)?.clientRequestId !== journal.clientRequestId) throw new Error('Journal changed');
    await checkExecutionPermit(p, () => guard(p));
    if (!sameExecutionJournal(readExecutionJournal(localStorage),journal) || !canDiscardUnsigned(journal)) throw new Error('Unsigned journal changed');
    const requested:ExecutionJournal={...journal,state:'permit-requested',permitRequested:true,updatedAt:Date.now()};
    write(requested);
    if(!sameExecutionJournal(readExecutionJournal(localStorage),requested))throw new Error('Permit request journal was not persisted');
    setMessage('Waiting for the exact token permit signature in your wallet…');
    let signature:Hex;
    try { signature = await signExecution(c.provider,p.request.account,executionPermit(p),async() => { await guard(p);if(!sameExecutionJournal(readExecutionJournal(localStorage),requested))throw new Error('Permit request journal changed'); }); }
    catch(error) {
      if(!(error instanceof WalletSignatureRejected))throw error;
      // This invocation started from a proven never-requested draft and the
      // physical RPC returned rejection, not a value. Keep the Web Lock through
      // exact server cancellation + authenticated readback + local removal.
      if(!mounted.current || c.invalid || !sameExecutionJournal(readExecutionJournal(localStorage),requested))throw new Error('Rejected permit context changed',{cause:error});
      setSignatureNotice('Spending permission declined. Safe cancellation is not yet confirmed; recovery remains saved until the checks complete.');
      validateUnsignedCancellation(await executionApi.cancelUnsigned(p.id,requested.clientRequestId),requested);
      const receipt=validateUnsignedCancellation(await executionApi.cancellation(p.id),requested);
      if(!mounted.current || c.invalid)throw new Error('Rejected permit context changed',{cause:error});
      releaseRejectedPermit(localStorage,requested,receipt);
      setJournal(null);setPrepared(null);setOrder(null);permitBytes.current=null;context.current=null;setRecoveryRequired(false);setSignatureNotice('');
      setMessage('Spending permission declined. No signature was returned and no order was submitted. You can start a new review.');
      return;
    }
    setPreparation({started:Date.now(),phase:'Checking the signed permit and preparing the separate order review',order:true});
    // Recheck nonce/domain/balance after returning from the native wallet.
    await checkExecutionPermit(p, () => guard(p));
    const encoded = encodeExecutionPermit(p,signature);
    // Conservative local write-ahead: even a lost build reply must not offer
    // another spending signature or retry the permit-bearing provider quote.
    write({ ...journal,state:'permit-exposed',permitRequested:true,updatedAt:Date.now() });
    setMessage('Signed permit may be exposed to the quote provider. If interrupted, recover status; do not retry signing or building.');
    const exposed:ExecutionJournal={...journal,state:'permit-exposed',permitRequested:true,updatedAt:Date.now()};
    // Use the exact write-ahead record for stale-tab comparison, not a new timestamp.
    const expected=readExecutionJournal(localStorage);
    let response:unknown;
    try { response=await executionApi.build(p.id,signature); }
    catch(e) {
      if(e instanceof ApiError && e.code==='FUSION_MINIMUM_UNAVAILABLE' && expected && sameExecutionJournal(readExecutionJournal(localStorage),expected) && expected.id===p.id && expected.state==='permit-exposed' && mounted.current && !c.invalid) {
        write({...exposed,buildOutcome:'minimum-unavailable-not-published',updatedAt:Date.now()});
      }
      throw e;
    }
    setPreparation(value=>value && {...value,phase:'Checking the exact executable order and minimum'});
    const reviewed = validateBuilt(response,p,encoded,c.floor);
    await guard(p); permitBytes.current = encoded;
    write({ ...journal,state:'built',permitRequested:true,orderHash:reviewed.built.orderHash,publicRecovery:{request:p.request,permit:p.permit,order:recoveryOrderEvidence(reviewed.built)},updatedAt:Date.now() });
    setOrder(reviewed); setMessage('Order built and checked locally. Review the exact minimum before the separate order signature.');
  });
  const publish = () => run(async () => {
    if (!prepared || !order || !journal || !context.current || !permitBytes.current) throw new Error('Order review missing');
    const p = prepared; const c = context.current;
    if (readExecutionJournal(localStorage)?.clientRequestId !== journal.clientRequestId) throw new Error('Journal changed');
    if(!sameExecutionJournal(readExecutionJournal(localStorage),journal))throw new Error('Order review journal changed');
    const checked = validateBuilt(order.built,p,permitBytes.current,c.floor);
    await checkExecutionPermit(p,() => guard(p));
    if(!sameExecutionJournal(readExecutionJournal(localStorage),journal))throw new Error('Order review journal changed');
    const requestedOrder:ExecutionJournal={...journal,state:'order-requested',permitRequested:true,updatedAt:Date.now()};
    write(requestedOrder);
    setMessage('Waiting for the exact Fusion order signature in your wallet…');
    let signature:Hex;
    try { signature = await signExecution(c.provider,p.request.account,checked.typedData,async() => { await guard(p);if(!sameExecutionJournal(readExecutionJournal(localStorage),requestedOrder))throw new Error('Order request journal changed'); }); }
    catch(error) {
      if(!(error instanceof WalletSignatureRejected))throw error;
      // The independent token permit already exists. Never cancel the server
      // record, clear its latch, rebuild or request a replacement signature.
      if(!mounted.current || c.invalid || !sameExecutionJournal(readExecutionJournal(localStorage),requestedOrder))throw new Error('Rejected order context changed',{cause:error});
      // Under the same execution lock, close only this exact local review.
      // The already-signed permit and saved order identity remain protected.
      setJournal(exitProtectedReview(localStorage,requestedOrder));
      setSignatureNotice('Order signature declined. No order was submitted by this attempt. Review closed; your signed token permit is not revoked. Follow the saved expiry check below before a fresh swap.');
      setMessage('');
      permitBytes.current=null;setPrepared(null);setOrder(null);context.current=null;
      return;
    }
    await checkExecutionPermit(p,() => guard(p));
    validateBuilt(checked.built,p,permitBytes.current,c.floor);
    const submitting = { ...journal,state:'submitting' as const,updatedAt:Date.now() };
    write(submitting); // From here onward, any failure is unknown, never retry.
    const status = validateExecutionStatus(await executionApi.submit(p.id,signature),submitting);
    write({ ...submitting,state:recoveredJournalState(submitting,status.state,status.settlementVerified),updatedAt:Date.now() });
    setMessage(status.settlementVerified ? 'Settlement verified by the server.' : 'Order publication is not settlement. Check status; no automatic resubmission.');
    permitBytes.current = null; setPrepared(null); setOrder(null); context.current = null;
  });
  const checkPublic = async (automatic = false) => {
    const j=readExecutionJournal(localStorage), w=current.current.wallet, generation=recoveryGeneration.current;
    if(!j || !w.provider || w.account?.toLowerCase()!==j.account || w.chainId!==137 || canDiscardUnsigned(j))return;
    const isCurrent=()=>mounted.current && (!automatic || document.visibilityState==='visible') && recoveryGeneration.current===generation && current.current.wallet.provider===w.provider && current.current.wallet.selectionRevision===w.selectionRevision && current.current.wallet.account?.toLowerCase()===j.account && current.current.wallet.chainId===137 && sameExecutionJournal(readExecutionJournal(localStorage),j);
    await walletGuard(w.provider,j.account,isCurrent);
    let evidence=j;
    // Legacy journals may recover non-secret proof inputs from their existing
    // authenticated GET. A missing session is not a swap failure.
    if(!j.orderHash && j.id && !j.buildOutcome) {
      try {
        const s=validateExecutionStatus(await executionApi.status(j.id),j);
        if(!isCurrent())return;
        if(s.request && s.permit && !s.orderHash)evidence={...j,publicRecovery:{request:s.request,permit:s.permit},...(s.buildOutcome ? {buildOutcome:s.buildOutcome,permitRequested:true} : {})};
      } catch(e) {
        if(!isCurrent())return;
        if(e instanceof ApiError && (e.status===401 || e.status===404))setRecoveryRequired(true);
      }
    }
    const result=await recoverPublicSwap(evidence,isCurrent);
    if(!isCurrent())return;
    if(result.state==='unknown' && !evidence.publicRecovery && !j.orderHash)setRecoveryRequired(true);
    if(result.state==='filled' || result.state==='expired') {
      write({...evidence,permitRequested:recoveryPermitRequested(j),state:result.state,updatedAt:Date.now()});
      if(result.state==='filled' && result.receipt) { setReceipt(result.receipt); settlementCallback.current?.(result.receipt); }
      setRecoveryRequired(false); setProof(null); proofContext.current=null; setRecoveryOptionsOpen(false);
    }
    else if(evidence!==j)write({...evidence,permitRequested:recoveryPermitRequested(j),updatedAt:Date.now()});
    setMessage(evidence.buildOutcome && !['filled','expired'].includes(result.state) ? minimumUnavailableMessage : result.state==='filled' ? 'Swap completed. Exact settlement verified on finalized Polygon.' : result.state==='expired' ? 'Swap not executed. Finalized Polygon proves the permit expired unused, with no remaining allowance.' : result.state==='pending' ? automatic ? 'Swap is pending. Checking automatically using read-only evidence; no new signature or submission is needed.' : 'Swap is pending. No new signature or submission is needed. Check again later.' : 'Swap outcome is not yet confirmed. Your saved protection stays in place. No order was retried.');
    return result.state;
  };
  // Submitted order monitoring is public-only; legacy standalone recovery retains
  // its one-shot policy. A pending hint is not settlement proof.
  const monitored = Boolean(journal?.orderHash && journal.publicRecovery?.order && ['submitting','pending','unknown'].includes(journal.state) && !journal.reviewExited && !prepared);
  useEffect(() => {
    if (!monitored || !journal || !wallet.provider || wallet.chainId!==137 || wallet.account?.toLowerCase()!==journal.account) return;
    let alive = true, visibilityRevision = 0;
    const monitor = createStatusMonitor(monitorKey(journal.account,journal.clientRequestId), {
      now: Date.now, visible: () => document.visibilityState==='visible', available: () => !activeWork.current,
      exhausted: () => { if (alive) setMessage('Automatic read-only checks paused at the safety limit. Your swap remains saved. Use Check swap status for a fresh check; no order will be retried.'); },
      schedule: (work,delay) => { const timer=setTimeout(work,delay); return () => clearTimeout(timer); },
      check: async () => {
        const revision=visibilityRevision;
        let outcome: 'pending'|'stop'|'paused' = 'stop';
        await run(async () => {
          const state=await checkPublic(true);
          if (state==='pending') outcome='pending';
        },true);
        return !alive || revision!==visibilityRevision ? 'paused' : outcome;
      },
    });
    const visibility = () => { visibilityRevision++; recoveryGeneration.current++; monitor.visibilityChanged(); };
    document.addEventListener('visibilitychange',visibility);
    return () => { alive=false; monitor.cancel(); document.removeEventListener('visibilitychange',visibility); };
  }, [monitored, journal?.account, journal?.clientRequestId, wallet.provider, wallet.account, wallet.chainId, wallet.selectionRevision]);
  // One bounded legacy read; never automatic private reconciliation/sign/build/submit.
  useEffect(() => {
    if(monitored || !journal || prepared || busy || canDiscardUnsigned(journal) || ['filled','expired'].includes(journal.state) || wallet.chainId!==137 || wallet.account?.toLowerCase()!==journal.account || !wallet.provider)return;
    if(!claimAutomaticPublicRecovery(journal))return;
    void run(checkPublic,true);
  }, [journal?.clientRequestId, wallet.provider, wallet.account, wallet.chainId, wallet.selectionRevision, prepared, busy]);
  // Server/recovered terminal state and reloaded journals still need fresh public
  // receipt evidence for actual amounts. Never derive receipts from wallet deltas.
  useEffect(() => {
    if(journal?.state!=='filled' || (receipt?.account===journal.account && receipt.clientRequestId===journal.clientRequestId && receipt.orderHash===journal.orderHash) || busy || !wallet.provider || wallet.chainId!==137 || wallet.account?.toLowerCase()!==journal.account)return;
    const key=`${journal.account}:${journal.clientRequestId}:${wallet.selectionRevision}`;
    if(terminalReceiptAttempt.current===key)return;
    terminalReceiptAttempt.current=key;
    void run(checkPublic,true);
  }, [journal?.state,journal?.clientRequestId,wallet.provider,wallet.account,wallet.chainId,wallet.selectionRevision,busy,receipt]);
  const recover = () => run(async () => {
    const j = readExecutionJournal(localStorage);
    if (canDiscardUnsigned(j)) throw new Error('Unsigned attempt needs no private recovery');
    if (!j || !wallet.account || wallet.account.toLowerCase() !== j.account || !wallet.provider) throw new Error('Reconnect saved account');
    await walletGuard(wallet.provider,wallet.account,() => current.current.wallet.provider === wallet.provider && current.current.wallet.selectionRevision === wallet.selectionRevision);
    const found = j.id ? null : validateExecutionStatus(await executionApi.recover(j.clientRequestId,j.account),j);
    const s = validateExecutionStatus(await executionApi.reconcile(j.id ?? found!.id),j);
    await walletGuard(wallet.provider,j.account,() => mounted.current && current.current.wallet.provider===wallet.provider && current.current.wallet.selectionRevision===wallet.selectionRevision && sameExecutionJournal(readExecutionJournal(localStorage),j));
    const state = recoveredJournalState(j,s.state,s.settlementVerified);
    write({ ...j,...(s.buildOutcome ? {buildOutcome:s.buildOutcome} : {}),permitRequested:s.buildOutcome ? true : recoveryPermitRequested(j),id:s.id,...(s.orderHash ? {orderHash:s.orderHash} : {}),state,updatedAt:Date.now() });
    setMessage((s.buildOutcome || j.buildOutcome) && state!=='expired' ? minimumUnavailableMessage : s.settlementVerified ? 'Settlement verified by the server.' : state==='expired' ? 'Finalized unused permit expiry verified. Close completed activity to start a new swap. No order was signed or resubmitted by recovery.' : state==='permit-exposed' ? 'Signed permit exposure saved. No order is available to submit. Do not sign or build again; recover status until independently finalized unused permit expiry permits closure.' : `Saved operation: ${state}. Settlement not verified. Recovery never signs or resubmits.`);
    permitBytes.current = null; setPrepared(null); setOrder(null); context.current = null;
  });
  const ownershipChallenge = () => run(async () => {
    if (!journal || !wallet.provider || !wallet.account || wallet.account.toLowerCase() !== journal.account) throw new Error('Select saved account');
    if (!recoveryOptionsOpen || !sameExecutionJournal(readExecutionJournal(localStorage),journal)) throw new Error('Recovery options changed');
    const generation=recoveryGeneration.current;
    const c={provider:wallet.provider,selection:wallet.selectionRevision,generation,optionsGeneration:proofGeneration.current};
    const check=() => walletGuard(c.provider,journal.account,() => mounted.current && recoveryGeneration.current===generation && proofGeneration.current===c.optionsGeneration && current.current.wallet.provider===c.provider && current.current.wallet.selectionRevision===c.selection && sameExecutionJournal(readExecutionJournal(localStorage),journal));
    await check();
    const p=validateRecoveryChallenge(await executionApi.ownershipChallenge(journal.account),journal.account,location.origin);
    await check();proofContext.current=c;setProof(p);
  });
  const ownershipRecover = () => run(async () => {
    if (!proof || !journal || !proofContext.current) throw new Error('Proof missing');
    const c=proofContext.current;
    const check=async()=>{validateRecoveryChallenge(proof,journal.account,location.origin);await walletGuard(c.provider,journal.account,() => mounted.current && recoveryGeneration.current===c.generation && proofGeneration.current===c.optionsGeneration && current.current.wallet.provider===c.provider && current.current.wallet.selectionRevision===c.selection && sameExecutionJournal(readExecutionJournal(localStorage),journal));};
    await check();
    const signature=await signExecution(c.provider,journal.account,proof.typedData,check);
    const response=recoveredExecutionsSchema.parse(await executionApi.ownershipRecover(proof.challengeId,signature));
    await check();
    const exact=response.executions.find(s=>journal.id ? s.id===journal.id : s.clientRequestId===journal.clientRequestId);
    // Lost local storage can attempt a fresh prepare, which the server blocks
    // before another permit. Ownership proof discovers the prior unresolved ID.
    const saved=exact??(journal.state==='preparing' && !journal.id ? response.executions.find(s=>s.account===journal.account && ['permit-exposed','built','submitting','pending','unknown'].includes(s.state)):undefined);
    if(!saved) throw new Error('Saved execution not reattached');
    const recoveredJournal=exact?journal:{version:1 as const,account:journal.account,clientRequestId:saved.clientRequestId!,state:'unknown' as const,updatedAt:Date.now()};
    const s=journal.id ? validateOwnershipRecoveryStatus(saved,journal) : validateExecutionStatus(saved,recoveredJournal);
    write({...recoveredJournal,...(s.buildOutcome ? {buildOutcome:s.buildOutcome} : {}),permitRequested:s.buildOutcome ? true : recoveryPermitRequested(recoveredJournal),clientRequestId:s.clientRequestId??recoveredJournal.clientRequestId,id:s.id,...(s.orderHash?{orderHash:s.orderHash}:{}),...(!s.orderHash && s.request && s.permit ? {publicRecovery:{request:s.request,permit:s.permit}} : {}),state:recoveredJournalState(recoveredJournal,s.state,s.settlementVerified),updatedAt:Date.now()});
    setRecoveryRequired(false);setProof(null);proofContext.current=null;
    setMessage('Saved execution session recovered. Check status for fresh settlement evidence. No order was signed or resubmitted.');
    // Same explicit recovery action continues with public reads, never another
    // wallet prompt or private reconciliation POST. Legacy journals can finally
    // retain the proof inputs absent from their original schema.
    if(!s.orderHash && s.request && s.permit && !['filled','expired'].includes(s.state)) await checkPublic();
  });
  const discardUnsigned = () => run(async () => {
    if (!journal) throw new Error('Unsigned review missing');
    // Runs under the same cross-tab lock as every signature path. Never trust
    // React's possibly stale journal, recovered server state or wall-clock expiry.
    discardUnsignedJournal(localStorage,journal);
    setJournal(null);setPrepared(null);setOrder(null);permitBytes.current=null;context.current=null;setRecoveryRequired(false);setProof(null);proofContext.current=null;
    setMessage('Unsigned swap discarded. No signature was requested. No order was submitted.');
  });
  const exitReview = () => run(async () => {
    if(!journal)throw new Error('Recovery record missing');
    // Cosmetic exit only: never remove the journal, permit latch or server reservation.
    setJournal(exitProtectedReview(localStorage,journal));
    setPrepared(null);setOrder(null);permitBytes.current=null;context.current=null;
    setMessage('Review closed. This action does not submit or cancel an order and does not revoke your signed permit. Recovery remains saved. Follow the expiry check below before a fresh swap.');
  });
  const closeOrderReview = exitReview;
  const closeCompleted = () => run(async () => {
    if(!journal || !['filled','expired'].includes(journal.state) || !sameExecutionJournal(readExecutionJournal(localStorage),journal))throw new Error('Terminal recovery record changed');
    localStorage.removeItem(EXECUTION_JOURNAL_KEY);
    if(localStorage.getItem(EXECUTION_JOURNAL_KEY)!==null)throw new Error('Activity could not be closed');
    setJournal(null);setPrepared(null);setOrder(null);permitBytes.current=null;context.current=null;
    setMessage('Completed activity closed after verified terminal recovery.');
  });
  const visibleReceipt = receipt && journal?.state==='filled' && receipt.account===journal.account && receipt.clientRequestId===journal.clientRequestId && receipt.orderHash===journal.orderHash ? receipt : null;
  const unsigned = canDiscardUnsigned(journal);
  const terminal = journal && ['filled','expired'].includes(journal.state);
  if (!enabled && !journal && !storageBlocked) return null;
  return <section className="fusion-execution" aria-label="Gasless swap execution">
    {!journal && enabled && <button className="primary full" aria-describedby={reviewBlockedReason ? 'swap-balance-hint' : undefined} disabled={busy || !intent || previewFloor === null || !wallet.account || wallet.chainId !== 137 || storageBlocked || Boolean(reviewBlockedReason)} onClick={() => void review()}>Review</button>}
    {preparation && <div className="preparation-progress" role="status" aria-label={preparation.order ? 'Preparing order review' : 'Preparing swap'}><div className="progress-heading"><NimiqSpinner /><strong>{preparation.order ? 'Preparing order review' : 'Preparing swap'} · {elapsed}s elapsed</strong></div><p>{preparation.phase}</p><p>{preparation.order ? 'Your signed permit remains independently usable until expiry. Wait for the separate order review; no order signature or submission happens automatically.' : 'Usually a few seconds; network checks can take longer. No signature requested yet.'}</p></div>}
    {journal && !prepared && !preparation && <div className="execution-recovery" role="status">
      <h4>{terminal ? journal.state==='filled' ? 'Swap completed' : 'Swap not executed' : unsigned ? 'Unsigned swap saved' : journal.reviewExited ? 'Permit recovery saved' : journal.state==='order-requested' || journal.state==='built' ? 'Order review paused' : journal.buildOutcome ? journal.reviewExited ? 'Permit recovery saved' : 'Swap not published' : 'Swap status'}</h4>
      <p>{terminal ? journal.state==='expired' ? 'Finalized unused permit expiry verified. Close this activity to start a new swap.' : 'Close this completed activity before starting a new swap.' : unsigned ? 'No signature was requested. Discard this local attempt to start again; no wallet connection or session recovery proof is needed. This does not cancel a server record.' : journal.buildOutcome ? minimumUnavailableMessage : 'Your saved swap is protected. Status checks never sign or submit another order. A signed permit remains valid independently until expiry.'}</p>
      {terminal && journal.state==='filled' && <div className="swap-receipt" aria-label="Verified swap receipt">{visibleReceipt ? <><p><strong>Received {units(visibleReceipt.receivedAmount,visibleReceipt.tokenOut)}</strong></p><p>Actual net amount from finalized Polygon transfers.</p><a href={`https://polygonscan.com/tx/${visibleReceipt.transactionHash}`} target="_blank" rel="noopener noreferrer">View transaction on PolygonScan ↗</a></> : <p>Actual received amount and transaction are not yet independently verified in this browser. No quote or balance change is used as a receipt.</p>}</div>}
      <details className="consent-details" open={recoveryOptionsOpen} onToggle={event => {
        const open=event.currentTarget.open; setRecoveryOptionsOpen(open);
        if(!open) { proofGeneration.current++; setProof(null); proofContext.current=null; }
      }}><summary>Operation details</summary><p>Saved operation: <strong>{journal.state}</strong></p><p>Account: <code>{journal.account}</code></p><p>Operation ID: <code>{journal.id ?? journal.clientRequestId}</code></p>{journal.orderHash && <p>Order hash: <code>{journal.orderHash}</code></p>}{!unsigned && <button disabled={busy || !wallet.account || wallet.account.toLowerCase() !== journal.account} onClick={() => void recover()}>Recover swap status</button>}
        {!unsigned && recoveryRequired && !journal.publicRecovery && !terminal && !proof && <div className="alert"><p>This older activity lacks the public evidence needed for automatic recovery. Its private record may need a separate non-spending ownership proof. A missing session is not a failed-swap result. No order will be retried.</p><button disabled={busy || !wallet.account || wallet.account.toLowerCase() !== journal.account} onClick={() => void ownershipChallenge()}>Review session recovery proof</button></div>}
        {!unsigned && proof && recoveryOptionsOpen && !terminal && <div className="alert" aria-label="Confirm session recovery proof"><h4>Confirm non-spending recovery</h4><p>Account: <code>{journal.account}</code></p><p>Origin: {location.origin} · Polygon (137)</p><p>Domain: Harbor execution recovery · version 1</p><p>Challenge: <code>{proof.challengeId}</code></p><p>Expires: {new Date(proof.expiresAt).toISOString()}</p><p>This signature proves account ownership for the current server session only. No token permit, allowance, order or transaction is signed.</p><button disabled={busy} onClick={() => void ownershipRecover()}>Confirm recovery proof and sign</button><button disabled={busy} onClick={() => {setProof(null);proofContext.current=null;}}>Cancel recovery proof</button></div>}
      </details>
      {canExitProtectedReview(journal) && !terminal && <button disabled={busy} onClick={() => void exitReview()}>Exit review — keep permit recovery</button>}
      {unsigned && <button className="full" disabled={busy} onClick={() => void discardUnsigned()}>Discard unsigned swap</button>}
      {!unsigned && (!terminal || (journal.state==='filled' && !visibleReceipt)) && <button disabled={busy || !wallet.account || wallet.chainId!==137 || wallet.account.toLowerCase() !== journal.account} onClick={() => void run(checkPublic,true)}>Check swap status</button>}
      {!unsigned && !terminal && (journal.reviewExited || ['built','order-requested'].includes(journal.state)) && (journal.publicRecovery?.permit ? <RetryDeadline seconds={journal.publicRecovery.permit.deadline} /> : <p>Permit deadline is unavailable in this older local record. Use Check swap status with the saved account; do not guess expiry or clear recovery. A fresh swap requires independent terminal proof.</p>)}
      {journal.reviewExited && !terminal && <p>Review is closed. This is saved permit recovery, not a swap in progress. New swaps stay blocked until unused expiry or settlement is independently verified.</p>}
      {!unsigned && (!wallet.account || wallet.account.toLowerCase() !== journal.account) && <p>Reconnect and select the saved account to recover. Use Connect wallet or Change account in the wallet menu, then select <code>{journal.account}</code>. No new swap will be submitted.</p>}
      {terminal && <button disabled={busy} onClick={() => void closeCompleted()}>Close completed activity</button>}
    </div>}

    {prepared && !preparation && <SwapConsent prepared={prepared} order={order} minimum={context.current?.floor ?? 0n} unsigned={unsigned} busy={busy} blocked={!enabled || Boolean(context.current?.invalid)} onCancel={() => void discardUnsigned()} onPermit={() => void permit()} onPublish={() => void publish()} onExitOrder={() => void closeOrderReview()} />}
    {signatureNotice && <p role="status">{signatureNotice}</p>}
    {message && (!journal?.buildOutcome || (message !== minimumUnavailableMessage && !message.startsWith('Swap interrupted')) || journal.state==='expired') && <p role="status">{message}</p>}
    {busy && !preparation && <p role="status">{checkingPublic ? 'Checking saved swap using read-only evidence… No wallet signature or order submission is requested.' : 'Working… Do not start another swap. Wallet backgrounding is supported; wait for the result.'}</p>}
  </section>;
}

// Pure review surface: rendering fixtures never invoke signing or API handlers.
export function SwapConsent({ prepared, order, minimum, unsigned, busy, blocked, onCancel, onPermit, onPublish, onExitOrder }: {
  prepared: PreparedExecution; order: ReviewedOrder | null; minimum: bigint;
  unsigned: boolean; busy: boolean; blocked: boolean;
  onCancel: () => void; onPermit: () => void; onPublish: () => void; onExitOrder?: () => void;
}) {
  return <>
    {!order && <div className="swap-consent" aria-label="Confirm exact token permit">
      <div className="consent-heading"><h4 id="permit-consent">Allow token spending</h4><span>Step 1 of 2</span></div>
      <dl className="consent-summary"><div><dt>Pay</dt><dd>{units(prepared.request.amount,prepared.request.tokenIn,true)}</dd></div><div><dt>{prepared.minimumPolicy ? 'Indicative minimum · not final' : 'Minimum for order review'}</dt><dd>{units(String(minimum),prepared.request.tokenOut,true)}</dd></div><div><dt>Selected slippage</dt><dd>{prepared.request.slippageBps / 100}%</dd></div><div><dt>Permit expires</dt><dd><Deadline seconds={prepared.permit.deadline} /></dd></div></dl>
      <p className="consent-notice">{prepared.minimumPolicy ? 'Review the final minimum in step 2; it may differ from this preview.' : 'The net review minimum cannot be lowered after signing.'} This permit allows spending until expiry, even if you cancel the order. The order needs a separate confirmation.</p>
      <details className="consent-details"><summary>Exact amounts &amp; permission details</summary><p>Polygon (137) · ≈ marks shortened amounts; exact base units below.</p><p>Owner / recipient: <code>{prepared.request.account}</code></p><p>Pay token: <code>{prepared.request.tokenIn}</code></p><p>Receive token: <code>{prepared.request.tokenOut}</code></p><p>Spender (Router v6): <code>{FUSION_SPENDER}</code></p><p>Exact pay base units: <code>{prepared.request.amount}</code></p><p>{prepared.minimumPolicy ? 'Indicative minimum base units' : 'Review minimum base units'}: <code>{String(minimum)}</code></p><p>Permit nonce: <code>{prepared.permit.nonce}</code></p><p>{prepared.minimumPolicy ? 'The final net minimum includes provider costs and uses your selected slippage. Only the separately signed order fixes that minimum.' : 'This minimum is net of provider costs and required for order review, not a guaranteed fill.'} No order is published by this signature.</p></details>
      <div className="consent-actions">{unsigned && <button disabled={busy} onClick={onCancel}>Cancel</button>}<button className="primary" aria-describedby="permit-consent" disabled={busy || blocked} onClick={onPermit}>Swap</button></div>
    </div>}
    {order && <div className="swap-consent" aria-label="Confirm exact Fusion order">
      <div className="consent-heading"><h4 id="order-consent">Confirm swap</h4><span>Step 2 of 2</span></div>
      <dl className="consent-summary"><div><dt>Pay</dt><dd>{units(prepared.request.amount,prepared.request.tokenIn,true)}</dd></div><div><dt>Receive at least if filled</dt><dd>{units(order.built.minimumReceiveAmount,prepared.request.tokenOut,true)}</dd></div><div><dt>Order expires</dt><dd><Deadline seconds={order.built.deadline} /></dd></div></dl>
      <p className="consent-notice">{prepared.minimumPolicy && <>This final net minimum includes provider costs and cannot be lowered after signing. </>}This separate signature publishes the order. A fill is not guaranteed. Your signed permit remains valid independently until its expiry.</p>
      <details className="consent-details"><summary>Exact amounts &amp; order details</summary><p>Polygon (137) · no partial or multiple fills</p><p>≈ marks shortened amounts; exact base units below.</p><p>Owner / recipient: <code>{prepared.request.account}</code></p><p>Pay token: <code>{prepared.request.tokenIn}</code></p><p>Exact pay base units: <code>{prepared.request.amount}</code></p><p>Receive token: <code>{prepared.request.tokenOut}</code></p><p>Exact minimum receive base units: <code>{order.built.minimumReceiveAmount}</code></p><p>Selected slippage: {prepared.request.slippageBps / 100}%</p><p>Spender (Router v6): <code>{FUSION_SPENDER}</code></p><p>Permit expires: {new Date(prepared.permit.deadline*1000).toISOString()}</p><p>Order hash: <code>{order.built.orderHash}</code></p><p>No POL transaction or approval fallback. Resolver pays gas if filled. Publication is not settlement.</p></details>
      <div className="consent-actions">{onExitOrder && <button disabled={busy} onClick={onExitOrder}>Cancel — keep permit recovery</button>}<button className="primary" aria-describedby="order-consent" disabled={busy || blocked} onClick={onPublish}>Swap</button></div>
    </div>}
  </>;
}
