import { z } from 'zod';

const fusionSessionSchema = z.object({ csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type FusionSession = z.infer<typeof fusionSessionSchema>;
let fusionSessionRequest: Promise<FusionSession> | null = null;
export function getFusionSession(): Promise<FusionSession> {
  if (!fusionSessionRequest) fusionSessionRequest = api<unknown>('/fusion/session')
    .then(value => fusionSessionSchema.parse(value)).finally(() => { fusionSessionRequest = null; });
  return fusionSessionRequest;
}
export class ApiError extends Error { constructor(public code: string, message: string, public status: number) { super(message); } }
export async function api<T>(path: string, session?: FusionSession | null, body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, { credentials: 'same-origin', method: body === undefined ? 'GET' : 'POST', headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json', 'X-CSRF-Token': session?.csrfToken ?? '' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(25000) });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(error?.code ?? 'UNAVAILABLE', error?.message ?? 'Harbor API is unavailable. Check that the backend is running and try again.', response.status);
  }
  return data as T;
}
