// CURRENT-source audit. Inert invalid signature bytes + mocked recovery only.
// Run with Node 24 --experimental-test-module-mocks --import tsx --test.
// Network is forbidden at runtime and by the enclosing --network none container.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as viem from 'viem';
import { fixture, request } from './fusion-fixture.js';
import { ALLOWLIST, DIRECTIONS, TOKENS, assertDirection, registeredToken } from '../src/swap/registry.js';
import { quoteRequest } from '../src/fusion/policy.js';

const account=request.account.toLowerCase() as `0x${string}`;
const inert=`0x${'11'.repeat(32)}${'22'.repeat(32)}1b` as const;
let recoveryCalls=0;
mock.module('viem',{namedExports:{...viem,recoverTypedDataAddress:async()=>{recoveryCalls++;return account;}}});
globalThis.fetch=async()=>{throw new Error('Forbidden global network access');};
const { createApp }=await import('../src/server/index.js');
const browser=await import('../src/web/fusion-execution.ts');
const { fusionNetFloor }=await import('../src/shared/fusion-net-output.ts');
const { fusionPermitTokens, prepareFusionPermit }=await import('../src/fusion/permit-preparation.js');
const { diagnosticPermit, permitDefinitions }=await import('../src/web/permit-diagnostic.js');

test('registry and Fusion policy permit only the two canonical stablecoin directions',()=>{
 assert.deepEqual(Object.keys(TOKENS),['USDC','USDT','frxUSD','WPOL']);
 assert.deepEqual(ALLOWLIST,Object.values(TOKENS));
 assert.deepEqual(DIRECTIONS,[[TOKENS.USDC,TOKENS.USDT],[TOKENS.USDT,TOKENS.USDC]]);
 for(const tokenIn of ALLOWLIST)for(const tokenOut of ALLOWLIST){
  const supported: boolean=DIRECTIONS.some(([a,b])=>a===tokenIn && b===tokenOut);
  assert.equal(quoteRequest.safeParse({...request,tokenIn:tokenIn.address,tokenOut:tokenOut.address}).success,supported);
  if(supported)assert.doesNotThrow(()=>assertDirection(tokenIn,tokenOut));
  else assert.throws(()=>assertDirection(tokenIn,tokenOut),/Unsupported swap direction/);
 }
 const unknown='0x3333333333333333333333333333333333333333';
 assert.throws(()=>registeredToken(unknown),/not allowlisted/);
 for(const field of ['tokenIn','tokenOut'])assert.equal(quoteRequest.safeParse({...request,[field]:unknown}).success,false);
 for(const amount of ['0','15000000001'])assert.equal(quoteRequest.safeParse({...request,amount}).success,false);
 assert.equal(quoteRequest.safeParse({...request,amount:'15000000000'}).success,true);
});

test('server and browser retain exact canonical USDC and USDT0 permit domains only',()=>{
 assert.deepEqual(Object.keys(fusionPermitTokens),['USDC','USDT0']);
 assert.deepEqual(Object.keys(permitDefinitions),['USDC','USDT0']);
 const expected={
  USDC:{name:'USD Coin',version:'2',verifyingContract:TOKENS.USDC.address,chainId:137},
  USDT0:{name:'USDT0',version:'1',verifyingContract:TOKENS.USDT.address,salt:viem.toHex(137n,{size:32})},
 };
 const now=1800000000;
 for(const key of ['USDC','USDT0'] as const){
  const token=fusionPermitTokens[key];
  const data=diagnosticPermit(key,account,0n);
  assert.deepEqual(data.domain,expected[key]);
  assert.equal(token.address,permitDefinitions[key].address.toLowerCase());
  const domainSeparator=viem.hashDomain<viem.TypedData>({domain:data.domain,types:data.types});
  const state={chainId:137,account,token:token.address,nonce:'0',domainSeparator,blockNumber:'123',blockHash:`0x${'ab'.repeat(32)}`,recheckedBlockHash:`0x${'ab'.repeat(32)}`,blockTimestamp:now-1};
  const input={chainId:137,account,token:token.address,value:'1000000',deadline:now+900};
  const permit=prepareFusionPermit(input,state,now);
  assert.equal(viem.hashDomain({domain:permit.typedData.domain,types:permit.typedData.types}),domainSeparator);
  assert.equal(permit.typedData.domain.verifyingContract,token.address);
  const unknown='0x3333333333333333333333333333333333333333';
  assert.throws(()=>prepareFusionPermit({...input,token:unknown},{...state,token:unknown},now),/Unsupported permit token/);
 }
 assert.throws(()=>diagnosticPermit('unsupported' as Parameters<typeof diagnosticPermit>[0],account,0n),/Invalid diagnostic token/);
});

