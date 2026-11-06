import { z } from 'zod';
import { isAddress, zeroAddress } from 'viem';
import { TOKENS, DIRECTIONS } from '../swap/registry.js';
import { AppError, type Environment } from '../server/config.js';

export const FUSION_BASE = 'https://api.1inch.com/fusion';
export const SETTLEMENT = '0x2ad5004c60e16e54d5007c80ce329adde5b51ef5';
export const SPENDER = '0x111111125421ca6dc452d289314280a0f8842a65';
export const executionEnabled = false as const; // Legacy unsigned-preview DTOs never acquire execution authority.
export const evmAddress = z.string().refine(v => isAddress(v, { strict: false }) && v.toLowerCase() !== zeroAddress).transform(v => v.toLowerCase());
const isUint = (v:string) => /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 2n ** 256n;
export const uint = z.string().refine(isUint);
export const positive = uint.refine(v => isUint(v) && BigInt(v) > 0n);
export const quoteRequest = z.object({
  chainId: z.literal(137), account: evmAddress, tokenIn: evmAddress, tokenOut: evmAddress,
  amount: positive, slippageBps: z.number().int().min(1).max(2000),
}).strict().superRefine((v, ctx) => {
  if (!DIRECTIONS.some(([a,b]) => a.address.toLowerCase() === v.tokenIn && b.address.toLowerCase() === v.tokenOut)) ctx.addIssue({code:'custom', message:'Canonical Polygon direction required'});
  const token = Object.values(TOKENS).find(t => t.address.toLowerCase() === v.tokenIn);
  if (token && isUint(v.amount) && BigInt(v.amount) > 15_000n * 10n ** BigInt(token.decimals)) ctx.addIssue({code:'custom', message:'Preview amount exceeds limit'});
});
export type QuoteRequest = z.infer<typeof quoteRequest>;
export function fusionConfig(env: Environment = process.env) {
  if (env.FUSION_API_URL || env.FUSION_BASE_URL) throw new Error('Fusion endpoint is fixed');
  if(env.FUSION_EXECUTION_ENABLED!==undefined && !['false','true'].includes(env.FUSION_EXECUTION_ENABLED))throw new Error('FUSION_EXECUTION_ENABLED must be true or false');
  const enabled=env.FUSION_EXECUTION_ENABLED==='true';
  if(enabled) {
    if(!env.ONEINCH_API_KEY || !env.TOKEN_ENCRYPTION_KEY || !env.APP_ORIGIN?.startsWith('https://') || !env.POLYGON_RPC_URL)throw new Error('Execution requires explicit HTTPS origin, credential, encrypted durable journal and Polygon RPC');
    const rpc=new URL(env.POLYGON_RPC_URL);
    if(rpc.protocol!=='https:' || rpc.username || rpc.password || rpc.hash)throw new Error('Execution RPC requires HTTPS without URL credentials or fragment');
  }
  const apiKey = env.ONEINCH_API_KEY || '';
  if (apiKey && (!/^[\x21-\x7e]{1,4096}$/.test(apiKey))) throw new Error('Invalid Fusion server credential format');
  return {apiKey, configured: Boolean(apiKey), executionEnabled:enabled, rpcUrl:env.POLYGON_RPC_URL};
}
export function executionBlocked(): never {
  throw new AppError(403, 'FUSION_EXECUTION_DISABLED', 'Mainnet orders, signatures, approvals, permits, cancellation and spending are disabled.');
}
export const capability = Object.freeze({
  executionEnabled, chainId: 137, mode: 'unsigned-preview', gaslessSettlement: 'resolver-paid-if-filled',
  allowance: 'unknown-readiness-not-verified', permitSupport: 'unverified-disabled',
  zeroAllowanceGasless: false, signingPayload: null,
});
