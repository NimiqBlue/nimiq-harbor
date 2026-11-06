import { Address, Quote, QuoterRequest, type QuoterResponse, type PresetEnum } from '@1inch/fusion-sdk';
import { retainBuildEvidence, schemaShapes } from './build-evidence.js';
import { z } from 'zod';
import { isAddress } from 'viem';
import { AppError } from '../server/config.js';
import { FUSION_BASE, SETTLEMENT, SPENDER, positive, uint, evmAddress, quoteRequest, type QuoteRequest } from './policy.js';
import { MAX_AUTO_SLIPPAGE_BPS, providerAutoSlippageBps } from '../shared/auto-slippage.js';
import { fusionNetFloor } from '../shared/fusion-net-output.js';
import { withExactOrderDeadline } from './order-deadline.js';
import { retainProviderRead, retainQuoteFailure, withinProviderDeadline, type QuotePhase, type ProviderReadEvidence } from './read-evidence.js';
import { publicationDiagnostic } from '../server/fusion-publication-diagnostics.js';
import type { ProtectedPublicationResponse } from '../server/fusion-publication-evidence.js';

const bounded = z.number().int().min(0).max(16_777_215);
const preset = z.object({
  auctionDuration: z.number().int().min(1).max(3600), startAuctionIn: z.number().int().min(0).max(120),
  bankFee: uint, initialRateBump: bounded, auctionStartAmount: positive, auctionEndAmount: positive,
  tokenFee: uint, points: z.array(z.object({delay: bounded, coefficient: bounded})).max(32),
  allowPartialFills: z.boolean(), allowMultipleFills: z.boolean(), exclusiveResolver: evmAddress.nullable(),
  gasCost: z.object({gasBumpEstimate: bounded, gasPriceEstimate: uint.pipe(z.string().refine(v => BigInt(v) <= 0xffffffffn))}),
});
const cost = z.object({usd:z.object({fromToken:z.string().max(100),toToken:z.string().max(100)})});
export const quoteResponse = z.object({
  fromTokenAmount: positive, toTokenAmount: positive, marketAmount: positive,
  recommended_preset: z.enum(['fast','medium','slow']),
  presets: z.object({fast:preset,medium:preset,slow:preset}),
  prices:cost, volume:cost, settlementAddress:evmAddress.refine(v=>v===SETTLEMENT),
  // Current indicative responses include zero resolver placeholders. Never use
  // them to relax token, receiver, settlement or spender validation.
  whitelist:z.array(z.string().refine(v=>isAddress(v,{strict:false})).transform(v=>v.toLowerCase())).min(1).max(100), quoteId:z.string().min(1).max(200).nullable(),
  autoK:z.number().finite().min(0).max(100),
  fee:z.object({receiver:evmAddress,bps:z.number().int().min(0).max(1000),whitelistDiscountPercent:z.number().min(0).max(100)}),
  surplusFee:z.number().min(0).max(100).optional(), integratorFee:z.literal(0), integratorFeeShare:z.literal(0),
  // Exact provider-resolved tracking string; SDK 2.4.16 injects it into salt.
  // Do not normalize, default, or forward arbitrary provider metadata.
  source:z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/).optional(),
});
export type RawQuote = z.infer<typeof quoteResponse>;
export type Fetch = typeof fetch;
export class FusionAdapter {
  constructor(private readonly apiKey: string, private readonly fetcher: Fetch = fetch) {}
  configured() { if (!this.apiKey) throw new AppError(503,'FUSION_UNAVAILABLE','Fusion read-only quotes require a server API key.'); }
  private async read(path: string, query?: URLSearchParams, observed?:(e:ProviderReadEvidence)=>void): Promise<unknown> {
    this.configured();
    // No configurable host or redirects. Permit-bearing reads are reachable only
    // through the explicitly gated execution service; URLs/errors are never logged.
    const url = `${FUSION_BASE}${path}${query ? `?${query}` : ''}`;
    const started=Date.now(),signal=AbortSignal.timeout(10_000),endpoint=path.startsWith('/quoter/')?'quote' as const:'status' as const;
    const evidence=(diagnostic:ProviderReadEvidence['diagnostic'],response?:ProtectedPublicationResponse):ProviderReadEvidence=>({endpoint,elapsedMs:Math.min(60_000,Math.max(0,Date.now()-started)),diagnostic,...(response?{response}:{})});
    let response: Response;
    try { response = await withinProviderDeadline(this.fetcher(url,{method:'GET',headers:{Authorization:`Bearer ${this.apiKey}`,Accept:'application/json'},redirect:'error',signal}),signal); }
    catch {
      const error=new AppError(503,'FUSION_UPSTREAM_UNAVAILABLE','Fusion read-only service did not respond.');
      retainProviderRead(error,evidence({outcome:signal.aborted?'timeout':'transport',at:Date.now()}));throw error;
    }
    if (!response.ok) {
      // Never return upstream errors: they can include credentials, wallet data, or HTML.
      let protectedResponse:ProtectedPublicationResponse|undefined;
      const diagnostic=await publicationDiagnostic(async()=>response,signal,Date.now,{save:e=>{protectedResponse=e;},reflections:[this.apiKey,...(query?[...query.values()]:[])]});
      const error=response.status===404 ? new AppError(404,'FUSION_ORDER_UNKNOWN','No provider evidence for this order; do not resubmit.') : new AppError(response.status===429 ? 429 : 503,'FUSION_UPSTREAM_UNAVAILABLE','Fusion read-only service unavailable.',response.status===429 ? 60 : undefined);
      retainProviderRead(error,evidence(diagnostic,protectedResponse));throw error;
    }
    let reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
    let body:Extract<ProviderReadEvidence['diagnostic'],{outcome:'http'}>['body']='unrecognized';
    try {
      if (!response.headers.get('content-type')?.includes('application/json')) throw new Error();
      reader=response.body?.getReader(); if(!reader) throw new Error();
      const chunks:Uint8Array[]=[];let size=0;
      while(true) {body='read-failure';const {done,value}=await withinProviderDeadline(reader.read(),signal);if(done)break;size+=value.length;if(size>262_144){body='too-large';throw new Error();}chunks.push(value);}
      body='unrecognized';
      const parsed=JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
      observed?.(evidence({outcome:'http',httpStatus:response.status,body:'json',at:Date.now()}));return parsed;
    } catch {
      const error=new AppError(502,'FUSION_INVALID_RESPONSE','Invalid Fusion read-only response.');
      retainProviderRead(error,evidence({outcome:'http',httpStatus:response.status,body:signal.aborted?'timeout':body,at:Date.now()}));throw error;
    }finally{try{void (reader?reader.cancel():response.body?.cancel())?.catch(()=>{});}catch{/* best-effort cancellation must not erase evidence */}}
  }
  async quote(request: QuoteRequest, permit?: string, autoSlippage = false, _check?: undefined, approvalEstimate = false): Promise<RawQuote> {
    request=quoteRequest.parse(request);
    if(approvalEstimate && (permit!==undefined || request.tokenIn!=='0xc2132d05d31c914a87c6611c10748aeb04b58e8f'))throw new AppError(400,'FUSION_INVALID_PERMIT','Approval estimation requires USDT0 and no permit.');
    const executable=permit!==undefined || approvalEstimate;
    if (autoSlippage && (executable || request.slippageBps !== MAX_AUTO_SLIPPAGE_BPS)) throw new AppError(400,'FUSION_AUTO_SLIPPAGE_UNAVAILABLE','Auto requires an unsigned provider estimate.');
    if(permit!==undefined && !/^0x[0-9a-fA-F]{448}$/.test(permit))throw new AppError(400,'FUSION_INVALID_PERMIT','Exact seven-word token permit required.');
    const params = QuoterRequest.new({fromTokenAddress:request.tokenIn,toTokenAddress:request.tokenOut,amount:request.amount,walletAddress:request.account,enableEstimate:executable,isPermit2:false,...(permit!==undefined?{permit}:{}),...(autoSlippage ? {} : {slippage:request.slippageBps/100})});
    const query=new URLSearchParams(Object.entries(params.build()).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)]));
    let phase:QuotePhase='provider-read',autoK:number|undefined,provider:ProviderReadEvidence|undefined;
    try {
    const body=await this.read('/quoter/v2.0/137/quote/receive',query,e=>{provider=e;});
    phase='quote-schema';
    const result=quoteResponse.safeParse(body);
    if (!result.success || result.data.fromTokenAmount!==request.amount) {
      const error=new AppError(502,'FUSION_INVALID_RESPONSE','Fusion quote does not match the requested input.');
      if(result.success)phase='quote-input';
      retainBuildEvidence(error,result.success?'quote-input':'quote-schema',undefined,result.success?undefined:schemaShapes(body,result.error.issues));
      throw error;
    }
    phase='auto-limit';autoK=result.data.autoK;
    const effectiveSlippage = autoSlippage ? providerAutoSlippageBps(result.data.autoK) : request.slippageBps;
    if (effectiveSlippage === null) throw new AppError(409,'FUSION_AUTO_SLIPPAGE_UNAVAILABLE','Provider Auto is unavailable within the 1% safety limit. Choose a manual maximum; no automatic widening.');
    for(const p of Object.values(result.data.presets)) {
      phase='quote-cost';
      const gross=BigInt(result.data.toTokenAmount);
      const disclosedCosts=BigInt(p.tokenFee)+BigInt(p.bankFee);
      if(disclosedCosts*10n>gross) throw new AppError(502,'FUSION_INVALID_RESPONSE','Excessive indicative quote costs.');
      // Executable responses still require structural/cost safety for EVERY
      // preset, but only the saved consent floor governs the eventual build.
      // A fresh gross-derived floor would silently move consent after exposure.
      const floor=!executable ? fusionNetFloor(result.data.toTokenAmount,effectiveSlippage,p.tokenFee,p.bankFee,result.data.fee.bps) : 1n;
      phase='quote-auction';
      if(BigInt(p.auctionEndAmount)<floor || BigInt(p.auctionStartAmount)<BigInt(p.auctionEndAmount) || p.points.reduce((a,b)=>a+b.delay,0)>p.auctionDuration) throw new AppError(502,'FUSION_INVALID_RESPONSE','Unsafe Fusion auction output.');
    }
    return result.data;
    } catch(error){retainQuoteFailure(error,phase,autoK,provider);throw error;}
  }
  build(request: QuoteRequest, raw: RawQuote) {
    if (!raw.quoteId) throw new AppError(409,'FUSION_ESTIMATE_REQUIRED','Indicative quote only: executable estimation and permit readiness are not verified.');
    return this.preflight(request,raw);
  }
  // Pure unsigned SDK economics check. Quote.createFusionOrder supports a null
  // quoteId and no permit; never fabricate executable evidence for a preview.
  preflight(request: QuoteRequest, raw: RawQuote, deadline?: number, nowSeconds?: number, executableMinimum = false) {
    request=quoteRequest.parse(request);
    const parsed=quoteResponse.safeParse(raw);
    if(!parsed.success || parsed.data.fromTokenAmount!==request.amount) throw new AppError(502,'FUSION_BUILD_MISMATCH','Invalid saved Fusion quote.');
    raw=parsed.data;
    // Construct from the actual saved preview and selected preset, no provider read.
    const params=QuoterRequest.new({fromTokenAddress:request.tokenIn,toTokenAddress:request.tokenOut,amount:request.amount,walletAddress:request.account,enableEstimate:false,isPermit2:false,slippage:request.slippageBps/100});
    const quote=new Quote(params,raw as QuoterResponse);
    const auctionOrder=quote.createFusionOrder({network:137,preset:raw.recommended_preset as PresetEnum,receiver:new Address(request.account),allowPartialFills:false,allowMultipleFills:false,orderExpirationDelay:0n});
    const order=deadline===undefined ? auctionOrder : withExactOrderDeadline(auctionOrder,deadline,deadline,nowSeconds!);
    const built=order.build(); const domain=order.getTypedData(137).domain;
    if(built.maker.toLowerCase()!==request.account || order.realReceiver.toString().toLowerCase()!==request.account || built.makerAsset.toLowerCase()!==request.tokenIn || built.takerAsset.toLowerCase()!==request.tokenOut || built.makingAmount!==request.amount || domain.chainId!==137 || String(domain.verifyingContract).toLowerCase()!==SPENDER || order.partialFillAllowed || order.multipleFillsAllowed) throw new AppError(502,'FUSION_BUILD_MISMATCH','Fusion unsigned order failed validation.');
    const minimum=order.getUserReceiveAmount(new Address('0x0000000000000000000000000000000000000000'),order.makingAmount,order.auctionEndTime,0n);
    if(minimum<=0n || (!executableMinimum && minimum<fusionNetFloor(raw.toTokenAmount,request.slippageBps,raw.presets[raw.recommended_preset].tokenFee,raw.presets[raw.recommended_preset].bankFee,raw.fee.bps))) throw new AppError(502,'FUSION_BUILD_MISMATCH','Fusion net output is below the allowed minimum.');
    return {order:built,extension:order.extension.encode(),orderHash:order.getOrderHash(137),deadline:Number(order.deadline)*1000,auctionEndAmount:built.takingAmount,minimumReceiveAmount:minimum.toString()};
  }
  status(hash: string) {
    if(!/^0x[0-9a-f]{64}$/.test(hash)) throw new AppError(400,'INVALID_ORDER_HASH','Invalid order hash.');
    return this.read(`/orders/v2.0/137/order/status/${hash}`);
  }
}
export type BuiltOrder = ReturnType<FusionAdapter['build']>;
