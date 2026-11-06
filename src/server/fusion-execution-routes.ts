import { existsSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { loadConfig, type Environment } from './config.js';
import { fusionConfig, executionBlocked, quoteRequest, evmAddress, positive } from '../fusion/policy.js';
import { FusionAdapter, type Fetch } from '../fusion/adapter.js';
import { FusionStore } from '../fusion/service.js';
import { ExecutionStore } from './fusion-execution-store.js';
import { FusionExecutionService, executionSignature, executionView } from './fusion-execution.js';
import { PolygonExecutionChain, type ExecutionChain } from './fusion-execution-chain.js';
import { DEFAULT_SWAP_DEADLINE_MINUTES, fixedSwapDeadlineMinutesSchema } from '../shared/swap-deadline.js';

export function registerFusionExecution(app:FastifyInstance,options:{env?:Environment;fetch?:Fetch;dbPath:string;now:()=>number;session:(req:FastifyRequest)=>string;chain?:ExecutionChain},budget:FusionStore) {
  const config=fusionConfig(options.env);
  const enabled=config.executionEnabled;
  let service:FusionExecutionService|undefined;
  const env=options.env??process.env;
  // Emergency execution-off must not strand existing encrypted recovery records.
  const recoveryAvailable=options.dbPath!==':memory:' && Boolean(env.TOKEN_ENCRYPTION_KEY && config.rpcUrl && existsSync(`${options.dbPath}.execution`));
  if(enabled || recoveryAvailable) {
    if(options.dbPath===':memory:')throw new Error('Execution requires a durable SQLite journal');
    const journal=new ExecutionStore(`${options.dbPath}.execution`,loadConfig(options.env).key);
    service=new FusionExecutionService(new FusionAdapter(config.apiKey,options.fetch),journal,budget,options.chain??new PolygonExecutionChain(config.rpcUrl!),config.apiKey,options.fetch,options.now);
    app.addHook('onClose',async()=>journal.close());
  }
  const core=(spending=false)=>{if((spending && !enabled) || !service)executionBlocked();return service;};
  const params=z.object({id:z.string().uuid()}).strict();
  const empty=z.object({}).strict();
  app.post('/api/fusion/execution/prepare',async req=>{
    const c=core(true),session=options.session(req);
    const {clientRequestId,deadlineMinutes,previewId,minimumReceiveAmount,minimumPolicy,...request}=quoteRequest.safeExtend({clientRequestId:z.string().uuid(),previewId:z.string().uuid(),minimumReceiveAmount:positive,minimumPolicy:z.literal('sdk-executable-v1').optional(),deadlineMinutes:fixedSwapDeadlineMinutesSchema.default(DEFAULT_SWAP_DEADLINE_MINUTES)}).strict().parse(req.body);
    return c.prepare(session,clientRequestId,request,()=>{options.session(req);},deadlineMinutes,{previewId,minimumReceiveAmount,...(minimumPolicy ? {minimumPolicy} : {})});
  });
  app.post('/api/fusion/execution/:id/cancel-unsigned',async req=>{
    const c=core(),session=options.session(req),{id}=params.parse(req.params);
    const {clientRequestId}=z.object({clientRequestId:z.string().uuid(),reason:z.literal('wallet-rejected-before-signature')}).strict().parse(req.body);
    return c.cancelUnsigned(session,id,clientRequestId,()=>{options.session(req);});
  });
  app.get('/api/fusion/execution/:id/cancel-unsigned',async req=>{
    const c=core(),session=options.session(req),{id}=params.parse(req.params);
    return c.unsignedCancellation(session,id);
  });
  app.post('/api/fusion/execution/:id/build',async req=>{
    const c=core(true),session=options.session(req),{id}=params.parse(req.params);
    const {permitSignature}=z.object({permitSignature:executionSignature}).strict().parse(req.body);
    return c.build(session,id,permitSignature,()=>{options.session(req);});
  });
  app.post('/api/fusion/execution/:id/submit',async req=>{
    const c=core(true),session=options.session(req),{id}=params.parse(req.params);
    const {orderSignature}=z.object({orderSignature:executionSignature}).strict().parse(req.body);
    return c.submit(session,id,orderSignature,()=>{options.session(req);});
  });
  app.post('/api/fusion/execution/:id/approval/request',async req=>{
    const c=core(true),session=options.session(req),{id}=params.parse(req.params);empty.parse(req.body);
    return c.requestApproval(session,id,()=>{options.session(req);});
  });
  app.post('/api/fusion/execution/:id/approval/confirm',async req=>{
    const c=core(true),session=options.session(req),{id}=params.parse(req.params);
    const {transactionHash}=z.object({transactionHash:z.string().regex(/^0x[0-9a-fA-F]{64}$/)}).strict().parse(req.body);
    return c.confirmApproval(session,id,transactionHash,()=>{options.session(req);});
  });
  app.post('/api/fusion/execution/:id/approval/build',async req=>{
    const c=core(true),session=options.session(req),{id}=params.parse(req.params);empty.parse(req.body);
    return c.buildApproved(session,id,()=>{options.session(req);});
  });
  app.post('/api/fusion/execution/:id/approval/rejected',async req=>{
    const c=core(),session=options.session(req),{id}=params.parse(req.params);
    z.object({reason:z.literal('wallet-rejected-before-broadcast')}).strict().parse(req.body);
    return c.cancelRejectedApproval(session,id,()=>{options.session(req);});
  });
  app.post('/api/fusion/execution/:id/reconcile',async req=>{
    const c=core(),session=options.session(req),{id}=params.parse(req.params);empty.parse(req.body);
    return c.reconcile(session,id,()=>{options.session(req);});
  });
  // Durable same-session lookup. An account string is never ownership proof.
  app.post('/api/fusion/execution/ownership/challenge',async req=>{
    const c=core(),session=options.session(req),{account}=z.object({account:evmAddress}).strict().parse(req.body);
    return c.recoveryChallenge(session,account,loadConfig(options.env).origin);
  });
  app.post('/api/fusion/execution/ownership/recover',async req=>{
    const c=core(),session=options.session(req),{challengeId,signature}=z.object({challengeId:z.string().regex(/^[0-9a-f]{32}$/),signature:executionSignature}).strict().parse(req.body);
    return c.recoverOwnership(session,challengeId,signature,loadConfig(options.env).origin,()=>{options.session(req);});
  });
  app.post('/api/fusion/execution/recover',async req=>{
    const c=core(),session=options.session(req),value=z.object({clientRequestId:z.string().uuid(),account:evmAddress}).strict().parse(req.body);
    return c.recover(session,value.clientRequestId,value.account);
  });
  app.get('/api/fusion/execution',async req=>{
    const c=core(),session=options.session(req),{account}=z.object({account:evmAddress}).strict().parse(req.query);
    return {executions:c.history(session,account)};
  });
  app.get('/api/fusion/execution/:id',async req=>{
    const c=core(),session=options.session(req),{id}=params.parse(req.params);
    return executionView(c.get(session,id));
  });
}
