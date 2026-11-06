import { z } from 'zod';

export const publicHash = z.string().regex(/^0x[0-9a-f]{64}$/);
export const publicOrderStatusSchema = z.object({
  orderHash: publicHash,
  status: z.enum(['pending', 'unknown']),
  transactionHash: publicHash.nullable(),
}).strict();
// Only a public hash is accepted. Never look up private execution/session IDs.
export function sanitizePublicOrderStatus(raw: unknown, orderHash: string) {
  publicHash.parse(orderHash);
  const hint = z.object({ orderHash: publicHash.optional(), status: z.string().max(100), fills: z.array(z.object({txHash: publicHash})).max(1) }).parse(raw);
  if (hint.orderHash && hint.orderHash !== orderHash) throw new Error('Public order mismatch');
  return publicOrderStatusSchema.parse({ orderHash, status: hint.status === 'pending' ? 'pending' : 'unknown', transactionHash: hint.fills[0]?.txHash ?? null });
}
