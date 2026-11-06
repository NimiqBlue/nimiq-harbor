// Bounded operator-only quote history, separate from execution and public DTOs.
// AES-GCM with the existing configured key; no session/account/authority storage.
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { AppError } from './config.js';
import { readQuoteFailure, type QuoteFailureEvidence } from '../fusion/read-evidence.js';
import { readBuildEvidence, type BuildEvidence } from '../fusion/build-evidence.js';
import type { QuoteRequest } from '../fusion/policy.js';
export interface PrivateQuoteDiagnostic {
  version:1;at:number;clientRequestId:string;elapsedMs:number;
  autoSlippage:boolean;outcome:'success'|'failure';code:string;
  quote?:QuoteFailureEvidence;schema?:BuildEvidence;resolvedSlippageBps?:number;
  intent?:Pick<QuoteRequest,'tokenIn'|'tokenOut'|'amount'|'slippageBps'>;
}
const codes=new Set(['FUSION_UNAVAILABLE','FUSION_UPSTREAM_UNAVAILABLE','FUSION_ORDER_UNKNOWN','FUSION_INVALID_RESPONSE','FUSION_AUTO_SLIPPAGE_UNAVAILABLE','FUSION_PREVIEW_BUDGET','FUSION_IDEMPOTENCY_CONFLICT','SESSION_REQUIRED','SESSION_EXPIRED']);
export function privateQuoteFailure(error:unknown):Pick<PrivateQuoteDiagnostic,'code'|'quote'|'schema'> {
  const quote=readQuoteFailure(error),schema=readBuildEvidence(error);
  return {code:error instanceof AppError&&codes.has(error.code)?error.code:'FUSION_QUOTE_UNCLASSIFIED',...(quote?{quote}:{}),...(schema?{schema}:{})};
}
export class PrivateFusionDiagnostics {
  private readonly db:DatabaseSync;
  static readonly limit=128;
  static readonly ttlMs=7*86_400_000;
  constructor(path:string,private readonly key:Buffer){
    if(key.length!==32)throw new Error('Private diagnostics require a 32-byte key');
    this.db=new DatabaseSync(path);if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=1000; CREATE TABLE IF NOT EXISTS private_quote_diagnostic(id TEXT PRIMARY KEY,at INTEGER NOT NULL,data TEXT NOT NULL)');
  }
  record(value:PrivateQuoteDiagnostic){
    const plain=JSON.stringify(value);if(Buffer.byteLength(plain)>16_384)throw new Error('Diagnostic limit');
    const id=randomUUID(),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(`fusion-private-quote:${id}`));
    const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
    const data=Buffer.concat([iv,cipher.getAuthTag(),encrypted]).toString('base64');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM private_quote_diagnostic WHERE at<?').run(value.at-PrivateFusionDiagnostics.ttlMs);
      this.db.prepare('INSERT INTO private_quote_diagnostic VALUES(?,?,?)').run(id,value.at,data);
      this.db.prepare('DELETE FROM private_quote_diagnostic WHERE id NOT IN (SELECT id FROM private_quote_diagnostic ORDER BY at DESC,rowid DESC LIMIT ?)').run(PrivateFusionDiagnostics.limit);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  // Local operator only. Never expose this through an HTTP route or public view.
  recent(now:number):PrivateQuoteDiagnostic[]{
    return this.db.prepare('SELECT id,data FROM private_quote_diagnostic WHERE at>=? ORDER BY at DESC,rowid DESC LIMIT ?').all(now-PrivateFusionDiagnostics.ttlMs,PrivateFusionDiagnostics.limit).map(row=>{
      const bytes=Buffer.from(String(row.data),'base64'),decipher=createDecipheriv('aes-256-gcm',this.key,bytes.subarray(0,12));
      decipher.setAAD(Buffer.from(`fusion-private-quote:${String(row.id)}`));decipher.setAuthTag(bytes.subarray(12,28));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)),decipher.final()]).toString()) as PrivateQuoteDiagnostic;
    });
  }
  close(){this.db.close();}
}
