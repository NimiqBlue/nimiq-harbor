import Fastify, { type FastifyRequest } from 'fastify';
import { registerFusion } from './fusion.js';
import type { ExecutionChain } from './fusion-execution-chain.js';
import { fusionConfig } from '../fusion/policy.js';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { AppError, loadConfig, type Environment } from './config.js';
import { Store, digest, opaque, type Session } from './store.js';

function equal(a: string, b: string) { const x=Buffer.from(a),y=Buffer.from(b); return x.length === y.length && timingSafeEqual(x,y); }
export interface AppOptions { env?: Environment; fetch?: typeof fetch; now?: () => number; dbPath?: string; executionChain?:ExecutionChain }
/** Single-process Fastify factory. Importing does not listen or make network calls. */
export function createApp(options: AppOptions = {}) {
  const fusion = fusionConfig(options.env); // Reject forbidden execution/configuration before opening stores.
  const config = loadConfig(options.env); const now = options.now || Date.now;
  const store = new Store(options.dbPath || (config.durableSessions ? config.dbPath : ':memory:'), config.key);
  const app = Fastify({ logger: false, bodyLimit: 16_384, trustProxy: false });
  const sessions = new WeakMap<FastifyRequest, { id: string; session: Session }>();
  const rates = new Map<string, { count: number; until: number }>();
  function current(req: FastifyRequest) {
    const entry = sessions.get(req); const session=entry && store.session(entry.id,now());
    if (!entry || !session) throw new AppError(401, 'SESSION_REQUIRED', 'Initialize a session first.');
    return {id:entry.id,session};
  }
  function cookie(raw: string) { return `${config.cookieName}=${raw}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${config.sessionTtl / 1000}${config.secure ? '; Secure' : ''}`; }
  app.addHook('onClose', async () => { store.close(); });
  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control','no-store').header('Pragma','no-cache').header('Referrer-Policy','no-referrer').header('X-Content-Type-Options','nosniff');
    if (req.url.startsWith('/api/')) {
      const key=req.ip; const old=rates.get(key); const rate=old && old.until>now() ? old : {count:0,until:now()+60_000};
      rate.count++; rates.set(key,rate);
      if (rates.size>10_000) for(const [k,v] of rates) if(v.until<=now()) rates.delete(k);
      if(rate.count>120) { reply.header('Retry-After','60'); throw new AppError(429,'RATE_LIMITED','Too many requests.'); }
    }
    const raw=req.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith(`${config.cookieName}=`))?.slice(config.cookieName.length+1);
    if (raw && /^[A-Za-z0-9_-]{43}$/.test(raw)) { const id=digest(raw); const session=store.session(id,now()); if(session) sessions.set(req,{id,session}); }
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
      const {session}=current(req);
      if(req.headers.origin!==config.origin || req.headers['sec-fetch-site']==='cross-site' || typeof req.headers['x-csrf-token']!=='string' || !equal(req.headers['x-csrf-token'],session.csrf)) throw new AppError(403,'CSRF_REJECTED','Origin and session CSRF token required.');
      if (!req.headers['content-type']?.startsWith('application/json')) throw new AppError(415,'JSON_REQUIRED','Use application/json.');
    }
  });
  app.setErrorHandler((err,_req,reply) => {
    if(err instanceof z.ZodError) return reply.code(400).send({error:{code:'INVALID_INPUT',message:'Invalid request fields.'}});
    if(err instanceof AppError) { if (err.retryAfter) reply.header('Retry-After',String(err.retryAfter)); return reply.code(err.status).send({error:{code:err.code,message:err.message}}); }
    const requestStatus=(err as {statusCode?:number}).statusCode;
    if (requestStatus && requestStatus>=400 && requestStatus<500) return reply.code(requestStatus).send({error:{code:'INVALID_REQUEST',message:'Request could not be accepted.'}});
    return reply.code(500).send({error:{code:'INTERNAL_ERROR',message:'Request could not be completed.'}});
  });
  app.get('/api/health',async()=>({ok:true,configured:fusion.configured}));
  app.get('/api/fusion/session',async(req,reply)=>{
    let entry=sessions.get(req);
    if(!entry) { const raw=opaque(); entry={id:digest(raw),session:{csrf:opaque(),expiresAt:now()+config.sessionTtl}}; store.putSession(entry.id,entry.session); reply.header('Set-Cookie',cookie(raw)); }
    return {csrfToken:entry.session.csrf};
  });
  registerFusion(app,{...(options.executionChain ? {chain:options.executionChain} : {}),...(options.env ? {env:options.env} : {}),...(options.fetch ? {fetch:options.fetch} : {}),dbPath:!config.durableSessions ? ':memory:' : options.dbPath ? (options.dbPath === ':memory:' ? ':memory:' : `${options.dbPath}.fusion`) : `${config.dbPath}.fusion`,now,session:req=>current(req).id});
  return app;
}
