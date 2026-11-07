// Saved recovery and exact disclosure only: never click Approve/Revoke/Swap.
const {chromium}=require('@playwright/test');
const {toFunctionSelector}=require('viem');
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const R=path.resolve(__dirname,'..'),E=path.join(R,'artifacts/ui');fs.mkdirSync(E,{recursive:true});
const origin='https://harbor.example',key='harbor:fusion:approval:v1',account='0x1111111111111111111111111111111111111111',tokenIn='0xc2132d05d31c914a87c6611c10748aeb04b58e8f',tokenOut='0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',id='33333333-3333-4333-8333-333333333333',hash='0x'+'ab'.repeat(32),blockHash='0x'+'cd'.repeat(32);
(async()=>{const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{}),args:['--no-sandbox']});const results=[];
try{for(const width of [1280,360])for(const scenario of ['review','saved','reset-pending','wrong-account','expired']){
 const context=await browser.newContext({viewport:{width,height:950},isMobile:width===360,hasTouch:width===360,serviceWorkers:'block'});await context.routeWebSocket('**/*',socket=>socket.close());const page=await context.newPage();const calls=[],posts=[],errors=[];page.on('pageerror',e=>errors.push(e.message));
 const now=Date.now(),deadline=Math.floor(now/1000)+900;
 const request={chainId:137,account,tokenIn,tokenOut,amount:'1123456',slippageBps:50};
 const prepared={authorization:'onchain-approval',account,clientRequestId:'44444444-4444-4444-8444-444444444444',id,request,createdAt:now,deadlineMinutes:15,orderDeadline:deadline,minimumPolicy:'sdk-executable-v1',previewId:'55555555-5555-4555-8555-555555555555',previewMinimumReceiveAmount:'995000',expiresAt:deadline*1000,permit:{nonce:'0',deadline},state:'prepared',settlementVerified:false,orderHash:null,minimumReceiveAmount:null,deadline:null,providerStatus:null,transactionHash:null};
 const saved={version:1,account,clientRequestId:prepared.clientRequestId,id,prepared,phase:scenario==='expired'?'expired':'approval-pending',requested:true,transactionHash:hash,updatedAt:now,...(scenario==='reset-pending'?{resetRequested:true,resetHash:hash}:{})};
 const connected=scenario==='wrong-account'?'0x2222222222222222222222222222222222222222':account;
 await page.exposeFunction('walletCall',async(method)=>{calls.push(method);if(['eth_accounts','eth_requestAccounts'].includes(method))return [connected];if(method==='eth_chainId')return '0x89';throw Error('FORBIDDEN wallet '+method);});
 await page.addInitScript(({saved,key,scenario})=>{if(scenario!=='review'&&!localStorage.getItem(key))localStorage.setItem(key,JSON.stringify(saved));window.ethereum={request:({method,params})=>window.walletCall(method,params),on(){},removeListener(){}};},{saved,key,scenario});
 await page.route('**/*',async route=>{
  const req=route.request(),u=new URL(req.url());
  if(u.origin===origin){
   if(u.pathname.startsWith('/api/')){
    if(req.method()==='POST')posts.push(u.pathname);
    if(u.pathname.endsWith('/status'))return route.fulfill({json:{configured:true,available:true,executionEnabled:true,chainId:137,mode:'gasless-execution',permitSupport:'native-eip2612',zeroAllowanceGasless:true,signingPayload:null}});
    if(u.pathname.endsWith('/session'))return route.fulfill({json:{csrfToken:'f'.repeat(43)}});
    if(u.pathname.endsWith('/quotes')){const {clientRequestId,autoSlippage,...request}=req.postDataJSON();request.slippageBps=autoSlippage?50:request.slippageBps;return route.fulfill({json:{executionEnabled:false,chainId:137,mode:'unsigned-preview',gaslessSettlement:'resolver-paid-if-filled',allowance:'unknown-readiness-not-verified',permitSupport:'unverified-disabled',zeroAllowanceGasless:false,signingPayload:null,id:prepared.previewId,request,...(autoSlippage?{autoSlippage:true}:{}),expiresAt:Date.now()+30000,state:'quoted-preview',settlementVerified:false,build:null,quote:{preset:'fast',tokenFee:'0',bankFee:'0',providerFeeBps:0,expectedAmount:'1000000',minimumReceiveAmount:'995000',auctionStartAmount:'1100000',auctionEndAmount:'990000',auctionDuration:180}}});}
    if(u.pathname.endsWith('/prepare')&&scenario==='review'){const body=req.postDataJSON();assert.equal(body.deadlineMinutes,15);assert.equal(body.amount,'1123456');Object.assign(prepared,{request:{chainId:137,account:body.account,tokenIn:body.tokenIn,tokenOut:body.tokenOut,amount:body.amount,slippageBps:body.slippageBps},clientRequestId:body.clientRequestId,previewId:body.previewId,previewMinimumReceiveAmount:body.minimumReceiveAmount,minimumPolicy:body.minimumPolicy});return route.fulfill({json:prepared});}
    errors.push('Forbidden API '+req.method()+':'+u.pathname);return route.abort();
   }
   const f=path.join(R,'dist',u.pathname==='/'?'index.html':u.pathname);if(fs.existsSync(f)&&fs.statSync(f).isFile())return route.fulfill({path:f});return route.abort();
  }
  if(req.method()!=='POST'){return route.abort();}
  let raw;try{raw=req.postDataJSON();}catch{return route.abort();}
  function rpc(r){let result;if(r.method==='eth_chainId')result='0x89';else if(r.method==='eth_blockNumber')result='0x64';else if(r.method==='eth_getBlockByNumber')result={number:'0x64',hash:blockHash,parentHash:blockHash,timestamp:'0x'+Math.floor(Date.now()/1000).toString(16),baseFeePerGas:'0x64',transactions:[],gasLimit:'0x1c9c380',gasUsed:'0x0',size:'0x1',difficulty:'0x0',extraData:'0x'};else if(r.method==='eth_getBalance')result='0xde0b6b3a7640000';else if(r.method==='eth_estimateGas')result='0xc350';else if(['eth_maxPriorityFeePerGas','eth_gasPrice'].includes(r.method))result='0x64';else if(r.method==='eth_call'){const data=r.params[0].data;result='0x'+(data.startsWith(toFunctionSelector('allowance(address,address)'))?0n:10n**24n).toString(16).padStart(64,'0');}else throw Error('Forbidden RPC '+r.method);return {id:r.id,jsonrpc:'2.0',result};}
  try{return route.fulfill({json:Array.isArray(raw)?raw.map(rpc):rpc(raw)});}catch(e){errors.push(e.message);return route.abort();}
 });
 await page.goto(origin,{waitUntil:'networkidle'});await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 if(scenario==='review'){
  await page.getByLabel('You pay').fill('1.123456');const review=page.getByRole('button',{name:'Review',exact:true});await review.waitFor();await page.waitForFunction(()=>[...document.querySelectorAll('button')].some(b=>b.textContent==='Review'&&!b.disabled));await review.click();
  const section=page.getByRole('region',{name:'Exact USDT0 approval review'});await section.waitFor();assert.match(await section.innerText(),/Approve exactly 1\.123456 USDT0 — not unlimited/);assert.match(await section.innerText(),/Revoking it needs a separate transaction paid in POL/);assert(await section.getByRole('button',{name:'Approve exact USDT0',exact:true}).isEnabled());assert.equal(posts.filter(x=>x.endsWith('/prepare')).length,1);assert.equal(posts.filter(x=>!x.endsWith('/quotes')&&!x.endsWith('/prepare')).length,0);
 }else{
  const section=page.getByRole('region',{name:'USDT0 approval recovery'});await section.waitFor();assert.match(await section.innerText(),/Requested limit: 1\.123456 USDT0/);assert.match(await section.innerText(),/not unlimited spending/);
  const revoke=section.getByRole('button',{name:'Revoke USDT0 approval · requires POL',exact:true});
  if(scenario==='expired'){assert.equal(await revoke.count(),0);assert.equal(await section.locator('.approval-residual-notice').count(),0);}else{assert.match(await section.innerText(),/Order expiry does not revoke it/);assert.equal(await revoke.isDisabled(),scenario==='reset-pending'||scenario==='wrong-account');assert.match(await section.innerText(),/does not cancel a published order/);}
  if(scenario==='reset-pending')assert.match(await section.innerText(),/Revocation requested — not yet verified/);
  const before=await page.evaluate(k=>localStorage.getItem(k),key);await page.reload({waitUntil:'networkidle'});assert.equal(await page.evaluate(k=>localStorage.getItem(k),key),before);assert.equal(posts.length,0);const reconnect=page.getByRole('button',{name:'Connect wallet',exact:true});if(await reconnect.isVisible())await reconnect.click();
 }
 assert.equal(calls.filter(x=>!['eth_accounts','eth_requestAccounts','eth_chainId'].includes(x)).length,0);assert.deepEqual(errors,[]);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:path.join(E,`regression-${scenario}-${width}.png`),fullPage:true});results.push({width,scenario,noFinancialWalletCalls:true,noRealTransactions:true,mutationFreeRecovery:scenario!=='review',overflow:false,passed:true});await context.close();
 }
}finally{await browser.close();}
fs.writeFileSync(path.join(E,'approval-regression-tests.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));})().catch(e=>{console.error(e);process.exit(1)});