async function harness(publicationTimeout=false,approval=false) {
 const dir=mkdtempSync(join(tmpdir(),'current-swap-audit-'));
 const now=Date.now(),req={...request,account,...(approval ? {tokenIn:TOKENS.USDT.address.toLowerCase() as `0x${string}`,tokenOut:TOKENS.USDC.address.toLowerCase() as `0x${string}`} : {})};let posts=0,quotes=0,provider:unknown,receiptShort=false;
 const domain={name:'USD Coin',version:'2',chainId:137,verifyingContract:req.tokenIn as `0x${string}`};
 const snapshot={chainId:137 as const,account,token:req.tokenIn,nonce:'0',domainSeparator:viem.hashDomain<viem.TypedData>({domain,types:{EIP712Domain:viem.getTypesForEIP712Domain({domain})}}),blockNumber:'123',blockHash:`0x${'ab'.repeat(32)}` as const,recheckedBlockHash:`0x${'ab'.repeat(32)}` as const,blockTimestamp:Math.floor(now/1000)-1};
 const app=createApp({env:{APP_ORIGIN:'https://harbor.example',ONEINCH_API_KEY:'synthetic',TOKEN_ENCRYPTION_KEY:randomBytes(32).toString('base64'),FUSION_EXECUTION_ENABLED:'true',POLYGON_RPC_URL:'https://rpc.example.invalid'},dbPath:join(dir,'audit.sqlite'),now:()=>now,executionChain:{snapshot:async()=>snapshot,verifyApproval:async()=>{},expiredUnused:async()=>false,verify:async(r,tx)=>({transactionHash:tx,blockHash:snapshot.blockHash,blockNumber:'124',spent:r.request.amount,received:String(BigInt(r.built!.minimumReceiveAmount)-(receiptShort?1n:0n))})},fetch:async(url,options)=>{
  if(options?.method==='POST'){posts++;assert.match(String(url),/\/relayer\/v2\.0\/137\/order\/submit$/);if(publicationTimeout)throw new Error('Synthetic publication timeout');return new Response(null,{status:201});}
  if(String(url).includes('/status/'))return Response.json(provider);
  quotes++;const raw=fixture();raw.source='synthetic-current-source-audit';return Response.json(raw);
 }});
 async function session(){const s=await app.inject('/api/fusion/session'),cookie=s.headers['set-cookie']!.toString().split(';')[0]!;return {cookie,origin:'https://harbor.example','x-csrf-token':s.json().csrfToken};}
 const headers=await session();
 async function post(url:string,payload:unknown,h=headers){const r=await app.inject({method:'POST',url,headers:{...h,'content-type':'application/json'},payload:JSON.stringify(payload)});return r;}
 const q=await post('/api/fusion/quotes',{...req,clientRequestId:randomUUID()});assert.equal(q.statusCode,200);
 const body={...req,clientRequestId:randomUUID(),previewId:q.json().id,minimumReceiveAmount:q.json().quote.minimumReceiveAmount,minimumPolicy:'sdk-executable-v1'};
 return {app,now,req,headers,body,post,session,get posts(){return posts;},get quotes(){return quotes;},set provider(v:unknown){provider=v;},set receiptShort(v:boolean){receiptShort=v;},async close(){await app.close();rmSync(dir,{recursive:true,force:true});}};
}

