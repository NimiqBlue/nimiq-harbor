import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import type { QuoteRequest } from '../fusion/policy.js';
import type { buildLocalPermitOrder, prepareFusionPermit } from '../fusion/permit-preparation.js';
import type { FusionExecutionState } from '../shared/fusion-execution.js';
import type { PublicationDiagnostic } from './fusion-publication-diagnostics.js';
import type { ProtectedPublicationResponse } from './fusion-publication-evidence.js';
import type { BuildFailure } from './fusion-build-diagnostics.js';

export type PermitSnapshot = ReturnType<typeof prepareFusionPermit>['snapshot'];
export type SavedOrder = Awaited<ReturnType<typeof buildLocalPermitOrder>>;
export interface ExecutionRecord {
  authorization?:'onchain-approval'; approvalTransactionHash?:string;
  id:string; session:string; clientRequestId:string; request:QuoteRequest; createdAt:number;
  expiresAt:number; permitDeadline:number; snapshot:PermitSnapshot;
  deadlineMinutes?:number; orderDeadline?:number;
  confirmedMinimumReceiveAmount?:string; previewId?:string;
  minimumPolicy?:'sdk-executable-v1'; previewMinimumReceiveAmount?:string;
  state:FusionExecutionState; built?:SavedOrder; quoteId?:string; buildFailure?:BuildFailure;
  publicationDiagnostic?:PublicationDiagnostic;
  publicationResponseEvidence?:ProtectedPublicationResponse;
  permitSignature?:string; permitExposedAt?:number;
  dispatchStarted?:number; orderSignature?:string; providerStatus?:string; settlementVerified:boolean;
  transactionHash?:string; verifiedBlockHash?:string; revision?:number;
}
/** Separate encrypted journal. Signatures in extensions are spending authority,
 * not ordinary quote metadata. No plaintext signature is stored or logged. */
