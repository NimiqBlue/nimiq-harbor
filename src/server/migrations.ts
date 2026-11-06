import type { DatabaseSync } from 'node:sqlite';
/** Append-only schema versions; never downgrade a database after rollback. */
export const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, expires INTEGER NOT NULL, data TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS intents (id TEXT PRIMARY KEY, session TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
   CREATE INDEX IF NOT EXISTS intents_session ON intents(session);`,
  `CREATE TABLE IF NOT EXISTS iban_requests (profile TEXT PRIMARY KEY, status TEXT NOT NULL);`,
] as const;
export function migrate(db: DatabaseSync) {
  const version = Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
  if (version > MIGRATIONS.length) throw new Error('Database schema is newer than this Harbor build. Refusing downgrade.');
  for (let i=version;i<MIGRATIONS.length;i++) {
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(MIGRATIONS[i]!); db.exec(`PRAGMA user_version=${i+1}`); db.exec('COMMIT'); }
    catch(error) { db.exec('ROLLBACK'); throw error; }
  }
}
