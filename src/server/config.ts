import { randomBytes } from 'node:crypto';

export type Environment = Record<string, string | undefined>;
export function loadConfig(env: Environment = process.env) {
  const namespace = env.HARBOR_SESSION_NAMESPACE;
  if (namespace !== undefined && namespace !== 'swap') throw new Error('HARBOR_SESSION_NAMESPACE must be swap when set');
  const origin = env.APP_ORIGIN || 'http://localhost:4173';
  const parsed = new URL(origin);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin || parsed.username || parsed.password) throw new Error('APP_ORIGIN must be an HTTP(S) origin');
  const secure = parsed.protocol === 'https:';
  if (!secure && (env.NODE_ENV === 'production' || !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) {
    throw new Error('HTTPS required except explicit loopback development');
  }

  const keyText = env.TOKEN_ENCRYPTION_KEY;
  const key = keyText ? Buffer.from(keyText, 'base64') : randomBytes(32);
  if (key.length !== 32 || (keyText && key.toString('base64') !== keyText)) throw new Error('TOKEN_ENCRYPTION_KEY must be canonical base64 encoding 32 bytes');
  return { origin, secure, key,
    durableSessions: Boolean(keyText && env.ONEINCH_API_KEY), dbPath: env.HARBOR_DB_PATH || '.data/harbor.sqlite',
    cookieName: namespace === 'swap' ? (secure ? '__Host-harbor-swap' : 'harbor_swap_dev') : (secure ? '__Host-harbor' : 'harbor_dev'), sessionTtl: 8 * 60 * 60_000 };
}
export type Config = ReturnType<typeof loadConfig>;
export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public retryAfter?: number) { super(message); }
}
