import { useEffect, useRef, useState } from 'react';
import { NETWORKS, format } from './pay-core';
import { checkPayReceipt, type Payment, type ReceiptState } from './pay-receipt';

const copy = {
 pending:['Transfer submitted','Waiting for network confirmation. Do not send it again.'],
 confirmed:['Transfer confirmed','Confirmed on-chain. This does not confirm that Mt Pelerin credited your order.'],
 failed:['Transfer failed','The network rejected the transfer. Network fees may still have been charged.'],
 unverified:['Confirmation not verified','Check the status again or open the explorer. Do not send it again until you know the outcome.'],
} as const;

export function PayTransferReceipt({payment,active,onNew}:{payment:Payment;active:boolean;onNew:()=>void}){
 const [state,setState]=useState<ReceiptState>('pending'),[attempt,setAttempt]=useState(0);
 const heading=useRef<HTMLHeadingElement>(null);
 const network=NETWORKS[payment.asset.network];
 useEffect(()=>{
  let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,checks=0;
  async function poll(){
   checks++;
   let next:ReceiptState='unverified';
   try{next=await checkPayReceipt(payment);}catch{/* A read error is not a failed transfer. */}
   if(stopped)return;
   if(next==='pending'&&checks<12){timer=setTimeout(poll,4000);return;}
   setState(next==='pending'?'unverified':next);
  }
  void poll();
  return()=>{stopped=true;clearTimeout(timer);};
 },[payment,attempt]);
 useEffect(()=>{
  if(!active)return;
  const frame=requestAnimationFrame(()=>{heading.current?.focus({preventScroll:true});heading.current?.closest('dialog')?.scrollTo(0,0);});
  return()=>cancelAnimationFrame(frame);
 },[active]);
 return <section className="pay-transfer-receipt" data-state={state} aria-label="Transfer status">
  <div role="status" aria-atomic="true" className="pay-transfer-status">
   <span className="pay-transfer-status-icon" aria-hidden="true">{state==='confirmed'?'✓':state==='pending'?'…':'!'}</span>
   <h2 tabIndex={-1} ref={heading}>{copy[state][0]}</h2>
   <p>{copy[state][1]}</p>
  </div>
  <p className="pay-transfer-amount">{format(payment.units,payment.asset.decimals)} {payment.asset.symbol}</p>
  <dl><dt>Network</dt><dd>{network.name}</dd><dt>Recipient</dt><dd><code>{payment.to}</code></dd></dl>
  <div className="pay-transfer-actions">
   {state==='unverified'&&<>
    <button type="button" className="secondary full" onClick={()=>{setState('pending');setAttempt(v=>v+1);}}>Check status again</button>
    <button type="button" className="text-button" onClick={()=>{if(window.confirm('Leave this receipt? Check your wallet or the explorer before paying the same recipient again.'))onNew();}}>Dismiss status</button>
   </>}
   {(state==='confirmed'||state==='failed')&&<button type="button" className="secondary full" onClick={onNew}>New transfer</button>}
   <a className="manual-send-explorer" href={`${network.explorer}/tx/${payment.hash}`} target="_blank" rel="noopener noreferrer">View on {payment.asset.network==='polygon'?'PolygonScan':'Etherscan'}</a>
  </div>
 </section>;
}