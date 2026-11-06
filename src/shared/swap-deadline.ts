import { z } from 'zod';

// Explicit user-selected spending-authority policy, not a provider auction TTL.
// No coercion, clamping or extension on wallet return/publication.
export const DEFAULT_SWAP_DEADLINE_MINUTES = 15;
export const MIN_SWAP_DEADLINE_MINUTES = 1;
export const MAX_SWAP_DEADLINE_MINUTES = 60;
export const MAX_SWAP_DEADLINE_SECONDS = MAX_SWAP_DEADLINE_MINUTES * 60;
export const swapDeadlineMinutesSchema = z.number().int().min(MIN_SWAP_DEADLINE_MINUTES).max(MAX_SWAP_DEADLINE_MINUTES);
export const fixedSwapDeadlineMinutesSchema = z.literal(DEFAULT_SWAP_DEADLINE_MINUTES);
export function swapOrderDeadline(createdAt: number, minutes: number) {
  if (!Number.isSafeInteger(createdAt) || createdAt <= 0) throw new Error('Invalid preparation timestamp');
  return Math.floor(createdAt / 1000) + swapDeadlineMinutesSchema.parse(minutes) * 60;
}
