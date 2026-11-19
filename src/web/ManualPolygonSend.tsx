import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { lightningPanel } from './lightning/lightning.js';
import './pay.css';
import './pay-receipt.css';
import { PayTransferReceipt } from './PayTransferReceipt';
import type { Payment } from './pay-receipt';
import {ASSETS,NETWORKS,preflight,walletRead,quantity,same,rejected,balance,fee,enough,maxNative,parseAmount,format,transfer,hex,validPayAddress,type Asset,type Network,type Provider} from './pay-core';
type Wallet={provider:Provider|null;account:string|null;selectionRevision:number;chainId?:number|null};
type Draft={asset:Asset;from:string;to:string;units:bigint;gas:bigint;gasPrice:bigint;fee:bigint;native:bigint;stamp:number;created:number};
let physical=false;
export function ManualBankSend({wallet,onOpen,restoreFocus,hideTrigger=false}:{wallet:Wallet;onOpen:()=>void;restoreFocus:()=>void;hideTrigger?:boolean}){
 const dialog=useRef<HTMLDialogElement|null>(null),latest=useRef(wallet);latest.current=wallet;
 const lightningHost=useRef<HTMLDivElement|null>(null),[tab,setTab]=useState<'tokens'|'lightning'>('tokens');
 const [nativeBusy,setNativeBusy]=useState(false);
 const requestClose=useRef<()=>void>(()=>{});
 const openPayment=useRef<(method: 'tokens'|'lightning')=>void>(()=>{});
 useEffect(()=>{
  const host=lightningHost.current;
  host?.append(lightningPanel);
  const activateLightning=()=>openPayment.current('lightning');
  const closePay=()=>requestClose.current();
  const updateNativeBusy=()=>setNativeBusy(lightningPanel.dataset.paymentPending==='true');
  updateNativeBusy();
  lightningPanel.addEventListener('harbor:close-pay',closePay);
  lightningPanel.addEventListener('harbor:payment-pending',updateNativeBusy);
  const activatePay=()=>openPayment.current('tokens');
  window.addEventListener('harbor:open-lightning',activateLightning);
  window.addEventListener('harbor:open-pay',activatePay);
  return()=>{
   lightningPanel.removeEventListener('harbor:close-pay',closePay);
   lightningPanel.removeEventListener('harbor:payment-pending',updateNativeBusy);
   window.removeEventListener('harbor:open-lightning',activateLightning);
   window.removeEventListener('harbor:open-pay',activatePay);
   if(lightningPanel.parentElement===host)lightningPanel.remove();
  };
 },[]);
 const [open,setOpen]=useState(false),[network,setNetwork]=useState<Network>('polygon'),[key,setKey]=useState('USDT'),[to,setTo]=useState(''),[amount,setAmount]=useState('');
 const asset=ASSETS.find(a=>a.key===key)!;
 const [draft,setDraft]=useState<Draft|null>(null),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[payment,setPayment]=useState<Payment|null>(null),[uncertain,setUncertain]=useState(false),[chain,setChain]=useState<number|null>(null),[visible,setVisible]=useState<string|null>(null),[refresh,setRefresh]=useState(0);
 const epoch=useRef(0),flight=useRef(false);
 const invalidate=()=>{epoch.current++;setDraft(null);if(!uncertain)setMessage('');};
 const inputs=useRef({network,key,to,amount,open,tab});inputs.current={network,key,to,amount,open,tab};
 useEffect(()=>{invalidate();setChain(null);setVisible(null);setRefresh(v=>v+1);const p=wallet.provider;
  const changed=()=>{invalidate();setChain(null);setVisible(null);setMessage('Wallet account or network changed. Review again.');setRefresh(v=>v+1);};
  const visibility=()=>{if(document.visibilityState==='visible')setRefresh(v=>v+1);};
  for(const e of ['accountsChanged','chainChanged','disconnect'])p?.on?.(e,changed);document.addEventListener('visibilitychange',visibility);
  return()=>{epoch.current++;for(const e of ['accountsChanged','chainChanged','disconnect'])p?.removeListener?.(e,changed);document.removeEventListener('visibilitychange',visibility);};
 },[wallet.provider,wallet.account,wallet.selectionRevision]);
 useEffect(()=>{let active=true;setChain(null);if(open&&tab==='tokens'&&wallet.provider)walletRead(wallet.provider,'eth_chainId').then(v=>{if(active)setChain(Number(quantity(v)));}).catch(()=>{if(active)setChain(null);});return()=>{active=false;};},[open,tab,wallet.provider,wallet.account,wallet.selectionRevision,refresh]);
 useEffect(()=>{let active=true;setVisible(null);if(open&&tab==='tokens'&&wallet.provider&&wallet.account)balance(asset,wallet.account).then(v=>{if(active)setVisible(format(v,asset.decimals));}).catch(()=>{if(active)setVisible('unavailable');});return()=>{active=false;};},[open,tab,key,wallet.account,wallet.provider,wallet.selectionRevision,refresh]);
 // Ref identity changes on every render; compare values, not object identity.
 function capture(){const p=wallet.provider,from=wallet.account,stamp=epoch.current,rev=wallet.selectionRevision,snapshot={...inputs.current};
  if(!p||!from||!validPayAddress(from))throw Error('Connect and select a wallet account in the header first.');
  const guard=()=>{const i=inputs.current;if(epoch.current!==stamp||latest.current.provider!==p||latest.current.selectionRevision!==rev||!same(latest.current.account,from)||!dialog.current?.open||!i.open||i.tab!=='tokens'||(Object.keys(snapshot) as (keyof typeof snapshot)[]).some(k=>snapshot[k]!==i[k]))throw Error('Wallet or payment input changed. Review again.');};
  return{p,from,stamp,guard,check:()=>preflight(p,from,network,guard)};
 }
 async function action(kind:'review'|'max'|'send'|'switch'){
  if(flight.current||physical||uncertain||payment||!dialog.current?.open||tab!=='tokens')return;flight.current=true;physical=true;setBusy(true);setMessage('');let attempted=false;let start=epoch.current;
  try{
   const c=capture();
   if(kind==='switch'){
    invalidate();const expected=NETWORKS[network];let error:unknown;
    try{await c.p.request({method:'wallet_switchEthereumChain',params:[{chainId:expected.hex}]});}catch(e){error=e;}
    // Always read back the actual chain, including rejection, unsupported and no-op.
    let actual:number|null=null;try{actual=Number(quantity(await walletRead(c.p,'eth_chainId')));}catch{}
    if(latest.current.provider!==c.p||!same(latest.current.account,c.from)||latest.current.selectionRevision!==wallet.selectionRevision)throw Error('Wallet changed during network selection. Check your wallet and try again.');
    setChain(actual);
    if(error)throw Error(rejected(error)?'Network switch declined. Nothing was signed or sent. Select the network in your wallet or try again.':'This wallet could not switch networks. Select the network manually in your wallet, then retry. No network was added and nothing was sent.');
    if(actual!==expected.id)throw Error(`${expected.name} was not selected by the wallet. Select it manually or retry. Nothing was sent.`);
    setMessage(`${expected.name} selected. Review the transfer separately; nothing was sent.`);return;
   }
   await c.check();
   if(!validPayAddress(to))throw Error('Enter a valid nonzero recipient address.');
   if(kind==='max'){
    invalidate();start=epoch.current;const m=capture();const units=await maxNative(asset,m.from,to,m.check);m.guard();setAmount(format(units,asset.decimals));return;
   }
   if(kind==='review'){
    setDraft(null);const units=parseAmount(amount,asset.decimals);
    await enough(asset,c.from,units,0n);c.guard();const f=await fee(asset,c.from,to,units);c.guard();const native=await enough(asset,c.from,units,f.fee);await c.check();
    setDraft({asset,from:c.from,to,units,...f,native,stamp:c.stamp,created:Date.now()});return;
   }
   const d=draft;if(!d||d.stamp!==c.stamp||d.asset.key!==key||d.to!==to||d.units!==parseAmount(amount,asset.decimals)||Date.now()-d.created>60000)throw Error('Review expired or payment changed. Review again.');
   const execute=async()=>{
    await c.check();const f=await fee(d.asset,d.from,d.to,d.units);c.guard();
    if(f.gas>d.gas||f.gasPrice>d.gasPrice)throw Error('Network fee increased. Review the transfer again.');
    await enough(d.asset,d.from,d.units,d.fee);await c.check();
    if(Date.now()-d.created>60000)throw Error('Review expired. Review again.');
    setDraft(null);attempted=true;
    const result=await c.p.request({method:'eth_sendTransaction',params:[{...transfer(d.asset,d.from,d.to,d.units),chainId:NETWORKS[d.asset.network].hex,gas:hex(d.gas),gasPrice:hex(d.gasPrice)}]});
    if(typeof result!=='string'||!/^0x[0-9a-f]{64}$/i.test(result))throw Error('Unknown result');
    // Never project a held response onto another account/input/network.
    c.guard();setPayment({hash:result,asset:d.asset,from:d.from,to:d.to,units:d.units});setRefresh(v=>v+1);
   };
   if(navigator.locks)await navigator.locks.request('harbor.manual-send.pending.v2',{ifAvailable:true},async lock=>{if(!lock)throw Error('Another payment request is pending. Check your wallet.');await execute();});else throw Error('Secure payment locking is unavailable in this browser. Use a supported secure browser.');
  }catch(e){
   setDraft(null);
   if(attempted){if(rejected(e))setMessage('Wallet request declined. Nothing was resubmitted. Review again to retry.');else{setUncertain(true);setMessage('Wallet request outcome unknown. Check your wallet and the explorer before any new payment. Harbor will not retry; sending again could duplicate payment.');}}
   else if(kind==='switch'||epoch.current===start)setMessage(e instanceof Error?e.message:'Could not verify the transfer. Nothing was sent. Review again.');
  }finally{flight.current=false;physical=false;setBusy(false);}
 }
 const lightningPending=()=>lightningPanel.dataset.paymentPending==='true';
 const blocked=()=>flight.current||lightningPending();
 const selectTab=(next:'tokens'|'lightning')=>{
  if(blocked())return false;
  if(tab!==next){invalidate();setTab(next);}
  return true;
 };
 openPayment.current=method=>{
  const d=dialog.current;
  if(!d||blocked())return;
  if(!d.open||tab!==method)invalidate();
  setTab(method);setOpen(true);onOpen();
  if(!d.open){d.showModal();d.scrollTop=0;}
  requestAnimationFrame(()=>{
   if(!d.open)return;
   const target=method==='lightning'?lightningPanel.querySelector('textarea'):d.querySelector<HTMLButtonElement>('#pay-tab-tokens');
   if(target&&!target.disabled)target.focus({preventScroll:true});
   else d.querySelector<HTMLButtonElement>(`#pay-tab-${method}`)?.focus({preventScroll:true});
  });
 };
 const close=()=>{if(blocked())return;dialog.current?.close();};
 requestClose.current=close;
 const onClose=()=>{invalidate();setOpen(false);restoreFocus();};
 return <>{!hideTrigger&&<div className="manual-send"><button type="button" className="text-button" onClick={()=>openPayment.current('tokens')}><span className="wallet-action-icon pay-menu-icon" aria-hidden="true">→</span>Pay with wallet</button></div>}{createPortal(<dialog ref={dialog} className="manual-send-dialog pay-unified" aria-label="Pay with wallet" onClose={onClose} onCancel={e=>{e.preventDefault();close();}}>
  <div role="tablist" aria-label="Payment method" className="pay-method-tabs">{(['tokens','lightning'] as const).map(t=><button key={t} type="button" role="tab" id={'pay-tab-'+t} aria-selected={tab===t} aria-controls={'pay-panel-'+t} tabIndex={tab===t?0:-1} aria-disabled={busy||nativeBusy} onClick={()=>selectTab(t)} onKeyDown={e=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(e.key)){e.preventDefault();const next=e.key==='Home'?'tokens':e.key==='End'?'lightning':tab==='tokens'?'lightning':'tokens';if(selectTab(next))document.getElementById('pay-tab-'+next)?.focus();}}}><PayMethodIcon method={t}/>{t==='tokens'?'Send tokens':'Pay Lightning invoice'}</button>)}</div>
  <div role="tabpanel" id="pay-panel-tokens" aria-labelledby="pay-tab-tokens" hidden={tab!=='tokens'}>
  {payment ? <PayTransferReceipt payment={payment} active={open&&tab==='tokens'} onNew={()=>{setPayment(null);setTo('');setAmount('');invalidate();setRefresh(v=>v+1);requestAnimationFrame(()=>dialog.current?.querySelector<HTMLInputElement>('input[placeholder="Paste recipient address"]')?.focus());}}/> : <>
  <div className="manual-send-instructions"><p>Copy the recipient, network and exact amount from Mt Pelerin.</p><p className="manual-send-sender-warning"><strong>Use the same sending wallet address associated with your Mt Pelerin order.</strong> Check every detail against your order. For Lightning, use the Pay Lightning invoice tab.</p></div>
  <p className="manual-send-from">You are sending from:<br/><code>{wallet.account??'Connect and select a wallet account in the header.'}</code></p>
  <fieldset className="manual-send-token-field"><legend>Network</legend><div className="manual-send-token-list">{(Object.keys(NETWORKS) as Network[]).map(n=><button key={n} type="button" disabled={busy} aria-pressed={network===n} className="manual-send-token-option" onClick={()=>{invalidate();setNetwork(n);setKey(n==='polygon'?'USDT':'ETH');setAmount('');}}>{NETWORKS[n].name}</button>)}</div></fieldset>
  <p role="status">Wallet network: {chain===1?'Ethereum · Chain 1':chain===137?'Polygon · Chain 137':chain===null?'unavailable':`Chain ${chain}`}</p>
  {chain!==NETWORKS[network].id&&<button type="button" className="secondary full" disabled={busy||!wallet.account||uncertain} onClick={()=>void action('switch')}>Switch wallet to {NETWORKS[network].name}</button>}
  <label>Recipient address<input placeholder="Paste recipient address" value={to} disabled={busy} onChange={e=>{invalidate();setTo(e.target.value);}} autoComplete="off" spellCheck={false}/></label>
  <fieldset className="manual-send-token-field"><legend>Token · {NETWORKS[network].name}</legend><div className="manual-send-token-list">{ASSETS.filter(a=>a.network===network).map(a=><button key={a.key} type="button" className="manual-send-token-option" aria-pressed={key===a.key} disabled={busy} onClick={()=>{invalidate();setKey(a.key);setAmount('');}}><span className="pay-token-monogram" aria-hidden="true">{a.mark}</span><span>{a.symbol}</span></button>)}</div></fieldset>
  <p className="pay-asset-identity">{asset.symbol} · {NETWORKS[network].name} · {asset.decimals} decimals<br/>{asset.address?<code>{asset.address}</code>:<>Native {asset.symbol} (not wrapped)</>}</p>
  <p role="status">{asset.symbol} balance: {!wallet.account?'Connect a wallet':visible??'Loading…'}</p>
  <label>Exact amount<input placeholder="0.00" value={amount} disabled={busy} onChange={e=>{invalidate();setAmount(e.target.value);}} inputMode="decimal" autoComplete="off"/></label>
  {!asset.address&&<button className="text-button" disabled={busy||!wallet.account||chain!==NETWORKS[network].id||uncertain} onClick={()=>void action('max')}>Max</button>}
  {draft&&<div className="manual-send-review"><strong>Confirm irreversible transfer</strong><p>From: <code>{draft.from}</code></p><p>To: <code>{draft.to}</code></p><p>Exact amount: {format(draft.units,draft.asset.decimals)} {draft.asset.symbol}</p><p>{NETWORKS[draft.asset.network].name} mainnet · Chain {NETWORKS[draft.asset.network].id}</p>{draft.asset.address&&<p>Token contract: <code>{draft.asset.address}</code></p>}<p>Conservative maximum network fee: {format(draft.fee,18)} {NETWORKS[draft.asset.network].native} (20% gas-limit margin, twice the sampled gas price; actual fee may be lower).</p><p>Total reserved: {draft.asset.address?`${format(draft.units,draft.asset.decimals)} ${draft.asset.symbol} + ${format(draft.fee,18)} ${NETWORKS[draft.asset.network].native}`:`${format(draft.units+draft.fee,18)} ${NETWORKS[draft.asset.network].native}`}</p><button className="primary full" disabled={busy||uncertain} onClick={()=>void action('send')}>Confirm and open wallet</button></div>}
  {(message||uncertain)&&<p role="status">{uncertain?'Wallet request outcome unknown. Check your wallet and the explorer before any new payment. Harbor will not retry; sending again could duplicate payment.':message}</p>}
  {busy&&<p role="status">Waiting for wallet or read-only network checks… Do not send again.</p>}
  {!draft&&<button className="primary full" disabled={busy||!wallet.account||chain!==NETWORKS[network].id||uncertain} onClick={()=>void action('review')}>Review transfer</button>}
  <p className="fine-print">Read-only checks share the selected address and transfer details with the selected network’s independent RPC. Selecting a network or token never switches your wallet or sends a transaction.</p>
  </>}
  </div>
  <div ref={lightningHost} role="tabpanel" id="pay-panel-lightning" aria-labelledby="pay-tab-lightning" hidden={tab!=='lightning'}></div>
  <button type="button" className="secondary full pay-close" disabled={busy||nativeBusy} onClick={close}>Close</button>
 </dialog>,document.body)}</>;
}

// Generic chain-link and faceted geometry, not redistributed brand artwork.
function PayMethodIcon({method}:{method:'tokens'|'lightning'}){
 if(method==='lightning')return <svg aria-hidden="true" className="pay-method-icon" viewBox="0 0 42 32"><path fill="#000" d="m23 1-12 17h9l-2 13L32 13H22z"/></svg>;
 return <svg aria-hidden="true" className="pay-method-icon" viewBox="0 0 42 34">
  <path d="m18 10-4-2-8 5v9l8 5 8-5v-5l7-4" fill="none" stroke="#5823b0" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round"/>
  <path d="m29 2 10 15-10 6-10-6zm0 23 10-6-10 13-10-13z" fill="#7342bc"/>
  <path d="m29 2 10 15-10 6zm0 23 10-6-10 13z" fill="#331b6d"/>
 </svg>;
}