export class ExecutionStore {
  private readonly db:DatabaseSync;
  constructor(path:string,private readonly key:Buffer) {
    if(key.length!==32)throw new Error('Execution journal requires a 32-byte encryption key');
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true,mode:0o700});
    this.db=new DatabaseSync(path);
    if(path!==':memory:')chmodSync(path,0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS fusion_execution (
        id TEXT PRIMARY KEY,session TEXT NOT NULL,request_id TEXT NOT NULL,account TEXT NOT NULL,
        token TEXT NOT NULL,nonce TEXT NOT NULL,state TEXT NOT NULL,created INTEGER NOT NULL,data TEXT NOT NULL,
        UNIQUE(session,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS fusion_execution_active_nonce ON fusion_execution(account,token,nonce)
        WHERE state NOT IN ('prepared','expired');
      CREATE TABLE IF NOT EXISTS fusion_execution_unsigned_cancel (id TEXT PRIMARY KEY,session TEXT NOT NULL,request_id TEXT NOT NULL,account TEXT NOT NULL,cancelled INTEGER NOT NULL,UNIQUE(session,request_id));
      CREATE TABLE IF NOT EXISTS fusion_execution_dispatch (id TEXT PRIMARY KEY,started INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS fusion_execution_recovery (id TEXT PRIMARY KEY,session TEXT NOT NULL,account TEXT NOT NULL,expires INTEGER NOT NULL,origin TEXT NOT NULL);
    `);
    // Upgrade older execution journals in place, without touching bank storage.
    if(!this.db.prepare('PRAGMA table_info(fusion_execution)').all().some(c=>c.name==='revision'))this.db.exec('ALTER TABLE fusion_execution ADD COLUMN revision INTEGER NOT NULL DEFAULT 0');
  }
  private seal(r:ExecutionRecord) {
    const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',this.key,iv);
    cipher.setAAD(Buffer.from(`fusion-execution:${r.id}`));
    const payload=Buffer.concat([cipher.update(JSON.stringify(r)),cipher.final()]);
    return Buffer.concat([iv,cipher.getAuthTag(),payload]).toString('base64');
  }
  private read(row:Record<string,unknown>|undefined):ExecutionRecord|undefined {
    if(!row)return;
    const value=Buffer.from(String(row.data),'base64'), decipher=createDecipheriv('aes-256-gcm',this.key,value.subarray(0,12));
    decipher.setAAD(Buffer.from(`fusion-execution:${String(row.id)}`));decipher.setAuthTag(value.subarray(12,28));
    const r=JSON.parse(Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString()) as ExecutionRecord;
    // The atomic SQL claim is authoritative even after a crash before rewriting encrypted data.
    return {...r,state:row.state as FusionExecutionState,revision:Number(row.revision)};
  }
  get(id:string,session:string){return this.read(this.db.prepare('SELECT * FROM fusion_execution WHERE id=? AND session=?').get(id,session));}
  find(requestId:string,session:string){return this.read(this.db.prepare('SELECT * FROM fusion_execution WHERE request_id=? AND session=?').get(requestId,session));}
  list(session:string,account:string) {
    return this.db.prepare('SELECT * FROM fusion_execution WHERE session=? AND account=? ORDER BY created DESC LIMIT 100').all(session,account).map(r=>this.read(r)!);
  }
  insert(r:ExecutionRecord) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      // Recheck after asynchronous preflight, against every session/connection.
      if(this.wasUnsignedCancelled(r.clientRequestId,r.session))throw new Error('Unsigned request was cancelled');
      if(this.hasUnresolved(r.request.account))throw new Error('Maker requires reconciliation');
      this.db.prepare('INSERT INTO fusion_execution (id,session,request_id,account,token,nonce,state,created,data) VALUES(?,?,?,?,?,?,?,?,?)').run(r.id,r.session,r.clientRequestId,r.request.account,r.request.tokenIn,r.authorization==='onchain-approval'?`approval:${r.id}`:r.snapshot.nonce,r.state,r.createdAt,this.seal(r));
      this.db.exec('COMMIT');
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  /** Same-session cancellation is an explicit client assertion of first-RPC
   * rejection, NOT server proof that a wallet never signed. Local callers must
   * hold the signing Web Lock and exact write-ahead journal. Server independently
   * requires an authority-free record and revision CAS; exposure always wins. */
  cancelUnsigned(expected:ExecutionRecord,now:number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r=this.get(expected.id,expected.session);
      if(!r || r.revision!==expected.revision || r.clientRequestId!==expected.clientRequestId || r.state!=='prepared' ||
        r.permitSignature!==undefined || r.permitExposedAt!==undefined || r.built!==undefined || r.quoteId!==undefined ||
        r.orderSignature!==undefined || r.dispatchStarted!==undefined || r.transactionHash!==undefined ||
        r.verifiedBlockHash!==undefined || r.settlementVerified || this.dispatched(r.id)) {
        this.db.exec('ROLLBACK');return false;
      }
      this.db.prepare('INSERT INTO fusion_execution_unsigned_cancel VALUES(?,?,?,?,?)').run(r.id,r.session,r.clientRequestId,r.request.account,now);
      const changed=this.db.prepare("DELETE FROM fusion_execution WHERE id=? AND session=? AND state='prepared' AND revision=?").run(r.id,r.session,r.revision??0).changes===1;
      if(!changed)throw new Error('Unsigned cancellation changed');
      this.db.exec('COMMIT');return true;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  unsignedCancellation(id:string,session:string) {
    const row=this.db.prepare('SELECT id,request_id,account FROM fusion_execution_unsigned_cancel WHERE id=? AND session=?').get(id,session);
    return row ? {id:String(row.id),clientRequestId:String(row.request_id),account:String(row.account),outcome:'unsigned-cancelled' as const} : undefined;
  }
  wasUnsignedCancelled(requestId:string,session:string) {
    return Boolean(this.db.prepare('SELECT 1 FROM fusion_execution_unsigned_cancel WHERE request_id=? AND session=?').get(requestId,session));
  }
  /** Irreversible exposure barrier, before ANY permit-bearing provider request.
   * SQL nonce uniqueness and maker-wide exclusion are atomic across processes.
   * A crash before sending is conservatively unresolved; never retry the quote. */
  expose(record:ExecutionRecord,signature:string,now:number) {
    const exposed={...record,state:'permit-exposed' as const,permitSignature:signature,permitExposedAt:now};
    return this.db.prepare(`UPDATE fusion_execution SET state='permit-exposed',data=?,revision=revision+1
      WHERE id=? AND session=? AND state='prepared' AND revision=?
      AND NOT EXISTS(SELECT 1 FROM fusion_execution WHERE account=? AND id<>? AND state IN ('approval-pending','approval-confirmed','permit-exposed','built','submitting','pending','unknown'))`)
      .run(this.seal(exposed),record.id,record.session,record.revision??0,record.request.account,record.id).changes===1;
  }
  reserveApproval(record:ExecutionRecord) {
    if(record.authorization!=='onchain-approval')return false;
    return this.db.prepare(`UPDATE fusion_execution SET state='approval-pending',data=?,revision=revision+1
      WHERE id=? AND session=? AND state='prepared' AND revision=?
      AND NOT EXISTS(SELECT 1 FROM fusion_execution WHERE account=? AND id<>? AND state IN ('approval-pending','approval-confirmed','permit-exposed','built','submitting','pending','unknown'))`)
      .run(this.seal({...record,state:'approval-pending'}),record.id,record.session,record.revision??0,record.request.account,record.id).changes===1;
  }
  /** Compare-and-set prevents concurrent build/reconcile/late POST writes regressing evidence. */
  update(r:ExecutionRecord,expected:FusionExecutionState) {
    return this.db.prepare('UPDATE fusion_execution SET state=?,data=?,revision=revision+1 WHERE id=? AND session=? AND state=? AND revision=?').run(r.state,this.seal(r),r.id,r.session,expected,r.revision??0).changes===1;
  }
  /** Write-ahead irreversible dispatch marker. No retry, even if process dies before sending. */
  claim(record:ExecutionRecord,now:number) {
    const {id,session}=record;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const claimed={...record,state:'submitting' as const,dispatchStarted:now};
      const changed=this.db.prepare("UPDATE fusion_execution SET state='submitting',data=?,revision=revision+1 WHERE id=? AND session=? AND state='built' AND revision=? AND NOT EXISTS(SELECT 1 FROM fusion_execution_dispatch WHERE id=?)").run(this.seal(claimed),id,session,record.revision??0,id).changes===1;
      if(changed)this.db.prepare('INSERT INTO fusion_execution_dispatch VALUES(?,?)').run(id,now);
      this.db.exec('COMMIT');return changed;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  dispatched(id:string){return Boolean(this.db.prepare('SELECT 1 FROM fusion_execution_dispatch WHERE id=?').get(id));}
  hasUnresolved(account:string){return Boolean(this.db.prepare("SELECT 1 FROM fusion_execution WHERE account=? AND state IN ('approval-pending','approval-confirmed','permit-exposed','built','submitting','pending','unknown') LIMIT 1").get(account));}
  /** Internal bounded proof candidates, never a public record lookup. */
  unresolvedForExpiry(account:string) {
    return this.db.prepare("SELECT * FROM fusion_execution WHERE account=? AND state IN ('approval-pending','approval-confirmed','permit-exposed','built','submitting','pending','unknown') ORDER BY created LIMIT 10").all(account).map(row=>this.read(row)!);
  }
  createRecovery(session:string,account:string,origin:string,now:number) {
    this.db.prepare('DELETE FROM fusion_execution_recovery WHERE expires<=? OR session=?').run(now,session);
    const id=randomBytes(16).toString('hex'),expires=now+120_000;
    this.db.prepare('INSERT INTO fusion_execution_recovery VALUES(?,?,?,?,?)').run(id,session,account,expires,origin);
    return {id,session,account,origin,expires};
  }
  recovery(id:string,session:string,now:number) {
    return this.db.prepare('SELECT * FROM fusion_execution_recovery WHERE id=? AND session=? AND expires>?').get(id,session,now) as {id:string;session:string;account:string;expires:number;origin:string}|undefined;
  }
  /** Ownership verified by caller; consume challenge and rotate record ownership
   * atomically. Caller request IDs belong to a session, not to the maker or order.
   * Never merge records or change execution IDs (the encryption/dispatch identity). */
  reattach(challengeId:string,session:string,now:number) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const challenge=this.recovery(challengeId,session,now);
      if(!challenge)throw new Error('Recovery challenge expired or consumed');
      const records=this.db.prepare('SELECT * FROM fusion_execution WHERE account=?').all(challenge.account);
      let retained=0;
      for(const row of records) {
        const record=this.read(row)!;
        if(record.session!==session) {
          // Anyone can prepare for an arbitrary maker. Foreign unsigned drafts
          // prove no ownership and must not be imported into the owner's history.
          // Delete only authority-free drafts; retain every exposure/order/claim.
          if(record.state==='prepared' && !record.permitSignature && record.permitExposedAt===undefined
            && !record.built && !record.orderSignature && record.dispatchStarted===undefined && !this.dispatched(record.id)
            && !record.transactionHash && !record.verifiedBlockHash && !record.settlementVerified) {
            this.db.prepare('DELETE FROM fusion_execution WHERE id=?').run(record.id);
            continue;
          }
          // Rebase ALL incoming session-local keys, checking the entire target
          // namespace (including other makers). Existing target keys stay stable.
          let requestId:string;
          do{requestId=randomUUID();}while(requestId===record.clientRequestId || this.db.prepare('SELECT 1 FROM fusion_execution WHERE session=? AND request_id=?').get(session,requestId));
          record.session=session;record.clientRequestId=requestId;
          this.db.prepare('UPDATE fusion_execution SET session=?,request_id=?,data=?,revision=revision+1 WHERE id=?').run(session,requestId,this.seal(record),record.id);
        }
        retained++;
      }
      this.db.prepare('DELETE FROM fusion_execution_recovery WHERE id=?').run(challengeId);
      this.db.exec('COMMIT');return retained;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  close(){this.db.close();}
}