test('current parsers accept active HTTP preparation; fixed 15-minute default/explicit request; strict negative and legacy cases',async()=>{
 const h=await harness();try{
  for(const deadlineMinutes of [1,10,14,16,60]){assert.throws(()=>browser.executionApi.prepare(h.req,h.body.clientRequestId,deadlineMinutes));assert.equal((await h.post('/api/fusion/execution/prepare',{...h.body,deadlineMinutes})).statusCode,400);}
  const r=await h.post('/api/fusion/execution/prepare',h.body);assert.equal(r.statusCode,200);
  const p=browser.validatePrepared(r.json(),h.req,h.now,15);assert.equal(p.deadlineMinutes,15);assert.equal(p.orderDeadline,Math.floor(h.now/1000)+900);assert.equal(p.permit.deadline,p.orderDeadline);assert.equal(p.expiresAt,p.orderDeadline!*1000);
  const repeat=await h.post('/api/fusion/execution/prepare',{...h.body,deadlineMinutes:15});assert.equal(repeat.statusCode,200);assert.equal(repeat.json().id,p.id);
  for(const mutate of [{orderDeadline:p.orderDeadline!+1},{permit:{...p.permit,deadline:p.permit.deadline+1}},{typedData:{}},{signature:inert},{request:{...h.req,amount:'1'}}])assert.throws(()=>browser.validatePrepared({...r.json<Record<string,unknown>>(),...mutate},h.req,h.now,15));
  const old={...r.json<Record<string,unknown>>(),deadlineMinutes:10,orderDeadline:Math.floor(h.now/1000)+600,expiresAt:(Math.floor(h.now/1000)+600)*1000,permit:{...p.permit,deadline:Math.floor(h.now/1000)+600}};
  assert.equal(browser.validatePrepared(old,h.req,h.now).orderDeadline,old.orderDeadline);assert.throws(()=>browser.validatePrepared(old,h.req,h.now,15));assert.equal(h.posts,0);
 }finally{await h.close();}
});

for(const timeout of [false,true])test(`active SDK build -> browser final review -> explicit submit -> ownership recovery -> reconcile (publication timeout=${timeout})`,async()=>{
 const h=await harness(timeout);try{
  const r=await h.post('/api/fusion/execution/prepare',h.body);assert.equal(r.statusCode,200);
  const p=browser.validatePrepared(r.json(),h.req,h.now,15);
  const build=await h.post(`/api/fusion/execution/${p.id}/build`,{permitSignature:inert});assert.equal(build.statusCode,200);
  const b=browser.validateBuilt(build.json(),p,browser.encodeExecutionPermit(p,inert),BigInt(h.body.minimumReceiveAmount),h.now);
  assert.equal(b.built.deadline,p.orderDeadline);assert.equal(h.posts,0,'build must not publish');
  const legacyPrepared={...p,confirmedMinimumReceiveAmount:String(b.minimum+1n)};
  const legacyBuilt={...b.built,confirmedMinimumReceiveAmount:String(b.minimum+1n)};
  delete legacyPrepared.minimumPolicy;delete legacyPrepared.previewMinimumReceiveAmount;delete legacyBuilt.minimumPolicy;delete legacyBuilt.previewMinimumReceiveAmount;
  assert.throws(()=>browser.validateBuilt(legacyBuilt,legacyPrepared,browser.encodeExecutionPermit(p,inert),b.minimum+1n,h.now),/Unsafe SDK order/,'legacy reviewed floor cannot be lowered');
  for(const change of [{request:{...h.req,amount:'1'}},{minimumReceiveAmount:String(b.minimum+1n)},{order:{...b.built.order,receiver:'0x2222222222222222222222222222222222222222'}},{typedData:{}}])assert.throws(()=>browser.validateBuilt({...build.json<Record<string,unknown>>(),...change},p,browser.encodeExecutionPermit(p,inert),0n,h.now));
  const journal={version:1 as const,id:p.id,account,clientRequestId:h.body.clientRequestId,orderHash:b.built.orderHash,state:'built' as const,updatedAt:h.now};
  const status=await h.app.inject({url:`/api/fusion/execution/${p.id}`,headers:{cookie:h.headers.cookie}});assert.equal(browser.validateExecutionStatus(status.json(),journal).state,'built');
  for(let n=0;n<2;n++){const submit=await h.post(`/api/fusion/execution/${p.id}/submit`,{orderSignature:inert});assert.equal(submit.statusCode,200);assert.equal(submit.json().orderHash,b.built.orderHash);}
  assert.equal(h.posts,1,'no repeat publication after success or timeout');
  const fresh=await h.session();
  const c=await h.post('/api/fusion/execution/ownership/challenge',{account},fresh);assert.equal(c.statusCode,200);
  const challenge=browser.validateRecoveryChallenge(c.json(),account,'https://harbor.example',h.now);
  const recover=await h.post('/api/fusion/execution/ownership/recover',{challengeId:challenge.challengeId,signature:inert},fresh);assert.equal(recover.statusCode,200);
  const recovered=browser.recoveredExecutionsSchema.parse(recover.json());assert.equal(recovered.executions.length,1);
  const s=browser.validateOwnershipRecoveryStatus(recovered.executions[0],journal);assert.equal(s.orderHash,b.built.orderHash);assert.equal(s.minimumReceiveAmount,b.minimum.toString());assert.equal(s.orderDeadline,p.orderDeadline);
  const tx:viem.Hex=`0x${'cd'.repeat(32)}`;const fill={txHash:tx,filledMakerAmount:h.req.amount,filledAuctionTakerAmount:String(b.minimum-1n),takerFeeAmount:'0'};
  h.provider={orderHash:b.built.orderHash,maker:account,status:'filled',order:b.built.order,extension:b.built.extension,fills:[fill]};
  let result=await h.post(`/api/fusion/execution/${p.id}/reconcile`,{},fresh);assert.equal(result.statusCode,200);assert.equal(result.json().settlementVerified,false,'one-unit-short provider evidence cannot settle');
  h.provider={orderHash:b.built.orderHash,maker:account,status:'filled',order:b.built.order,extension:b.built.extension,fills:[{...fill,filledAuctionTakerAmount:b.minimum.toString()}]};h.receiptShort=true;
  result=await h.post(`/api/fusion/execution/${p.id}/reconcile`,{},fresh);assert.equal(result.json().settlementVerified,false,'one-unit-short receipt cannot settle');
  h.receiptShort=false;result=await h.post(`/api/fusion/execution/${p.id}/reconcile`,{},fresh);assert.equal(result.statusCode,200);
  const final=browser.validateExecutionStatus(result.json(),{...journal,clientRequestId:s.clientRequestId!});assert.equal(final.state,'filled');assert.equal(final.settlementVerified,true);assert.equal(final.transactionHash,tx);assert.equal(h.posts,1);assert.ok(recoveryCalls>0);
 }finally{await h.close();}
});

