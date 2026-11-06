import { publicHash, sanitizePublicOrderStatus } from '../shared/fusion-public-status.js';
import { registerFusionExecution } from './fusion-execution-routes.js';
import type { ExecutionChain } from './fusion-execution-chain.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadConfig, type Environment } from './config.js';
import { PrivateFusionDiagnostics, privateQuoteFailure, type PrivateQuoteDiagnostic } from './fusion-private-diagnostics.js';
import { fusionConfig, capability, quoteRequest, executionBlocked, evmAddress } from '../fusion/policy.js';
import { FusionAdapter, type Fetch } from '../fusion/adapter.js';
import { FusionService, FusionStore, publicPreview } from '../fusion/service.js';

/** Registered after shared origin/CSRF/session hooks. Legacy previews stay inert;
 * execution has its own explicit default-off configuration and journal. */
export function registerFusion(app:FastifyInstance, options:{env?:Environment;fetch?:Fetch;dbPath:string;now:()=>number;session:(req:FastifyRequest)=>string;chain?:ExecutionChain}) {
  const config=fusionConfig(options.env);
  const store=new FusionStore(config.configured ? options.dbPath : ':memory:');
  const service=new FusionService(new FusionAdapter(config.apiKey,options.fetch),store,options.now);
  const env=options.env??process.env;
  let diagnostics:PrivateFusionDiagnostics|undefined;
  try{if(config.configured&&env.TOKEN_ENCRYPTION_KEY)diagnostics=new PrivateFusionDiagnostics(options.dbPath===':memory:'?':memory:':`${options.dbPath}.diagnostics`,loadConfig(options.env).key);}
  catch{app.log.warn({code:'FUSION_PRIVATE_DIAGNOSTIC_INIT_FAILED'},'Private quote diagnostic unavailable');}
  const capture=(value:PrivateQuoteDiagnostic)=>{try{diagnostics?.record(value);}catch{app.log.warn({code:'FUSION_PRIVATE_DIAGNOSTIC_WRITE_FAILED'},'Private quote diagnostic unavailable');}};
  app.addHook('onClose',async()=>{store.close();diagnostics?.close();});
  registerFusionExecution(app,options,store);
  // Public read-only provider hints use the existing status ingress. They never
  // open the private execution journal or return authority-bearing order data.
  const publicAdapter = new FusionAdapter(config.apiKey, options.fetch);
  let publicRead: Promise<unknown> | null = null;
  app.get('/api/fusion/status',async(req, reply)=>{
    const {orderHash}=z.object({orderHash:publicHash.optional()}).strict().parse(req.query);
    if(orderHash) {
      reply.header('Cache-Control','no-store');
      if(publicRead) { reply.code(429); return {error:{code:'RATE_LIMITED',message:'Status check already in progress.'}}; }
      const read=publicAdapter.status(orderHash); publicRead=read;
      try { return sanitizePublicOrderStatus(await read,orderHash); }
      finally { if(publicRead===read)publicRead=null; }
    }
    return {configured:config.configured,available:config.configured,...capability,
      ...(config.executionEnabled?{executionEnabled:true,mode:'gasless-execution',permitSupport:'native-eip2612',zeroAllowanceGasless:true,liveServiceAcceptanceVerified:false}:{}),
    };
  });
  app.post('/api/fusion/quotes',async req=>{
    const session=options.session(req);
    const {clientRequestId,autoSlippage,...request}=quoteRequest.safeExtend({clientRequestId:z.string().uuid(),autoSlippage:z.boolean().default(false)}).strict().parse(req.body);
    const started=options.now();
    const base=()=>({version:1 as const,at:options.now(),clientRequestId,autoSlippage,intent:{tokenIn:request.tokenIn,tokenOut:request.tokenOut,amount:request.amount,slippageBps:request.slippageBps},elapsedMs:Math.min(60_000,Math.max(0,options.now()-started))});
    try {
      const result=await service.quote(session,clientRequestId,request,autoSlippage);options.session(req);
      capture({...base(),outcome:'success',code:'OK',resolvedSlippageBps:result.request.slippageBps});
      return publicPreview(result);
    }catch(error){capture({...base(),outcome:'failure',...privateQuoteFailure(error)});throw error;}
  });
  const params=z.object({id:z.string().uuid()});
  const account=z.object({account:evmAddress}).strict();
  app.get('/api/fusion/previews/:id',async req=>publicPreview(service.get(options.session(req),params.parse(req.params).id,account.parse(req.query).account)));
  app.post('/api/fusion/previews/:id/build',async req=>publicPreview(service.build(options.session(req),params.parse(req.params).id,account.parse(req.body).account)));
  app.post('/api/fusion/previews/:id/reconcile',async req=>{
    const result=await service.reconcile(options.session(req),params.parse(req.params).id,account.parse(req.body).account);options.session(req);return publicPreview(result);
  });
  // This gate is unconditional, including with a valid key, valid CSRF, or forged signatures.
  for(const action of ['submit','sign','permit','approve','cancel']) {
    app.post(`/api/fusion/previews/:id/${action}`,async()=>executionBlocked());
    app.post(`/api/fusion/${action}`,async()=>executionBlocked());
  }
}
