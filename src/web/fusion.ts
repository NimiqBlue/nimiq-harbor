import { z } from 'zod';
import { api, ApiError, getFusionSession } from './api';
import { MAX_AUTO_SLIPPAGE_BPS } from '../shared/auto-slippage';
import { fusionNetFloor } from '../shared/fusion-net-output';

const safety = {
  executionEnabled: z.literal(false), chainId: z.literal(137), mode: z.literal('unsigned-preview'),
  signingPayload: z.null(), zeroAllowanceGasless: z.literal(false), permitSupport: z.literal('unverified-disabled'),
};
const statusSchema = z.union([
  z.object({ configured: z.boolean(), available: z.boolean(), ...safety }),
  z.object({ configured: z.literal(true), available: z.literal(true), executionEnabled: z.literal(true), chainId: z.literal(137), mode: z.literal('gasless-execution'), signingPayload: z.null(), zeroAllowanceGasless: z.literal(true), permitSupport: z.literal('native-eip2612') }),
]);
const requestSchema = z.object({ chainId: z.literal(137), account: z.string(), tokenIn: z.string(), tokenOut: z.string(), amount: z.string(), slippageBps: z.number() });
const positive = z.string().regex(/^[1-9][0-9]{0,77}$/);
const previewSchema = z.object({
  ...safety, id: z.string().uuid(), request: requestSchema, expiresAt: z.number().finite(),
  autoSlippage:z.literal(true).optional(),
  state: z.literal('quoted-preview'), settlementVerified: z.literal(false), build: z.null(),
  quote: z.object({ preset: z.enum(['fast', 'medium', 'slow']), expectedAmount: positive, tokenFee: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).optional(), bankFee: z.string().regex(/^(0|[1-9][0-9]{0,77})$/).optional(), minimumReceiveAmount: positive.optional(), auctionStartAmount: positive, auctionEndAmount: positive, auctionDuration: z.number().int().positive(), providerFeeBps:z.number().int().min(0).max(1000).optional(), executableEstimate:z.boolean().optional() }),
});
export type FusionStatus = z.infer<typeof statusSchema>;
export type FusionPreview = z.infer<typeof previewSchema>;
export type FusionRequest = z.infer<typeof requestSchema>;
export type FusionQuoteRequest = FusionRequest & {autoSlippage?:boolean};
export async function getFusionStatus(): Promise<FusionStatus> {
  return statusSchema.parse(await api<unknown>('/fusion/status'));
}
export async function getFusionQuote(request: FusionQuoteRequest): Promise<FusionPreview> {
  const session = await getFusionSession();
  return validateFusionPreview(await api<unknown>('/fusion/quotes', session, { ...request, clientRequestId: crypto.randomUUID() }),request);
}
export function validateFusionPreview(raw: unknown, request: FusionQuoteRequest, now = Date.now()): FusionPreview {
  const preview = previewSchema.parse(raw);
  const q = preview.quote;
  // Old previews may be displayed, but cannot enable Review without net evidence.
  if (q.minimumReceiveAmount !== undefined || q.tokenFee !== undefined || q.bankFee !== undefined) {
    if (q.minimumReceiveAmount === undefined || q.tokenFee === undefined || q.bankFee === undefined || fusionNetFloor(q.expectedAmount,preview.request.slippageBps,q.tokenFee,q.bankFee) !== BigInt(q.minimumReceiveAmount)) throw new Error('Invalid net quote economics');
  }
  if (Boolean(preview.autoSlippage) !== Boolean(request.autoSlippage) || Object.entries(request).some(([key, value]) => {
    if (key === 'autoSlippage') return Boolean(preview.autoSlippage) !== Boolean(value);
    if (key === 'slippageBps' && request.autoSlippage) return !preview.autoSlippage || !Number.isInteger(preview.request.slippageBps) || preview.request.slippageBps < 1 || preview.request.slippageBps > MAX_AUTO_SLIPPAGE_BPS;
    const actual = preview.request[key as keyof FusionRequest];
    return typeof value === 'string' ? value.toLowerCase() !== String(actual).toLowerCase() : value !== actual;
  }) || preview.expiresAt <= now || preview.expiresAt > now + 35_000) throw new Error('Invalid Fusion preview');
  return preview;
}
export function fusionUnavailable(error: unknown): string {
  if (error instanceof ApiError && error.code === 'FUSION_AUTO_SLIPPAGE_UNAVAILABLE') return 'Auto is unavailable within the 1% limit. Try a larger amount or choose a manual limit below. We won’t increase it automatically.';
  return error instanceof ApiError && error.status === 403
    ? 'Gasless quotes unavailable in this preview. Nothing will be signed or sent.'
    : 'Gasless quotes unavailable. Try again later. Nothing will be signed or sent.';
}