test('existing USDT0 approval preparation/build/status matches current browser; permit signing remains forbidden',async()=>{
 const h=await harness(false,true);try {
  const r=await h.post('/api/fusion/execution/prepare',h.body);assert.equal(r.statusCode,200);
  assert.throws(()=>browser.validatePrepared(r.json(),h.req,h.now,15));
  const p=browser.validatePrepared(r.json(),h.req,h.now,15,true);assert.equal(p.authorization,'onchain-approval');assert.throws(()=>browser.executionPermit(p));
  const pending=await h.post(`/api/fusion/execution/${p.id}/approval/request`,{});assert.equal(pending.statusCode,200);assert.equal(browser.executionStatusSchema.parse(pending.json()).state,'approval-pending');
  const tx:viem.Hex=`0x${'ef'.repeat(32)}`;
  const confirmed=await h.post(`/api/fusion/execution/${p.id}/approval/confirm`,{transactionHash:tx});assert.equal(confirmed.statusCode,200);const status=browser.executionStatusSchema.parse(confirmed.json());assert.equal(status.state,'approval-confirmed');assert.equal(status.approvalTransactionHash,tx);
  const build=await h.post(`/api/fusion/execution/${p.id}/approval/build`,{});assert.equal(build.statusCode,200);
  const checked=browser.validateBuilt(build.json(),{...p,approvalTransactionHash:tx},'0x',BigInt(h.body.minimumReceiveAmount),h.now);assert.equal(checked.built.deadline,p.orderDeadline);assert.ok(checked.minimum>0n);
  assert.equal(h.posts,0,'mock approval/build must not publish or send a transaction');
 }finally{await h.close();}
});

test('current shared economics rejects invalid resolver fee metadata without reducing recipient floor',()=>{
 assert.equal(fusionNetFloor('1000000',50,'10','20',100),994970n);
 for(const fee of [-1,1001,NaN,1.5])assert.throws(()=>fusionNetFloor('1000000',50,'10','20',fee));
});
