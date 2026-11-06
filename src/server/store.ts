import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { migrate } from './migrations.js';

export interface Session { csrf: string; expiresAt: number }
export const opaque = () => randomBytes(32).toString('base64url');
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
/** Encrypted API sessions. Historical schema/data are retained, never replayed. */
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string, private key: Buffer) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec('PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=5000;');
    migrate(this.db);
  }
  seal(value: unknown, aad: string) {
    const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', this.key, iv); cipher.setAAD(Buffer.from(aad));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
  unseal<T>(value: string, aad: string): T {
    const b = Buffer.from(value, 'base64'); const decipher = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    decipher.setAAD(Buffer.from(aad)); decipher.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([decipher.update(b.subarray(28)), decipher.final()]).toString()) as T;
  }
  session(id: string, now: number): Session | undefined {
    const row = this.db.prepare('SELECT data, expires FROM sessions WHERE id=?').get(id) as {data: string; expires: number} | undefined;
    if (!row) return;
    if (row.expires <= now) { this.removeSession(id); return; }
    const session = this.unseal<Session>(row.data, `session:${id}`);
    // Only the session capability survives; retired credentials are never returned.
    return {csrf: session.csrf, expiresAt: session.expiresAt};
  }
  putSession(id: string, session: Session) {
    this.db.prepare('INSERT OR REPLACE INTO sessions VALUES(?,?,?)').run(id, session.expiresAt, this.seal({csrf:session.csrf,expiresAt:session.expiresAt}, `session:${id}`));
  }
  removeSession(id: string) {
    this.db.prepare('DELETE FROM sessions WHERE id=?').run(id);
  }
  close() { this.db.close(); }
}
