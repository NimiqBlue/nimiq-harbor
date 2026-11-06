import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AppError } from '../server/config.js';
import { type QuoteRequest, quoteRequest, uint, positive, evmAddress, capability } from './policy.js';
import { FusionAdapter, type RawQuote, type BuiltOrder } from './adapter.js';
import { providerAutoSlippageBps } from '../shared/auto-slippage.js';
import { fusionNetFloor } from '../shared/fusion-net-output.js';

export interface RecordData {
  id:string; session:string; clientRequestId:string; request:QuoteRequest; raw:RawQuote;
  expiresAt:number; built?:BuiltOrder; state:string; providerStatus?:string;
  autoSlippage?:boolean; quoteInput?:QuoteRequest;
}
export class FusionStore {
  private readonly db:DatabaseSync;
  constructor(path:string) {
    if(path!==':memory:') mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:') chmodSync(path,0o600);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS fusion_preview (id TEXT PRIMARY KEY, session TEXT NOT NULL, client_request_id TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(session,client_request_id))');
    this.db.exec('CREATE TABLE IF NOT EXISTS fusion_quote_budget (name TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL)');
  }
  reserveQuote(now:number) {
    // Shared persistent budget: public preview cannot consume an unbounded API allowance.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [name,duration,limit] of [['minute',60_000,12],['day',86_400_000,300]] as const) {
        const window=Math.floor(now/duration);
        const row=this.db.prepare('SELECT window,count FROM fusion_quote_budget WHERE name=?').get(name);
        const count=row && Number(row.window)===window ? Number(row.count) : 0;
        if(count>=limit) throw new AppError(429,'FUSION_PREVIEW_BUDGET','Preview quote budget reached. Try later.',Math.ceil(((window+1)*duration-now)/1000));
        this.db.prepare('INSERT INTO fusion_quote_budget(name,window,count) VALUES(?,?,?) ON CONFLICT(name) DO UPDATE SET window=excluded.window,count=excluded.count').run(name,window,count+1);
      }
      this.db.exec('COMMIT');
    } catch(error) {this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
  get(id:string,session:string):RecordData|undefined {const row=this.db.prepare('SELECT data FROM fusion_preview WHERE id=? AND session=?').get(id,session);return row ? JSON.parse(String(row.data)) as RecordData : undefined;}
  find(clientRequestId:string,session:string):RecordData|undefined {const row=this.db.prepare('SELECT data FROM fusion_preview WHERE client_request_id=? AND session=?').get(clientRequestId,session);return row ? JSON.parse(String(row.data)) as RecordData : undefined;}
  put(record:RecordData){this.db.prepare('INSERT INTO fusion_preview(id,session,client_request_id,data) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(record.id,record.session,record.clientRequestId,JSON.stringify(record));}
}
const orderSchema=z.object({salt:uint,maker:evmAddress,receiver:z.string().regex(/^0x[0-9a-fA-F]{40}$/),makerAsset:evmAddress,takerAsset:evmAddress,makingAmount:positive,takingAmount:positive,makerTraits:uint});
const statusSchema=z.object({status:z.enum(['pending','filled','partially-filled','expired','cancelled','false-predicate','not-enough-balance-or-allowance','wrong-permit','invalid-signature']),order:orderSchema,extension:z.string().regex(/^0x[0-9a-fA-F]*$/).max(10000),fills:z.array(z.object({txHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/),filledMakerAmount:positive,filledAuctionTakerAmount:positive,takerFeeAmount:uint.nullable()})).max(100)});
export function publicPreview(record:RecordData) {
  const preset=record.raw.presets[record.raw.recommended_preset];
  return {id:record.id,clientRequestId:record.clientRequestId,request:record.request,expiresAt:record.expiresAt,state:record.state,
    ...(record.autoSlippage ? {autoSlippage:true} : {}),
    providerStatus:record.providerStatus ?? null,settlementVerified:false,...capability,
    quote:{preset:record.raw.recommended_preset,expectedAmount:record.raw.toTokenAmount,tokenFee:preset.tokenFee,bankFee:preset.bankFee,minimumReceiveAmount:fusionNetFloor(record.raw.toTokenAmount,record.request.slippageBps,preset.tokenFee,preset.bankFee,record.raw.fee.bps).toString(),auctionStartAmount:preset.auctionStartAmount,auctionEndAmount:preset.auctionEndAmount,auctionDuration:preset.auctionDuration,providerFeeBps:record.raw.fee.bps,executableEstimate:record.raw.quoteId!==null},
    build:record.built ? {orderHash:record.built.orderHash,deadline:record.built.deadline,minimumReceiveAmount:record.built.minimumReceiveAmount,auctionEndAmount:record.built.auctionEndAmount,allowPartialFills:false,allowMultipleFills:false} : null};
}
export class FusionService {
  private readonly inflight=new Map<string,Promise<RecordData>>();
  constructor(private readonly adapter:FusionAdapter,private readonly store:FusionStore,private readonly now:()=>number=Date.now){}
  async quote(session:string,clientRequestId:string,request:QuoteRequest,autoSlippage = false):Promise<RecordData> {
    // Validate at the core boundary and detach from caller-owned mutable input
    // before budget/idempotency checks or the first asynchronous upstream read.
    request=quoteRequest.parse(request);
    const key=`${session}:${clientRequestId}`;
    const pending=this.inflight.get(key);
    autoSlippage = z.boolean().parse(autoSlippage);
    if(pending) {await pending;return this.existing(session,clientRequestId,request,autoSlippage)!;}
    const prior=this.existing(session,clientRequestId,request,autoSlippage);if(prior)return prior;
    const job=(async()=>{
      this.store.reserveQuote(this.now());
      const raw=await this.adapter.quote(request,undefined,autoSlippage);
      const resolved = autoSlippage ? providerAutoSlippageBps(raw.autoK) : request.slippageBps;
      if (resolved === null) throw new AppError(409,'FUSION_AUTO_SLIPPAGE_UNAVAILABLE','Provider Auto is unavailable. Choose a manual maximum.');
      const record:RecordData={id:randomUUID(),session,clientRequestId,request:{...request,slippageBps:resolved},raw,expiresAt:this.now()+30_000,state:'quoted-preview',...(autoSlippage ? {autoSlippage:true,quoteInput:request} : {})};
      this.store.put(record);return record;
    })();
    this.inflight.set(key,job);
    try{return await job;}finally{this.inflight.delete(key);}
  }
  private existing(session:string,clientRequestId:string,request:QuoteRequest,autoSlippage = false) {
    const prior=this.store.find(clientRequestId,session);
    if(prior && (Boolean(prior.autoSlippage)!==autoSlippage || JSON.stringify(prior.quoteInput ?? prior.request)!==JSON.stringify(request)))throw new AppError(409,'FUSION_IDEMPOTENCY_CONFLICT','Request ID already belongs to another quote.');
    return prior;
  }
  get(session:string,id:string,account:string) {
    const record=this.store.get(id,session);
    if(!record || record.request.account!==account)throw new AppError(404,'FUSION_PREVIEW_NOT_FOUND','Fusion preview not found for this session and account.');
    return record;
  }
  build(session:string,id:string,account:string) {
    const record=this.get(session,id,account);
    if(record.built)return record; // Durable exact-hash retry, never rebuild an existing intent.
    if(record.expiresAt<=this.now())throw new AppError(409,'FUSION_QUOTE_EXPIRED','Refresh the quote with a new request ID.');
    record.built=this.adapter.build(record.request,record.raw);record.state='built-preview';this.store.put(record);return record;
  }
  async reconcile(session:string,id:string,account:string) {
    const record=this.get(session,id,account);
    if(!record.built)throw new AppError(409,'FUSION_BUILD_REQUIRED','Build an unsigned preview first.');
    // Read-only observation. Even a 404 cannot prove an order never existed.
    try {
      const response=statusSchema.safeParse(await this.adapter.status(record.built.orderHash));
      if(!response.success)throw new Error();
      const value=response.data;
      if(value.extension.toLowerCase()!==record.built.extension.toLowerCase() || Object.entries(record.built.order).some(([k,v])=>String(value.order[k as keyof typeof value.order]).toLowerCase()!==String(v).toLowerCase()))throw new Error();
      const spent=value.fills.reduce((a,f)=>a+BigInt(f.filledMakerAmount),0n);
      const received=value.fills.reduce((a,f)=>a+BigInt(f.filledAuctionTakerAmount)-BigInt(f.takerFeeAmount ?? '0'),0n);
      if(value.fills.some(f=>BigInt(f.takerFeeAmount ?? '0')>BigInt(f.filledAuctionTakerAmount)) || spent>BigInt(record.request.amount) || (value.status==='filled' && (spent!==BigInt(record.request.amount) || received<BigInt(record.built.minimumReceiveAmount))))throw new Error();
      record.providerStatus=value.status;
      record.state=value.status==='pending' ? 'pending-unverified' : value.status==='partially-filled' ? 'partial-unverified' : `${value.status}-unverified`;
    } catch {
      // Preserve previous evidence, but never turn a network error into a terminal outcome.
      record.state='unknown-reconcile-required';
    }
    this.store.put(record);return record;
  }
}
