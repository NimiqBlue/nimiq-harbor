import { init } from '@nimiq/mini-app-sdk';
import { invoice, verifySettlement, UUID } from './settlement.js';
import { prePaymentRejection, retryable, recoveryIdentity } from './rejection.js';
const KEY='harbor.lightning.v2', LOCK='harbor-lightning-payment';
let ledger, storageOK=true, busy=false, checking=false, timer, epoch=0, selected=null, captured=null, edited=false;
function load(){const raw=localStorage.getItem(KEY);const v=raw?JSON.parse(raw):{};if(!v||Array.isArray(v)||typeof v!=='object')throw Error('storage');return v}
try { ledger=load(); } catch {ledger={};storageOK=false}
function save(record){if(!storageOK)throw Error('storage');const all=load();if(all[record.hash]?.state==='paid'&&record.state!=='paid')throw Error('stale');all[record.hash]=record;const raw=JSON.stringify(all);localStorage.setItem(KEY,raw);if(localStorage.getItem(KEY)!==raw)throw Error('storage');ledger=all;return record}
export const lightningPanel=document.createElement('div');
const dialog=lightningPanel;
dialog.className='harbor-lightning';
dialog.innerHTML=`<div class="hl-body"><p>Pay with NIM or USDT in Nimiq Pay.</p><label>Lightning invoice<textarea rows="3" maxlength="12000" spellcheck="false" autocapitalize="off" autocomplete="off" placeholder="Paste the Mt Pelerin BOLT11 invoice"></textarea></label><p class="hl-source">Paste an invoice, or create a Lightning order in Bank to capture it automatically.</p><button class="hl-pay" type="button">Pay with Nimiq Pay</button><p role="status" aria-live="polite"></p><button class="hl-check" type="button" hidden>Check payment status</button><details class="hl-recover"><summary>Check an existing payment</summary><label>Nimiq Pay swap ID<input type="text" maxlength="36" autocomplete="off" placeholder="Swap ID from the wallet"></label><button class="hl-recover-button" type="button">Check existing payment — no payment</button></details><label class="hl-history-label" hidden>Saved payments<select aria-label="Saved Lightning payments"></select></label><p class="hl-note">Mt Pelerin processes payments in batches. Lightning payments are reviewed manually, so swaps may not be instant.</p><p class="hl-disclosure">Verified paid refers to Lightning settlement only. Recovery is saved on this device. Checking sends the swap ID to Fastspot and never retries payment.</p></div>`;
const recoveryHelp=document.createElement('p');recoveryHelp.className='hl-recovery-help';recoveryHelp.hidden=true;recoveryHelp.textContent='This saved attempt has no definitive cancellation evidence. Harbor cannot infer non-payment from a remembered cancellation, a timeout or an old error. Do not pay it again. Find the swap ID in Nimiq Pay and use Check an existing payment with this exact invoice. If no ID is available, keep these details and ask Nimiq Pay support to establish the outcome; Harbor cannot safely unlock this invoice.';dialog.querySelector('.hl-check').after(recoveryHelp);
const exportButton=document.createElement('button');exportButton.type='button';exportButton.className='text-button hl-export';exportButton.textContent='Save recovery details';exportButton.hidden=true;recoveryHelp.after(exportButton);
exportButton.onclick=()=>{const r=current();if(!r)return;const url=URL.createObjectURL(new Blob([JSON.stringify(r,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download='harbor-lightning-recovery-'+r.hash.slice(0,12)+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)};
const safeClose=document.createElement('button');safeClose.type='button';safeClose.className='text-button hl-safe-close';safeClose.textContent='Close — keep payment saved';safeClose.onclick=()=>dialog.dispatchEvent(new Event('harbor:close-pay'));dialog.querySelector('.hl-body').append(safeClose);
const input=dialog.querySelector('textarea'),pay=dialog.querySelector('.hl-pay'),status=dialog.querySelector('[role=status]'),source=dialog.querySelector('.hl-source'),check=dialog.querySelector('.hl-check'),swapInput=dialog.querySelector('input'),history=dialog.querySelector('select');
function current(){return selected?ledger[selected]:null}
function render(){if(dialog.dataset.paymentPending!==String(busy)){dialog.dataset.paymentPending=String(busy);dialog.dispatchEvent(new Event('harbor:payment-pending'));}safeClose.disabled=busy;const r=current();pay.disabled=busy||!storageOK||!!r&&!retryable(r);pay.textContent=retryable(r)?'Try again with Nimiq Pay':'Pay with Nimiq Pay';input.disabled=busy;check.hidden=!r?.swapId;check.disabled=checking||busy;history.disabled=busy;recoveryHelp.hidden=!r||r.state==='paid'||retryable(r);exportButton.hidden=!r;
 if(r){status.textContent=r.state==='paid'?`Verified paid — Lightning settlement confirmed. Checked ${new Date(r.verifiedAt).toLocaleString()}.` : checking?'Payment submitted — checking Lightning settlement…':r.note||'Payment outcome unknown. Do not repay this invoice. Check Nimiq Pay and Mt Pelerin.';swapInput.value=r.swapId||'';}
 const keys=Object.keys(ledger);dialog.querySelector('.hl-history-label').hidden=keys.length===0;
 const options=keys.map(k=>`${k}:${ledger[k].state}`).join('|');if(history.dataset.options!==options){history.replaceChildren();for(const k of keys){const o=document.createElement('option');o.value=k;o.textContent=`${k.slice(0,12)}… · ${ledger[k].state||'unknown'}`;history.append(o)}history.dataset.options=options;}if(selected)history.value=selected;
}
function select(r){selected=r.hash;input.value=r.invoice;edited=true;captured=null;render()}
history.onchange=()=>{stop();select(ledger[history.value]);start()};
input.addEventListener('input',()=>{edited=true;captured=null;stop();selected=null;source.textContent='Pasted invoice — check that it belongs to your Mt Pelerin order.';try{const v=invoice(input.value,false);ledger=load();if(ledger[v.hash])selected=v.hash}catch{}if(!selected)status.textContent='';render()});
function stop(){epoch++;clearTimeout(timer)}
async function poll(manual=false){
 const r=current();if(checking||!r?.swapId||document.hidden)return;
 if(!manual&&(r.state==='paid'||r.stopped||r.attempts>=30||Date.now()-r.startedAt>600000))return;
 const generation=epoch,hash=r.hash;checking=true;
 try{
  if(manual){r.stopped=false;r.startedAt=Date.now();r.attempts=0;}
  r.attempts=(r.attempts||0)+1;save(r);render();
  const abort=new AbortController(),timeout=setTimeout(()=>abort.abort(),12000);let data;
  try{const response=await fetch(`https://api.go.fastspot.io/swap/${r.swapId}`,{method:'GET',credentials:'omit',cache:'no-store',referrerPolicy:'no-referrer',signal:abort.signal});if(!response.ok)throw Error('read');const text=await response.text();if(text.length>100000)throw Error('size');data=JSON.parse(text)}finally{clearTimeout(timeout)}
  const result=await verifySettlement(r,data);
  if(generation!==epoch||document.hidden||selected!==hash)return;
  const latest=load()[hash];if(!latest||latest.swapId!==r.swapId||latest.invoice!==r.invoice)return;
  if(result==='paid'){r.state='paid';r.verifiedAt=Date.now();r.stopped=true;r.note='';}
  else if(result==='pending'){r.state='submitted';r.note='Payment submitted — waiting for Lightning settlement. Checking automatically; do not repay.';}
  else{r.stopped=true;r.note='Lightning settlement could not be verified. Do not repay. Check Nimiq Pay and Mt Pelerin, or check status again.';}
  if(r.attempts>=30||Date.now()-r.startedAt>600000){r.stopped=true;if(result!=='paid')r.note='Automatic checks paused. Settlement is not verified. Use Check payment status; do not repay.';}
  save(r);
 }catch{if(generation===epoch&&selected===hash){r.stopped=true;r.note='Status check unavailable. Settlement is not verified. Check again manually; do not repay.';try{save(r)}catch{storageOK=false}}}
 finally{checking=false;render();if(generation===epoch&&selected===hash&&current()&&!current().stopped&&current().state!=='paid'&&!document.hidden)timer=setTimeout(()=>poll(),Math.min(30000,2000*2**Math.min((r.attempts||1)-1,4)));}
}
function start(){clearTimeout(timer);if(!checking)poll()}
check.onclick=()=>poll(true);
document.addEventListener('visibilitychange',()=>{stop();if(!document.hidden){if(checking){timer=setTimeout(start,13000)}else start()}});
pay.onclick=async()=>{
 if(busy)return;let v;try{v=invoice(input.value);if(captured&&captured.expiry<=Date.now())throw Error('The Mt Pelerin order has expired.')}catch(e){status.textContent=e.message;return}
 if(!storageOK||!navigator.locks){status.textContent='Safe payment recovery is unavailable in this browser. No payment requested. Use Nimiq Pay directly.';return}
 busy=true;render();status.textContent='Opening Nimiq Pay…';let entered=false;
 try{await navigator.locks.request(LOCK,{ifAvailable:true},async lock=>{
  if(!lock)throw Error('busy');ledger=load();const prior=ledger[v.hash];if(prior&&!retryable(prior)){select(prior);return}const priorRaw=JSON.stringify(prior);
  const provider=await init({timeout:1500});if(typeof provider.payLightningInvoice!=='function')throw Error('unavailable');invoice(v.text);
  if(JSON.stringify(load()[v.hash])!==priorRaw)throw Error('stale');
  const r={hash:v.hash,invoice:v.text,state:'unknown',attemptId:crypto.randomUUID(),createdAt:Date.now(),note:'Wallet approval requested. Outcome unknown — do not repay this invoice.',attempts:0,startedAt:Date.now(),stopped:true};save(r);selected=v.hash;entered=true;render();const requestedRaw=JSON.stringify(r);
  let result,physicalError;
  try{result=await provider.payLightningInvoice({invoice:v.text})}catch(e){physicalError=e}
  // The physical request alone may establish refusal. Storage, validation and
  // stale-context failures must never be reclassified as wallet cancellation.
  if(JSON.stringify(load()[v.hash])!==requestedRaw)throw Error('stale');
  if(physicalError){
    if(prePaymentRejection(physicalError)){r.state='cancelled';r.rejection='native-pre-payment-v1';r.note='Cancelled in Nimiq Pay before payment approval. This attempt did not submit a payment. Try again only if you still want to pay; nothing restarts automatically.';}
    else{Object.assign(r,recoveryIdentity(physicalError));r.note=physicalError.type==='DUPLICATE_PAYMENT'?'Nimiq Pay reports a duplicate or pending payment. Do not repay. Check the saved payment status or Nimiq Pay.':'Wallet outcome not verified. No automatic retry. Do not repay this invoice; check the wallet and Mt Pelerin.';}
  }else if(result&&UUID.test(result.swapId)&&typeof result.hash==='string'&&/^(?:0x)?[a-f0-9]{64}$/i.test(result.hash)){r.swapId=result.swapId;r.transaction=result.hash;r.state='submitted';r.stopped=false;r.note='Payment submitted — checking Lightning settlement…';}
  else{r.note='Wallet outcome not verified. No automatic retry. Do not repay this invoice; check the wallet and Mt Pelerin.';}
  save(r);
 });}catch{if(!entered)status.textContent='Open Harbor inside Nimiq Pay with Lightning support. No Polygon connection is required. Safe storage and an available payment lock are required.';else{try{ledger=load()}catch{}storageOK=false;status.textContent='Recovery storage or saved attempt changed. Do not repay; check Nimiq Pay and Mt Pelerin.';}}
 finally{busy=false;render();start()}
};
dialog.querySelector('.hl-recover-button').onclick=async()=>{
 if(busy||checking||!navigator.locks)return;try{await navigator.locks.request(LOCK,{ifAvailable:true},async lock=>{if(!lock)throw Error('busy');const v=invoice(input.value,false);if(!UUID.test(swapInput.value.trim()))throw Error('Enter the exact Nimiq Pay swap ID.');const all=load(),old=all[v.hash];if(old?.swapId&&old.swapId!==swapInput.value.trim())throw Error('A different swap ID is already saved for this invoice. Use the wallet to verify it.');const r=old||{hash:v.hash,invoice:v.text,state:'unknown',createdAt:Date.now(),attempts:0,startedAt:Date.now(),stopped:true};if(retryable(r)){r.state='unknown';delete r.rejection;}r.swapId=swapInput.value.trim();save(r);selected=v.hash;render()});poll(true)}catch(e){status.textContent=['Enter the exact Nimiq Pay swap ID.','A different swap ID is already saved for this invoice. Use the wallet to verify it.'].includes(e.message)?e.message:'Check the invoice, payment lock and recovery storage. No payment was requested.'}
};
window.addEventListener('storage',e=>{if(e.key===KEY){try{ledger=load();render()}catch{storageOK=false;pay.disabled=true}}});
window.addEventListener('message',e=>{
 if(e.origin!=='https://widget.mtpelerin.com'||!e.source||document.hidden)return;
 // Bank retains visited frames. Only the source in its currently shown, known
 // SELL/SWAP panel may supply an invoice, never a hidden sibling or BUY.
 const active=document.querySelector('.external-bank [data-bank-mode][aria-hidden="false"]:not([hidden])');
 const mode=active?.getAttribute('data-bank-mode');
 if(mode!=='sell'&&mode!=='swap')return;
 const frame=active.querySelector('iframe[title="Mt Pelerin buy, sell and swap"]');
 if(!frame||e.source!==frame.contentWindow||frame.closest('[hidden], [aria-hidden="true"], [inert]')||!frame.getClientRects().length||getComputedStyle(frame).visibility!=='visible')return;
 const m=e.data,o=m?.data;if(!m||m.type!=='orderCreated'||!o||typeof o!=='object'||o.type!==mode||o.currencyIn!=='sat'||(o.type==='sell'?o.network:o.networkIn)!=='lightning_mainnet')return;
 if(typeof o.id!=='string'||!/^\d{1,64}$/.test(o.id)||typeof o.expirationDate!=='string'||!Number.isFinite(Date.parse(o.expirationDate))||Date.parse(o.expirationDate)<=Date.now()||typeof o.valueIn!=='string'||!/^\d+$/.test(o.valueIn))return;
 let v;try{v=invoice(o.lnInvoice)}catch{return}if(v.msat!==BigInt(o.valueIn)*1000n||busy||edited||current())return;
 if(captured&&(captured.id!==o.id||captured.invoice!==v.text))return;
 captured={id:o.id,invoice:v.text,expiry:Date.parse(o.expirationDate)};input.value=v.text;source.textContent=`Invoice received from Mt Pelerin · Order ${o.id}`;window.dispatchEvent(new Event('harbor:open-lightning'));
});
const saved=Object.values(ledger).filter(r=>r&&typeof r.invoice==='string'&&typeof r.hash==='string').sort((a,b)=>b.createdAt-a.createdAt);if(saved.length){select(saved[0]);start()}else render();
