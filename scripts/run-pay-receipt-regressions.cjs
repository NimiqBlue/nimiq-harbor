const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const origin = 'https://harbor.nimiq.fyi';
const dist = process.env.PAY_TEST_DIST || path.join(__dirname, '../dist');
const from = '0x' + '11'.repeat(20), to = '0x' + '22'.repeat(20), hash = '0x' + 'ab'.repeat(32), blockHash = '0x'+'cd'.repeat(32);
const word = s => '0x'+s.slice(2).padStart(64,'0');
const token = '0xc2132D05D31c914a87C6611C10748AEb04B58e8F';
const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

(async()=>{
 const browser=await chromium.launch({executablePath:process.env.PAY_TEST_CHROMIUM||undefined});
 try{
  for(const [width,scenario] of [[320,'pending to confirmed'],[390,'native Polygon'],[1280,'native Ethereum'],[390,'reverted'],[390,'wrong amount'],[1280,'RPC unavailable then confirmed']]){
   const page=await browser.newPage({viewport:{width,height:850}});
   const native=scenario.startsWith('native'), eth=scenario==='native Ethereum';
   let mode=scenario==='pending to confirmed'?'pending':scenario==='RPC unavailable then confirmed'?'error':scenario;
   const calls=[], errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   try{
    await page.route('**/*',async route=>{
     const url=new URL(route.request().url());
     if(url.origin===origin){
      if(url.pathname.startsWith('/api/'))return route.fulfill({status:503,contentType:'application/json',body:'{}'});
      if(process.env.PAY_TEST_LIVE==='1')return route.continue();
      const file=path.join(dist,url.pathname==='/'?'index.html':url.pathname);
      return fs.existsSync(file)&&fs.statSync(file).isFile()?route.fulfill({path:file,headers:process.env.PAY_TEST_CSP?{'Content-Security-Policy':process.env.PAY_TEST_CSP}:{}}):route.abort();
     }
     if(!['polygon.drpc.org','eth.drpc.org'].includes(url.hostname)||route.request().method()!=='POST')return route.abort();
     const q=route.request().postDataJSON();calls.push([url.hostname,q]);
     let result;
     switch(q.method){
      case 'eth_chainId': result=url.hostname==='eth.drpc.org'?'0x1':'0x89';break;
      case 'eth_getBalance':case 'eth_call':result='0x'+(10n**22n).toString(16);break;
      case 'eth_gasPrice':result='0x3b9aca00';break;
      case 'eth_estimateGas':result='0x5208';break;
      case 'eth_getTransactionReceipt':
       assert.deepEqual(q.params,[hash]);
       if(mode==='error')return route.fulfill({status:503,body:''});
       result=mode==='pending'?null:{transactionHash:hash,blockHash,from,to:native?to:token,status:mode==='reverted'?'0x0':'0x1',logs:native?[]:[{address:token,transactionHash:hash,blockHash,removed:false,topics:[topic,word(from),word(to)],data:word(mode==='wrong amount'?'0xf4241':'0xf4240')}]};break;
      case 'eth_getTransactionByHash':
       assert.deepEqual(q.params,[hash]);result={hash,blockHash,from,to,input:'0x',value:'0xde0b6b3a7640000'};break;
      default: throw Error('Unexpected network method: '+q.method);
     }
     return route.fulfill({json:{jsonrpc:'2.0',id:q.id,result}});
    });
    await page.addInitScript(({from,hash})=>{
     window.mockSends=0;let chain='0x89';
     window.ethereum={isMetaMask:true,on(){},removeListener(){},async request(q){
      if(['eth_accounts','eth_requestAccounts'].includes(q.method))return [from];
      if(q.method==='eth_chainId')return chain;
      if(q.method==='wallet_switchEthereumChain'){chain=q.params[0].chainId;return null;}
      if(q.method==='eth_sendTransaction'){window.mockSends++;return hash;}
      throw Error('Unexpected wallet method: '+q.method);
     }};
    },{from,hash});
    await page.goto(origin);
    await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.wallet-button')?.textContent.includes('0x'));
    await page.locator('.wallet-button').click();
    await page.getByRole('button',{name:'Pay with wallet',exact:true}).click();
    const dialog=page.getByRole('dialog',{name:'Pay with wallet',exact:true});
    if(native)await dialog.getByRole('button',{name:eth?'Ethereum':'POL',exact:true}).click();
    if(eth)await dialog.getByRole('button',{name:'Switch wallet to Ethereum'}).click();
    await dialog.getByLabel('Recipient address').fill(to);
    await dialog.getByLabel('Exact amount').fill('1');
    await dialog.getByRole('button',{name:'Review transfer',exact:true}).click();
    await dialog.getByRole('button',{name:'Confirm and open wallet',exact:true}).click();
    const card=dialog.getByRole('region',{name:'Transfer status'});
    const heading=(title)=>card.getByRole('heading',{name:title,exact:true}).waitFor({timeout:10500});
    if(mode==='pending'){
     await heading('Transfer submitted');
     assert.equal(await card.getByRole('button',{name:'New transfer'}).count(),0);
     mode='confirmed';
    }
    if(mode==='error'){
     await heading('Confirmation not verified');mode='confirmed';
     await card.getByRole('button',{name:'Check status again'}).click();
    }
    await heading(mode==='reverted'?'Transfer failed':mode==='wrong amount'?'Confirmation not verified':'Transfer confirmed');
    assert.equal(await dialog.getByRole('button',{name:'Review transfer'}).count(),0);
    assert.equal(await card.locator('.pay-transfer-amount').innerText(),`1 ${eth?'ETH':native?'POL':'USDT0'}`);
    assert.equal(await card.locator('code').innerText(),to);
    assert.equal(await card.getByRole('link').getAttribute('href'),`https://${eth?'etherscan.io':'polygonscan.com'}/tx/${hash}`);
    assert(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
    assert(calls.filter(([,q])=>q.method.startsWith('eth_getTransaction')).every(([host])=>host===(eth?'eth.drpc.org':'polygon.drpc.org')));
    if(mode==='confirmed'&&width===320){
     await dialog.getByRole('tab',{name:'Pay Lightning invoice'}).click();
     await dialog.getByRole('tab',{name:'Send tokens'}).click();await heading('Transfer confirmed');
     if(process.env.PAY_TEST_SCREENSHOT)await page.screenshot({path:process.env.PAY_TEST_SCREENSHOT});
     await card.getByRole('button',{name:'New transfer'}).click();
     assert.equal(await dialog.getByLabel('Exact amount').inputValue(),'');
     assert.equal(await dialog.getByLabel('Recipient address').inputValue(),'');
    }
    assert.equal(await page.evaluate(()=>window.mockSends),1);
    assert.deepEqual(errors,[]);
    console.log(`PASS ${width}px ${scenario}`);
   }finally{await page.close();}
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
