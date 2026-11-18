'use strict';
// Browser-only safety regression harness. Never contacts a payment/order endpoint.
// Run through npm run test:lightning:browser; local source-built app only.
const {chromium}=require('@playwright/test');
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),crypto=require('crypto');
const R=path.resolve(__dirname,'..'),E=path.join(R,'artifacts/lightning'),prefix='synthetic';
const ORIGIN=process.env.LIGHTNING_TEST_ORIGIN;assert(ORIGIN&&/^http:\/\/127\.0\.0\.1:\d+$/.test(ORIGIN),'Local runner required');const KEY='harbor.lightning.v2';
const {exact,invoice,historical,expiredInvoice,differentInvoice}=require('../tests/lightning-fixture.cjs');
const bolt11=require('bolt11'),decoded=bolt11.decode(invoice);
const pending=structuredClone(exact);pending.status='PENDING';pending.contracts.forEach(c=>c.status='FUNDED');
const report={mode:prefix,origin:ORIGIN,browser:'Headless Chromium desktop/mobile emulation; not native-app evidence',fixture:{source:'generated synthetic fixture; no real order/payment',historicalClock:new Date(historical).toISOString()},tests:[],screenshots:[],pages:[]};
let browser;
async function test(name,fn){try{await fn();report.tests.push({name,passed:true});console.log('PASS',name)}catch(e){report.tests.push({name,passed:false,error:e.stack});console.error('FAIL',name,e.message)}}
async function shot(p,name){const f=`${prefix}-${name}.png`;await p.screenshot({path:path.join(E,f),fullPage:true});report.screenshots.push(f)}
async function makePage(width,{evm=false,synthetic=true,provider=true,mode='held',reply=exact,fixtureWidget=true}={}){
 const context=await browser.newContext({viewport:{width,height:1000},isMobile:width===360,hasTouch:width===360,serviceWorkers:'block'}),p=await context.newPage();
 p.setDefaultTimeout(7000);p.audit={width,synthetic,evm,errors:[],consoleErrors:[],blockedWrites:[],allowedCapabilityPosts:[],blockedReads:[],swapReads:0,assets:[]};report.pages.push(p.audit);
 p.reply=reply;p.failFetch=false;
 p.on('pageerror',e=>p.audit.errors.push(e.message));p.on('console',m=>{if(m.type()==='error')p.audit.consoleErrors.push(m.text())});
 await context.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url()),method=req.method();
  if(!['GET','HEAD','OPTIONS'].includes(method)){
   
   p.audit.blockedWrites.push({method,host:u.hostname,path:u.pathname});return route.abort('blockedbyclient');
  }
  if(u.hostname==='api.go.fastspot.io'){
   assert.equal(method,'GET');assert.equal(u.pathname,'/swap/'+exact.id);p.audit.swapReads++;
   if(p.failFetch)return route.abort('failed');
   return route.fulfill({status:200,contentType:'application/json',headers:{'access-control-allow-origin':'*','cache-control':'no-store'},body:JSON.stringify(p.reply)});
  }
  if(fixtureWidget&&u.hostname==='widget.mtpelerin.com')return route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><body style="font:16px sans-serif;color:#444;padding:24px">Bank iframe network isolated for synthetic browser safety tests. No order or payment is created.</body>'});
  if(u.origin===ORIGIN){
   if(/\.(js|css)$/.test(u.pathname))p.audit.assets.push(u.pathname);
   return route.continue();
  }
  p.audit.blockedReads.push({host:u.hostname,path:u.pathname});return route.abort('blockedbyclient');
 });
 if(synthetic)await p.clock.setFixedTime(new Date(historical));
 await p.addInitScript(({evm,provider,mode,swapId,synthetic})=>{
  if(window!==window.top)return;
  window.__calls=[];window.__evmCalls=[];window.__forbidden=[];window.__mode=mode;
  const deny=method=>{window.__forbidden.push(method);throw Error('Forbidden real wallet method '+method)};
  if(provider)window.nimiq={payLightningInvoice:async args=>{if(!synthetic)return deny('non-synthetic payLightningInvoice');window.__calls.push(args);if(window.__mode==='held')return new Promise((resolve,reject)=>{window.__resolve=resolve;window.__reject=reject});if(window.__mode==='reject')throw Error('Synthetic unknown wallet outcome');return{swapId,hash:'0x'+'11'.repeat(32)}},sign:()=>deny('sign'),sendBasicTransaction:()=>deny('sendBasicTransaction')};
  if(evm){const account='0x1111111111111111111111111111111111111111',listeners={};window.ethereum={isMetaMask:true,on:(e,f)=>{(listeners[e]||=[]).push(f)},removeListener:()=>{},request:async({method})=>{window.__evmCalls.push(method);if(['eth_accounts','eth_requestAccounts'].includes(method))return[account];if(method==='eth_chainId')return'0x89';if(method==='eth_getBalance')return'0x100000000000000000';if(method==='eth_call')return'0x'+'0'.repeat(64);if(method==='eth_blockNumber')return'0x123';if(method==='eth_gasPrice')return'0x1';if(method==='eth_getCode')return'0x';return deny(method)}}}
 },{evm,provider,mode,swapId:exact.id,synthetic});
 await p.goto(ORIGIN+'/',{waitUntil:'domcontentloaded'});
 await p.locator('.header-wallet').waitFor();
 await p.locator('.harbor-lightning').waitFor({state:'attached'});
 return p;
}
async function close(p){assert.deepEqual(p.audit.errors,[],'No browser runtime errors');assert.deepEqual(await p.evaluate(()=>window.__forbidden),[],'No signing, sending or chain changes');await p.context().close()}
async function open(p){await p.locator('.header-wallet .wallet-button').click();await p.getByRole('button',{name:'Pay with wallet',exact:true}).click();await p.getByRole('tab',{name:'Pay Lightning invoice',exact:true}).click();await p.locator('.harbor-lightning').waitFor({state:'visible'})}
const activeFrame='.external-bank .external-bank-widget:not([hidden]) iframe';
async function swapFrame(p){await p.getByRole('tab',{name:'SWAP',exact:true}).click();await p.locator(activeFrame).waitFor();}
const status=p=>p.locator('.harbor-lightning [role=status]');
const pay=p=>p.locator('.hl-pay');
async function calls(p,n){if(n>0)await p.waitForFunction(n=>window.__calls.length>=n,n);assert.equal(await p.evaluate(()=>window.__calls.length),n)}
async function waitStatus(p,text){await p.waitForFunction(t=>document.querySelector('.harbor-lightning [role=status]')?.textContent.includes(t),text)}
async function event(p,message,origin='https://widget.mtpelerin.com',source='iframe'){
 await p.evaluate(({message,origin,source})=>window.dispatchEvent(new MessageEvent('message',{data:message,origin,source:source==='iframe'?document.querySelector('.external-bank .external-bank-widget:not([hidden]) iframe').contentWindow:window})),{message,origin,source});await p.waitForTimeout(60);
}
const order={type:'orderCreated',data:{id:'123456789',expirationDate:new Date(historical+1800000).toISOString(),type:'swap',currencyIn:'sat',valueIn:String(BigInt(decoded.millisatoshis)/1000n),networkIn:'lightning_mainnet',networkOut:'matic_mainnet',lnInvoice:invoice}};
async function recover(p){await p.locator('.hl-recover summary').click();await p.locator('.hl-recover input').fill(exact.id);await p.locator('.hl-recover-button').click()}
async function resolve(p){await p.evaluate(swapId=>window.__resolve({swapId,hash:'0x'+'11'.repeat(32)}),exact.id)}
module.exports={makePage,close,open,status,pay,calls,waitStatus,shot,exact,invoice,pending,report,setBrowser:b=>{browser=b}};
if(require.main===module)(async()=>{fs.mkdirSync(E,{recursive:true});browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});
 try{
 for(const width of [1280,360]){
  await test(`Bank Lightning scope, no notices and SELL capture ${width}`,async()=>{const p=await makePage(width);try{
   await p.getByRole('button',{name:'Bank',exact:true}).click();const frame=p.locator(activeFrame);await frame.waitFor();
   const url=new URL(await frame.getAttribute('src'));
   for(const [key,value] of Object.entries({rfr:'yZkss3Rs',tabs:'sell',snet:'lightning_mainnet',sdc:'EUR',sda:'100',addr:'ln@invoice.pay',_ctkn:'synthetic-test-key'}))assert.equal(url.searchParams.get(key),value,key);
   assert(!/VPN|maintenance|testing notice|SMS notice/i.test(await p.locator('.external-bank').innerText()));
   for(const msg of [JSON.stringify(order),{type:'orderCreated',data:{...order.data,type:'buy'}},{type:'orderCreated',data:{...order.data,id:'not-a-number'}}]){await event(p,msg);assert.equal(await p.locator('.harbor-lightning textarea').inputValue(),'')}
   await event(p,{type:'orderCreated',data:{...order.data,type:'sell',network:'lightning_mainnet'}});assert.equal(await p.locator('.harbor-lightning textarea').inputValue(),invoice);await calls(p,0);
   assert.deepEqual(p.audit.errors,[]);
  }finally{await close(p)}});
  await test(`capture never replaces pasted or pending invoice ${width}`,async()=>{const p=await makePage(width);try{
   await open(p);await p.locator('.harbor-lightning textarea').fill(invoice);await pay(p).click();await calls(p,1);
   assert(await p.getByRole('button',{name:'Close',exact:true}).isDisabled());await resolve(p);await waitStatus(p,'Lightning');
   await p.getByRole('button',{name:'Close',exact:true}).click();await p.getByRole('button',{name:'Bank',exact:true}).click();await swapFrame(p);
   await event(p,{...order,data:{...order.data,lnInvoice:differentInvoice}});assert.equal(await p.locator('.harbor-lightning textarea').inputValue(),invoice);assert.equal(await p.locator('.harbor-lightning').isVisible(),false);await calls(p,1);
  }finally{await close(p)}});
  await test(`connected wallet account menu ${width}`,async()=>{const p=await makePage(width,{evm:true,synthetic:false});try{
   await p.locator('.header-wallet .wallet-button').click();await p.locator('#wallet-account-popover').waitFor({state:'attached'});await p.locator('.header-wallet .wallet-button').click();
   const action=p.locator('#wallet-account-popover .pay-menu-action');await action.waitFor({state:'visible'});assert((await action.innerText()).includes('Pay with wallet'));
   assert.equal(await p.locator('.hl-native').count(),0);const rect=await p.locator('.header-wallet').boundingBox();assert(rect.x+rect.width/2>width/2,'Wallet menu anchored right');
   await shot(p,`connected-menu-${width}`);await action.click();assert.equal(await p.locator('#wallet-account-popover').getAttribute('hidden'),'');await calls(p,0);
   await p.getByRole('button',{name:'Close',exact:true}).click();await p.getByRole('button',{name:/^Bank/}).click();assert.equal(await p.locator('.harbor-lightning').isVisible(),false,'No above-bank Lightning panel');assert.equal(await p.locator('.harbor-lightning').evaluate(e=>e.parentElement?.id==='pay-panel-lightning'),true);await shot(p,`bank-no-panel-${width}`);
   assert.deepEqual(p.audit.errors,[]);
  }finally{await close(p)}});
  await test(`native fallback capture -> submitted -> pending -> exact verified paid; reload blocked ${width}`,async()=>{const p=await makePage(width,{reply:pending});try{
   assert.equal(await p.evaluate(()=>!!window.ethereum),false);assert.equal(await p.locator('.header-wallet .hl-native,.header-wallet .hl-bolt').count(),0);assert.equal(await p.locator('.harbor-lightning').isVisible(),false);await shot(p,`native-header-${width}`);
   await open(p);await shot(p,`native-pay-dialog-${width}`);await p.getByRole('button',{name:'Close',exact:true}).click();await p.getByRole('button',{name:/^Bank/}).click();await swapFrame(p);
   for(const [name,msg,origin,source]of [
    ['wrong origin',order,'https://evil.example','iframe'],['wrong source',order,'https://widget.mtpelerin.com','window'],['wrong network',{...order,data:{...order.data,networkIn:'bitcoin_testnet'}}],['wrong amount',{...order,data:{...order.data,valueIn:'1705'}}],['expired',{...order,data:{...order.data,expirationDate:'2010-01-01T00:00:00Z'}}],['malformed invoice',{...order,data:{...order.data,lnInvoice:'lnbc123wrong'}}]
   ]){await event(p,msg,origin,source);assert.equal(await p.locator('.harbor-lightning textarea').inputValue(),'',name)}
   await event(p,order);assert.equal(await p.locator('.harbor-lightning textarea').inputValue(),invoice);assert((await p.locator('.hl-source').innerText()).includes('Order 123456789'));await calls(p,0);await shot(p,`SYNTHETIC-capture-${width}`);
   await pay(p).click();await calls(p,1);assert(await pay(p).isDisabled());await p.evaluate(()=>document.querySelector('.hl-pay').click());await calls(p,1);await shot(p,`SYNTHETIC-wallet-held-${width}`);
   await resolve(p);await waitStatus(p,'waiting for Lightning settlement');await calls(p,1);assert(!(await status(p).innerText()).includes('Verified paid'));assert.equal(p.audit.swapReads,1);await shot(p,`SYNTHETIC-pending-${width}`);
   p.reply=exact;await p.locator('.hl-check').click();await waitStatus(p,'Verified paid');assert.equal(p.audit.swapReads,2);assert(await pay(p).isDisabled());await calls(p,1);assert.deepEqual(await p.evaluate(()=>window.__calls[0]),{invoice});await shot(p,`SYNTHETIC-verified-paid-${width}`);
   await p.reload();await open(p);await waitStatus(p,'Verified paid');assert(await pay(p).isDisabled());await p.evaluate(()=>document.querySelector('.hl-pay').click());await calls(p,0);assert.equal(p.audit.swapReads,2,'Paid reload does not poll or repay');
   assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(p.audit.errors,[]);
  }finally{await close(p)}});
  await test(`pasted invoice; fetch failure stops automatic checks; manual recovery ${width}`,async()=>{const p=await makePage(width,{mode:'success'});try{
   await open(p);await p.locator('.harbor-lightning textarea').fill('lightning:'+invoice);await p.getByRole('button',{name:'Close',exact:true}).click();await p.getByRole('button',{name:/^Bank/}).click();await swapFrame(p);await event(p,order);assert.equal(await p.locator('.harbor-lightning').isVisible(),false,'Edited invoice is not overwritten or reopened by capture');await open(p);assert((await p.locator('.hl-source').innerText()).includes('Pasted invoice'));p.failFetch=true;await pay(p).click();await waitStatus(p,'Status check unavailable');await calls(p,1);const reads=p.audit.swapReads;await p.waitForTimeout(2300);assert.equal(p.audit.swapReads,reads,'No automatic fetch retry after failure');assert(await pay(p).isDisabled());await shot(p,`SYNTHETIC-fetch-failure-${width}`);
   p.failFetch=false;await p.locator('.hl-check').click();await waitStatus(p,'Verified paid');await calls(p,1);await p.reload();await open(p);assert(await pay(p).isDisabled());await calls(p,0);
  }finally{await close(p)}});
 }
 for(const variant of ['wrong-invoice','wrong-hash','wrong-preimage','wrong-status','wrong-contract-status','wrong-id','wrong-amount','duplicate-lightning-leg']){
  await test(`settlement rejection ${variant}`,async()=>{const tampered=structuredClone(exact),c=tampered.contracts.find(c=>c.asset==='BTC_LN');
   if(variant==='wrong-invoice')c.recipient=JSON.stringify({address:differentInvoice});
   if(variant==='wrong-hash')tampered.hash='00'.repeat(32);
   if(variant==='wrong-preimage')tampered.preimage='00'.repeat(32);
   if(variant==='wrong-status')tampered.status='FAILED';
   if(variant==='wrong-contract-status')c.status='FUNDED';
   if(variant==='wrong-id')tampered.id='00000000-0000-0000-0000-000000000000';
   if(variant==='wrong-amount')c.amount='0.00001703999';
   if(variant==='duplicate-lightning-leg')tampered.contracts.push(structuredClone(c));
   const p=await makePage(360,{reply:tampered});try{await open(p);await p.locator('.harbor-lightning textarea').fill(invoice);await recover(p);await waitStatus(p,'could not be verified');assert(!(await status(p).innerText()).includes('Verified paid'));await calls(p,0);assert.equal(p.audit.swapReads,1);if(variant==='wrong-preimage')await shot(p,'SYNTHETIC-rejected-preimage-360');}finally{await close(p)}});
 }
 await test('unknown wallet outcome retained across reload; no automatic payment retry',async()=>{const p=await makePage(360,{mode:'reject'});try{await open(p);await p.locator('.harbor-lightning textarea').fill(invoice);await pay(p).click();await waitStatus(p,'No automatic retry');await calls(p,1);assert.equal(p.audit.swapReads,0);await p.waitForTimeout(2300);await calls(p,1);await p.reload();await open(p);assert(await pay(p).isDisabled());await calls(p,0);await p.evaluate(()=>document.querySelector('.hl-pay').click());await calls(p,0);await shot(p,'SYNTHETIC-unknown-reload-360');}finally{await close(p)}});
 await test('synthetic manual recovery verifies exact saved swap without payment',async()=>{const p=await makePage(1280,{synthetic:false});try{await open(p);await p.locator('.harbor-lightning textarea').fill(invoice);await recover(p);await waitStatus(p,'Verified paid');await calls(p,0);await shot(p,'synthetic-readonly-recovery-1280');}finally{await close(p)}});
 await test('submitted pending reload blocks repeat wallet payment',async()=>{const p=await makePage(360,{mode:'success',reply:pending});try{await open(p);await p.locator('.harbor-lightning textarea').fill(invoice);await pay(p).click();await waitStatus(p,'waiting for Lightning settlement');await calls(p,1);const response=p.waitForResponse('https://api.go.fastspot.io/swap/'+exact.id);await p.reload();await response;await open(p);await waitStatus(p,'waiting for Lightning settlement');assert(await pay(p).isDisabled());await p.evaluate(()=>document.querySelector('.hl-pay').click());await p.waitForTimeout(100);await calls(p,0);await shot(p,'SYNTHETIC-pending-reload-360');}finally{await close(p)}});
 await test('real-clock malformed, testnet and expired invoice reject before wallet request',async()=>{const p=await makePage(360,{synthetic:false});try{await open(p);for(const [text,expected]of [['lnbc123wrong','Invalid Lightning invoice'],['lntb123wrong','mainnet'],[expiredInvoice,'expired']]){await p.locator('.harbor-lightning textarea').fill(text);await pay(p).click();await waitStatus(p,expected);await calls(p,0);}assert.equal(p.audit.swapReads,0)}finally{await close(p)}});
 await test('no Lightning provider fails closed without Polygon',async()=>{const p=await makePage(360,{provider:false});try{await open(p);await p.locator('.harbor-lightning textarea').fill(invoice);await pay(p).click();await waitStatus(p,'Open Harbor inside Nimiq Pay');await calls(p,0);assert.equal(p.audit.swapReads,0);}finally{await close(p)}});
 }finally{await browser.close();report.passed=report.tests.filter(t=>t.passed).length;report.failed=report.tests.length-report.passed;fs.writeFileSync(path.join(E,`${prefix}-tests.json`),JSON.stringify(report,null,2));console.log(JSON.stringify({mode:prefix,passed:report.passed,failed:report.failed,report:path.join(E,`${prefix}-tests.json`),screenshots:report.screenshots.length}));if(report.failed)process.exitCode=1}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
