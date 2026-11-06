// Pure canonical permit/order encoding and local signature recovery. No signer,
// wallet client, RPC, persistence or submission. The gated server establishes
// snapshot provenance using same-block, reorg-checked read-only chain state.
import { Address as SdkAddress, Quote, QuoterRequest, type QuoterResponse, type PresetEnum } from '@1inch/fusion-sdk';
import { retainBuildEvidence, schemaShapes, type BuildStage } from './build-evidence.js';
import { z } from 'zod';
import { AppError } from '../server/config.js';
import { encodeAbiParameters, hashDomain, hashTypedData, recoverTypedDataAddress, zeroAddress, type Address, type Hex, type TypedData, type TypedDataDomain } from 'viem';
import { quoteResponse, type RawQuote } from './adapter.js';
import { evmAddress, positive, uint, SPENDER, quoteRequest, type QuoteRequest } from './policy.js';
import { withExactOrderDeadline } from './order-deadline.js';
import { MAX_SWAP_DEADLINE_SECONDS } from '../shared/swap-deadline.js';
import { assertPreparationFreshness, PreparationFailure } from './preparation-freshness.js';
export { MAX_SNAPSHOT_AGE_SECONDS } from './preparation-freshness.js';

export const MAX_PERMIT_LIFETIME_SECONDS = MAX_SWAP_DEADLINE_SECONDS;

export const MIN_PERMIT_LIFETIME_SECONDS = 30;
export const fusionPermitTokens = Object.freeze({
  USDC: Object.freeze({ address: '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', name: 'USD Coin', version: '2', decimals: 6 }),
  USDT0: Object.freeze({ address: '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', name: 'USDT0', version: '1', decimals: 6 }),
} as const);
const fields = Object.freeze([
  Object.freeze({ name: 'owner', type: 'address' }), Object.freeze({ name: 'spender', type: 'address' }),
  Object.freeze({ name: 'value', type: 'uint256' }), Object.freeze({ name: 'nonce', type: 'uint256' }),
  Object.freeze({ name: 'deadline', type: 'uint256' }),
] as const);
const seconds = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const bytes32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v => v.toLowerCase() as Hex);
const nonzeroHash = bytes32.refine(v => !/^0x0{64}$/.test(v));
const inputSchema = z.object({ chainId: z.literal(137), account: evmAddress, token: evmAddress, value: positive, deadline: seconds }).strict();
// account/chainId must describe the current wallet context, not merely an order
// supplied by a caller. DOMAIN_SEPARATOR and nonce must be read at this block.
const stateSchema = z.object({
  chainId: z.literal(137), account: evmAddress, token: evmAddress,
  nonce: uint, domainSeparator: bytes32, blockNumber: positive,
  blockHash: nonzeroHash, recheckedBlockHash: nonzeroHash, blockTimestamp: seconds,
}).strict();

export function prepareFusionPermit(input: unknown, onchainState: unknown, nowSeconds: number) {
  const now = seconds.parse(nowSeconds);
  const request = inputSchema.parse(input);
  const state = stateSchema.parse(onchainState);
  const token = Object.values(fusionPermitTokens).find(t => t.address === request.token);
  if (!token || BigInt(request.value) > 15_000n * 10n ** BigInt(token.decimals)) throw new Error('Unsupported permit token or excessive value');
  if (state.account !== request.account || state.token !== request.token) throw new Error('Permit account/token context changed');
  if (state.blockHash !== state.recheckedBlockHash) throw new PreparationFailure('FUSION_STATE_REORGANIZED', 'Polygon state changed during preparation. Preparation stopped.');
  assertPreparationFreshness(BigInt(state.blockTimestamp), now);
  if (request.deadline - now < MIN_PERMIT_LIFETIME_SECONDS || request.deadline - now > MAX_PERMIT_LIFETIME_SECONDS) throw new Error('Permit deadline must be short and finite');
  // Widen only the domain type: the runtime separator comparison below still
  // enforces the exact token-specific domain (salt OR chainId, never both).
  // Inferring the union of EIP712Domain tuples makes viem require both fields.
  const domain: Readonly<TypedDataDomain> = Object.freeze({ name: token.name, version: token.version, verifyingContract: token.address as Address,
    ...(token === fusionPermitTokens.USDT0 ? { salt: `0x${'0'.repeat(62)}89` as Hex } : { chainId: 137 }) });
  const EIP712Domain = token === fusionPermitTokens.USDT0 ? Object.freeze([
    Object.freeze({ name: 'name', type: 'string' }), Object.freeze({ name: 'version', type: 'string' }),
    Object.freeze({ name: 'verifyingContract', type: 'address' }), Object.freeze({ name: 'salt', type: 'bytes32' }),
  ] as const) : Object.freeze([
    Object.freeze({ name: 'name', type: 'string' }), Object.freeze({ name: 'version', type: 'string' }),
    Object.freeze({ name: 'chainId', type: 'uint256' }), Object.freeze({ name: 'verifyingContract', type: 'address' }),
  ] as const);
  const types: Readonly<TypedData> & { readonly Permit: typeof fields } = Object.freeze({ EIP712Domain, Permit: fields });
  if (hashDomain({ domain, types }) !== state.domainSeparator) throw new Error('Onchain permit domain separator mismatch');
  const typedData = Object.freeze({ domain, types, primaryType: 'Permit' as const,
    message: Object.freeze({ owner: request.account as Address, spender: SPENDER as Address,
      value: BigInt(request.value), nonce: BigInt(state.nonce), deadline: BigInt(request.deadline) }) });
  return Object.freeze({ typedData, digest: hashTypedData(typedData), snapshot: Object.freeze(state) });
}

// EIP-2612 seven ABI words, NOT a calldata selector or Permit2/EIP-2098.
// Deliberately accept only canonical 65-byte, low-s EOA signatures with v=27/28.
export async function encodeFusionPermit(input: unknown, onchainState: unknown, signature: unknown, nowSeconds: number) {
  const prepared = prepareFusionPermit(input, onchainState, nowSeconds);
  if (typeof signature !== 'string' || !/^0x[0-9a-fA-F]{128}(1b|1c)$/i.test(signature)) throw new Error('Canonical 65-byte permit signature required');
  const r = `0x${signature.slice(2, 66)}` as Hex;
  const s = `0x${signature.slice(66, 130)}` as Hex;
  const halfN = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;
  if (BigInt(r) === 0n || BigInt(s) === 0n || BigInt(s) > halfN) throw new Error('Noncanonical permit signature');
  const recovered = await recoverTypedDataAddress({ ...prepared.typedData, signature: signature as Hex });
  if (recovered.toLowerCase() !== prepared.typedData.message.owner) throw new Error('Permit signer mismatch');
  const { owner, spender, value, deadline } = prepared.typedData.message;
  const permit = encodeAbiParameters([
    { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' },
    { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' },
  ], [owner, spender, value, deadline, Number.parseInt(signature.slice(130), 16), r, s]);
  return Object.freeze({ ...prepared, permit });
}

// Actual pinned SDK construction from an exact detached executable quote.
// The caller is responsible for default-off configuration, trusted fresh state,
// durable nonce reservation and dispatch; this pure helper never transmits.
export async function buildLocalPermitOrder(requestInput: QuoteRequest, rawInput: RawQuote, onchainState: unknown, deadline: number, signature: unknown, nowSeconds: number, orderDeadline?: number, confirmedMinimumReceiveAmount?: string, minimumPolicy?: 'sdk-executable-v1', authorization: 'permit' | 'onchain-approval' = 'permit') {
  let stage:BuildStage='quote-input';
  try {
  const requestResult = quoteRequest.safeParse(requestInput);
  if (!requestResult.success) throw new AppError(502, 'FUSION_BUILD_INPUT', 'Invalid saved order input.');
  const request = requestResult.data;
  stage='quote-schema';
  const rawResult = quoteResponse.safeParse(rawInput); // detach before the first await
  if (!rawResult.success) {
    const error=new AppError(502, 'FUSION_BUILD_QUOTE_SCHEMA', 'Invalid saved executable quote schema.');
    retainBuildEvidence(error,stage,undefined,schemaShapes(rawInput,rawResult.error.issues));throw error;
  }
  const raw = rawResult.data;
  // Explicit v1 preparations review the SDK executable net AFTER the permit.
  // Slippage is sent to the official quoter; createFusionOrder consumes its
  // auctionEndAmount, not an endpoint that Harbor should discount a second time.
  // Missing policy is legacy: never reinterpret or lower its protected floor.
  stage='saved-floor';
  if (minimumPolicy !== undefined && (minimumPolicy !== 'sdk-executable-v1' || confirmedMinimumReceiveAmount !== undefined)) throw new AppError(502, 'FUSION_BUILD_SAVED_MINIMUM', 'Conflicting minimum policy.');
  const floorResult = confirmedMinimumReceiveAmount === undefined ? undefined : positive.safeParse(confirmedMinimumReceiveAmount);
  if (floorResult && !floorResult.success) {
    const error=new AppError(502, 'FUSION_BUILD_SAVED_MINIMUM', 'Invalid saved order minimum.');
    retainBuildEvidence(error,stage,'saved-floor-invalid');throw error;
  }
  const confirmedFloor = minimumPolicy === 'sdk-executable-v1' ? 1n : floorResult?.success ? BigInt(floorResult.data) : BigInt(raw.toTokenAmount) * BigInt(10000 - request.slippageBps) / 10000n;
  stage='quote-input';
  if (!raw.quoteId) throw new AppError(502, 'FUSION_BUILD_QUOTE_ID_MISSING', 'Executable saved quote ID required.');
  // SDK createOrder requires a provider quoteId before publication. Do not
  // synthesize one. Its whitelist codec accepts zero low-80-bit entries;
  // preserve them unchanged, without treating zero as a wildcard/eligibility.
  if (raw.fromTokenAmount !== request.amount) throw new AppError(502, 'FUSION_BUILD_QUOTE_AMOUNT_MISMATCH', 'Executable saved quote input amount mismatch.');
  stage='permit-encoding';
  if (authorization === 'onchain-approval' && request.tokenIn !== fusionPermitTokens.USDT0.address) throw new Error('Approval is USDT0-only');
  const prepared = authorization === 'permit' ? await encodeFusionPermit({ chainId: request.chainId, account: request.account, token: request.tokenIn, value: request.amount, deadline }, onchainState, signature, nowSeconds) : {permit: '0x' as Hex, digest: `0x${'0'.repeat(64)}` as Hex};
  stage='sdk-request';
  const params = QuoterRequest.new({
    fromTokenAddress: request.tokenIn, toTokenAddress: request.tokenOut, amount: request.amount,
    walletAddress: request.account, enableEstimate: true, isPermit2: false, ...(authorization === 'permit' ? {permit: prepared.permit} : {}), slippage: request.slippageBps / 100,
  });
  stage='sdk-create';
  const auctionOrder = new Quote(params, raw as QuoterResponse).createFusionOrder({ network: 137, preset: raw.recommended_preset as PresetEnum,
    receiver: new SdkAddress(request.account), allowPartialFills: false, allowMultipleFills: false, orderExpirationDelay: 0n });
  stage='sdk-deadline';
  const order = orderDeadline === undefined ? auctionOrder : withExactOrderDeadline(auctionOrder, orderDeadline, deadline, nowSeconds);
  stage='sdk-build';
  const built = order.build();
  stage='sdk-domain';
  const domain = order.getTypedData(137).domain;
  stage='sdk-net-output';
  const minimum = order.getUserReceiveAmount(new SdkAddress(zeroAddress), order.makingAmount, order.auctionEndTime, 0n);
  stage='local-validation';
  if (built.maker.toLowerCase() !== request.account || order.realReceiver.toString().toLowerCase() !== request.account)
    throw new AppError(502, 'FUSION_BUILD_PARTICIPANTS', 'Local order maker or receiver mismatch.');
  if (built.makerAsset.toLowerCase() !== request.tokenIn || built.takerAsset.toLowerCase() !== request.tokenOut || built.makingAmount !== request.amount)
    throw new AppError(502, 'FUSION_BUILD_INPUT', 'Local order assets or input amount mismatch.');
  if (domain.chainId !== 137 || String(domain.verifyingContract).toLowerCase() !== SPENDER)
    throw new AppError(502, 'FUSION_BUILD_DOMAIN', 'Local order signing domain mismatch.');
  if (order.partialFillAllowed || order.multipleFillsAllowed)
    throw new AppError(502, 'FUSION_BUILD_FILL_POLICY', 'Local order fill policy mismatch.');
  if (order.deadline <= BigInt(nowSeconds) || order.deadline > BigInt(deadline))
    throw new AppError(409, 'FUSION_BUILD_EXPIRY', 'Local order expiration is outside the approved bounds.');
  if (minimum <= 0n || minimum < confirmedFloor) {
    const error=new AppError(409, 'FUSION_BUILD_SAVED_MINIMUM', 'Local order net output is below the saved minimum.');
    retainBuildEvidence(error,stage,minimum<=0n?'net-output-nonpositive':'net-output-below-saved-floor',undefined,{floor:confirmedFloor,net:minimum,slippageBps:request.slippageBps});throw error;
  }
  const expected = authorization === 'permit' ? `${request.tokenIn}${prepared.permit.slice(2)}` : '0x';
  if (order.extension.makerPermit.toLowerCase() !== expected.toLowerCase()) throw new AppError(502, 'FUSION_BUILD_PERMIT', 'Local order permit encoding mismatch.');
  stage='sdk-extension';
  return Object.freeze({ order: Object.freeze(built), extension: order.extension.encode(), orderHash: order.getOrderHash(137),
    permit: prepared.permit, permitDigest: prepared.digest, deadline: order.deadline.toString(), minimumReceiveAmount: minimum.toString() });
  } catch(error) {retainBuildEvidence(error,stage);throw error;}
}
