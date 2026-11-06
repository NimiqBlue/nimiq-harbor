import { Address as SdkAddress, Extension, FusionExtension, FusionOrder, MakerTraits } from '@1inch/fusion-sdk';
import { z } from 'zod';
import { createPublicClient, encodeAbiParameters, hashDomain, hashTypedData, http, parseAbi, recoverTypedDataAddress, zeroAddress, type Address, type Hex, type TypedData } from 'viem';
import { polygon } from 'viem/chains';
import { TOKENS } from '../swap/registry';
import { diagnosticPermit, permitDefinitions, PERMIT_RPC, type PermitToken } from './permit-diagnostic';
import { api, getFusionSession } from './api';
import { authorizedAccount, type HarborProvider } from './wallet';
import type { FusionRequest } from './fusion';
import { DEFAULT_SWAP_DEADLINE_MINUTES, MAX_SWAP_DEADLINE_SECONDS, fixedSwapDeadlineMinutesSchema, swapDeadlineMinutesSchema, swapOrderDeadline } from '../shared/swap-deadline';

export const FUSION_SPENDER = '0x111111125421ca6dc452d289314280a0f8842a65';
const SETTLEMENT = '0x2ad5004c60e16e54d5007c80ce329adde5b51ef5';
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/).transform(s => s.toLowerCase() as Address);
const uint = z.string().refine(s => /^(0|[1-9][0-9]{0,77})$/.test(s) && BigInt(s) < 2n ** 256n);
const positive = uint.refine(s => uint.safeParse(s).success && BigInt(s) > 0n);
const hash = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(s => s.toLowerCase() as Hex);
const seconds = z.number().int().positive().safe();
export const executionRequestSchema = z.object({ chainId: z.literal(137), account: address, tokenIn: address, tokenOut: address, amount: positive, slippageBps: z.number().int().min(1).max(2000) }).strict().superRefine((v, ctx) => {
  const tokens = Object.values(TOKENS);
  const input = tokens.find(t => t.address.toLowerCase() === v.tokenIn);
  if (v.account === zeroAddress || !input || !tokens.some(t => t.address.toLowerCase() === v.tokenOut) || v.tokenIn === v.tokenOut || (input && uint.safeParse(v.amount).success && BigInt(v.amount) > 15_000n * 10n ** BigInt(input.decimals))) ctx.addIssue({ code: 'custom', message: 'Canonical bounded swap required' });
});
const executionState = z.enum(['prepared', 'approval-pending', 'approval-confirmed', 'permit-exposed', 'built', 'submitting', 'pending', 'unknown', 'filled', 'expired', 'cancelled', 'failed']);
// Known sanitized executionView metadata. Strict objects still reject arbitrary
// typedData/signature additions; these fields match the real server serializer.
const viewMetadata = {
  authorization:z.literal('onchain-approval').optional(), approvalTransactionHash:hash.optional(),
  minimumPolicy: z.literal('sdk-executable-v1').optional(), previewMinimumReceiveAmount: positive.optional(),
  buildOutcome: z.literal('minimum-unavailable-not-published').optional(),
  confirmedMinimumReceiveAmount: positive.optional(), previewId: z.string().uuid().optional(),
  deadlineMinutes: swapDeadlineMinutesSchema.optional(), orderDeadline: seconds.optional(),
  account: address.optional(), clientRequestId: z.string().uuid().optional(),
  state: executionState.optional(), settlementVerified: z.literal(false).optional(),
  orderHash: hash.nullable().optional(), createdAt: seconds.optional(),
  minimumReceiveAmount: positive.nullable().optional(), deadline: seconds.nullable().optional(),
  providerStatus: z.string().max(100).nullable().optional(), transactionHash: hash.nullable().optional(),
};
export const preparedSchema = z.object({ ...viewMetadata, id: z.string().uuid(), request: executionRequestSchema, permit: z.object({ nonce: uint, deadline: seconds }).strict(), expiresAt: seconds }).strict();
export type PreparedExecution = z.infer<typeof preparedSchema>;
export const builtSchema = z.object({ ...viewMetadata, permit: z.object({ nonce: uint, deadline: seconds }).strict().optional(), id: z.string().uuid(), request: executionRequestSchema, order: z.object({ salt: uint, maker: address, receiver: address, makerAsset: address, takerAsset: address, makingAmount: positive, takingAmount: positive, makerTraits: uint }).strict(), extension: z.string().regex(/^0x(?:[0-9a-fA-F]{2})+$/).max(32768), orderHash: hash, minimumReceiveAmount: positive, deadline: seconds, expiresAt: seconds }).strict();
export type BuiltExecution = z.infer<typeof builtSchema>;
export const executionStatusSchema = z.object({ ...viewMetadata, request: executionRequestSchema.optional(), permit: z.object({ nonce: uint, deadline: seconds }).strict().optional(), expiresAt: seconds.optional(), id: z.string().uuid(), account: address, orderHash: hash.nullable().optional(), state: executionState, settlementVerified: z.boolean() }).strict().refine(v => !v.buildOutcome || (!v.orderHash && !v.settlementVerified && ['permit-exposed','expired'].includes(v.state))).refine(v => !v.settlementVerified || (v.state === 'filled' && Boolean(v.orderHash) && Boolean(v.transactionHash)));
export type ExecutionStatus = z.infer<typeof executionStatusSchema>;
export function sameRequest(a: FusionRequest, b: FusionRequest) { return JSON.stringify(executionRequestSchema.parse(a)) === JSON.stringify(executionRequestSchema.parse(b)); }
export function validatePrepared(raw: unknown, request: FusionRequest, now = Date.now(), expectedDeadlineMinutes?: number, allowApproval = false) {
  if (expectedDeadlineMinutes !== undefined) fixedSwapDeadlineMinutesSchema.parse(expectedDeadlineMinutes);
  const p = preparedSchema.parse(raw);
  if(p.authorization && !allowApproval)throw new Error('On-chain approval required; token permit signing is forbidden');
  if (p.minimumPolicy && (p.confirmedMinimumReceiveAmount !== undefined || !p.previewId || !p.previewMinimumReceiveAmount || p.orderDeadline === undefined)) throw new Error('Conflicting or incomplete executable minimum policy');
  if (!p.minimumPolicy && p.previewMinimumReceiveAmount !== undefined) throw new Error('Unbound indicative minimum');
  if(p.authorization) {
    if(p.request.tokenIn!==TOKENS.USDT.address.toLowerCase() || p.state!=='prepared' || !p.createdAt || !p.orderDeadline || !p.deadlineMinutes || (expectedDeadlineMinutes!==undefined && p.deadlineMinutes!==expectedDeadlineMinutes) || p.orderDeadline!==swapOrderDeadline(p.createdAt,p.deadlineMinutes) || p.expiresAt!==p.orderDeadline*1000 || p.expiresAt<=now+30_000 || p.expiresAt>now+MAX_SWAP_DEADLINE_SECONDS*1000 || p.orderHash!=null || !sameRequest(p.request,request) || (p.account && p.account!==request.account))throw new Error('Unsafe approval preparation');
    return p; // No token permit nonce/domain/deadline policy in this mode.
  }
  if (expectedDeadlineMinutes !== undefined && (p.deadlineMinutes !== swapDeadlineMinutesSchema.parse(expectedDeadlineMinutes) || p.orderDeadline === undefined)) throw new Error('Selected order deadline missing or changed');
  if (p.orderDeadline !== undefined || p.deadlineMinutes !== undefined) {
    if (p.createdAt === undefined || p.orderDeadline === undefined || p.deadlineMinutes === undefined || p.orderDeadline !== swapOrderDeadline(p.createdAt,p.deadlineMinutes) || p.permit.deadline !== p.orderDeadline || p.expiresAt !== p.orderDeadline*1000) throw new Error('Order/permit deadline is not bound to preparation');
  }
  // Legacy preparations have no immutable selection metadata: retain their old
  // ten-minute ceiling rather than treating the new default as historical intent.
  const maxLifetimeMs = (p.orderDeadline === undefined ? 600 : MAX_SWAP_DEADLINE_SECONDS) * 1000;
  if (p.buildOutcome || (p.account && p.account !== p.request.account) || (p.state && p.state !== 'prepared') || (p.orderHash != null) || !sameRequest(p.request, request) || p.expiresAt <= now || p.expiresAt > now + maxLifetimeMs || p.permit.deadline * 1000 < now + 30_000 || p.permit.deadline * 1000 > now + maxLifetimeMs) throw new Error('Unsafe or expired preparation');
  return p;
}
export function executionPermit(p: PreparedExecution) {
  if(p.authorization)throw new Error('Approval execution must never request a permit');
  const token = (Object.keys(permitDefinitions) as PermitToken[]).find(k => permitDefinitions[k].address.toLowerCase() === p.request.tokenIn.toLowerCase());
  if (!token) throw new Error('Unsupported permit');
  // Reconstruct locally, including the stored USDT0 salt and no chainId field.
  const data = diagnosticPermit(token, p.request.account, BigInt(p.permit.nonce));
  return { domain: data.domain as import('viem').TypedDataDomain, types: data.types as TypedData, primaryType: 'Permit' as const, message: { ...data.message, spender: FUSION_SPENDER as Address, value: p.request.amount, deadline: String(p.permit.deadline) } };
}
export function encodeExecutionPermit(p: PreparedExecution, signature: Hex) {
  assertSignature(signature);
  return encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint8' }, { type: 'bytes32' }, { type: 'bytes32' }], [p.request.account, FUSION_SPENDER, BigInt(p.request.amount), BigInt(p.permit.deadline), Number.parseInt(signature.slice(130), 16), `0x${signature.slice(2,66)}`, `0x${signature.slice(66,130)}`]);
}
function assertSignature(signature: unknown): asserts signature is Hex {
  if (typeof signature !== 'string' || !/^0x[0-9a-f]{128}(1b|1c)$/i.test(signature) || BigInt(`0x${signature.slice(2,66)}`) === 0n || BigInt(`0x${signature.slice(66,130)}`) === 0n || BigInt(`0x${signature.slice(66,130)}`) > 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n) throw new Error('Invalid canonical wallet signature');
}
const client = createPublicClient({ chain: polygon, transport: http(PERMIT_RPC, { timeout: 12000, retryCount: 0, fetchOptions: { redirect: 'error', credentials: 'omit' } }) });
const abi = parseAbi(['function DOMAIN_SEPARATOR() view returns(bytes32)', 'function nonces(address) view returns(uint256)', 'function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)']);
export async function checkExecutionPermit(p: PreparedExecution, guard: () => Promise<void>) {
  validatePrepared(p, p.request);
  await guard();
  if (await client.getChainId() !== 137) throw new Error('Polygon RPC required');
  const block = await client.getBlock();
  if (Math.abs(Date.now()/1000 - Number(block.timestamp)) > 60) throw new Error('Stale Polygon block');
  const [nonce, separator, balance, allowance] = await Promise.all([
    client.readContract({ address: p.request.tokenIn, abi, functionName: 'nonces', args: [p.request.account], blockNumber: block.number }),
    client.readContract({ address: p.request.tokenIn, abi, functionName: 'DOMAIN_SEPARATOR', blockNumber: block.number }),
    client.readContract({ address: p.request.tokenIn, abi, functionName: 'balanceOf', args: [p.request.account], blockNumber: block.number }),
    client.readContract({ address: p.request.tokenIn, abi, functionName: 'allowance', args: [p.request.account, FUSION_SPENDER], blockNumber: block.number }),
  ]);
  const data = executionPermit(p);
  if (nonce !== BigInt(p.permit.nonce) || hashDomain({ domain: data.domain, types: data.types as TypedData }) !== separator || balance < BigInt(p.request.amount) || allowance !== 0n) throw new Error('Permit nonce, domain, balance or zero allowance changed');
  if ((await client.getBlock({ blockNumber: block.number })).hash !== block.hash) throw new Error('Polygon block reorganized');
  await guard();
}
export function validateBuilt(raw: unknown, p: PreparedExecution, permit: Hex, confirmedFloor: bigint, now = Date.now()) {
  const b = builtSchema.parse(raw);
  if(b.authorization!==p.authorization || (p.authorization && (p.request.tokenIn!==TOKENS.USDT.address.toLowerCase() || !p.approvalTransactionHash || b.approvalTransactionHash!==p.approvalTransactionHash)))throw new Error('Authorization mode or approval transaction changed');
  if (b.minimumPolicy !== p.minimumPolicy || (p.minimumPolicy && (p.confirmedMinimumReceiveAmount !== undefined || b.confirmedMinimumReceiveAmount !== undefined || !p.previewMinimumReceiveAmount || b.previewMinimumReceiveAmount !== p.previewMinimumReceiveAmount || b.previewId !== p.previewId))) throw new Error('Executable minimum policy changed');
  if (!p.minimumPolicy && b.previewMinimumReceiveAmount !== undefined) throw new Error('Unbound indicative minimum');
  if (p.confirmedMinimumReceiveAmount !== undefined && (BigInt(p.confirmedMinimumReceiveAmount) !== confirmedFloor || b.confirmedMinimumReceiveAmount !== p.confirmedMinimumReceiveAmount || b.previewId !== p.previewId)) throw new Error('Reviewed net minimum changed');
  if (p.orderDeadline !== undefined && (b.orderDeadline !== p.orderDeadline || b.deadlineMinutes !== p.deadlineMinutes || b.deadline !== p.orderDeadline)) throw new Error('Built order changed the selected deadline');
  const authorizedDeadline=p.authorization ? p.orderDeadline! : p.permit.deadline;
  if (b.buildOutcome || (b.account && b.account !== p.request.account) || (b.clientRequestId && p.clientRequestId && b.clientRequestId !== p.clientRequestId) || (b.state && b.state !== 'built') || (!p.authorization && b.permit && (b.permit.nonce !== p.permit.nonce || b.permit.deadline !== p.permit.deadline)) || b.id !== p.id || !sameRequest(b.request, p.request) || b.expiresAt <= now || b.expiresAt > authorizedDeadline*1000 || b.deadline*1000 <= now || b.deadline > authorizedDeadline) throw new Error('Stale or mismatched order');
  const extension = Extension.decode(b.extension);
  const decoded = FusionExtension.fromExtension(extension);
  const traits = new MakerTraits(BigInt(b.order.makerTraits));
  if (decoded.address.toString().toLowerCase() !== SETTLEMENT || extension.makerPermit.toLowerCase() !== (p.authorization ? '0x' : `${p.request.tokenIn}${permit.slice(2)}`.toLowerCase()) || extension.preInteraction !== '0x' || decoded.extra?.chainedPostInteraction || traits.isPermit2() || traits.isNativeUnwrapEnabled()) throw new Error('Unexpected order interaction');
  const order = FusionOrder.fromDataAndExtension(b.order, extension);
  const rebuilt = order.build();
  if (Object.entries(b.order).some(([k,v]) => String(rebuilt[k as keyof typeof rebuilt]).toLowerCase() !== String(v).toLowerCase()) || order.extension.encode().toLowerCase() !== b.extension.toLowerCase()) throw new Error('SDK order roundtrip mismatch');
  const data = order.getTypedData(137);
  const minimum = order.getUserReceiveAmount(new SdkAddress(zeroAddress), order.makingAmount, order.auctionEndTime, 0n);
  if (order.maker.toString().toLowerCase() !== p.request.account || order.realReceiver.toString().toLowerCase() !== p.request.account || order.makerAsset.toString().toLowerCase() !== p.request.tokenIn || order.takerAsset.toString().toLowerCase() !== p.request.tokenOut || order.makingAmount !== BigInt(p.request.amount) || order.partialFillAllowed || order.multipleFillsAllowed || order.deadline !== BigInt(b.deadline) || (p.orderDeadline === undefined ? order.auctionEndTime !== order.deadline : order.auctionEndTime > order.deadline) || order.getOrderHash(137).toLowerCase() !== b.orderHash || minimum !== BigInt(b.minimumReceiveAmount) || (!p.minimumPolicy && minimum < confirmedFloor) || minimum <= 0n || data.domain.name !== '1inch Aggregation Router' || data.domain.version !== '6' || data.domain.chainId !== 137 || String(data.domain.verifyingContract).toLowerCase() !== FUSION_SPENDER) throw new Error('Unsafe SDK order');
  // Return only SDK-derived canonical typed data; no arbitrary server typedData.
  return { built: b, typedData: data, minimum };
}
async function boundedWalletRead<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([read, new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error('Wallet read timed out')),15_000); })]); }
  finally { clearTimeout(timer); }
}
export async function walletGuard(provider: HarborProvider, account: Address, isCurrent: () => boolean) {
  if (!isCurrent()) throw new Error('Wallet selection or swap changed');
  const [accounts, chain] = await boundedWalletRead(Promise.all([provider.request({ method: 'eth_accounts' }), provider.request({ method: 'eth_chainId' })]));
  if (!isCurrent() || !authorizedAccount(accounts, account) || typeof chain !== 'string' || !/^0x[0-9a-f]+$/i.test(chain) || Number.parseInt(chain,16) !== 137) throw new Error('Wallet account or network changed');
}
// Only a rejection of the physical signature RPC can mint this evidence.
// Guard/preflight failures, timeout, returned-but-invalid bytes or later failures
// are ambiguous; none may clear the permit-requested high-water journal.
export class WalletSignatureRejected extends Error {
  constructor() { super('Wallet explicitly rejected the signature request'); }
}
function explicitWalletRejection(error:unknown) {
  if(!error || typeof error!=='object')return false;
  const e=error as {code?:unknown;data?:{originalError?:{code?:unknown}}};
  return e.code===4001 || (e.code===-32603 && e.data?.originalError?.code===4001);
}
export async function signExecution(provider: HarborProvider, account: Address, data: Parameters<typeof hashTypedData>[0], guard: () => Promise<void>) {
  await guard();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let signature: unknown;
  try {
    const walletReply=Promise.resolve().then(() => provider.request({ method: 'eth_signTypedData_v4', params: [account, JSON.stringify(data, (_k,v: unknown) => typeof v === 'bigint' ? String(v) : v)] })).catch((error:unknown) => { if(explicitWalletRejection(error))throw new WalletSignatureRejected();throw error; });
    signature = await Promise.race([walletReply, new Promise<never>((_resolve,reject) => { timer = setTimeout(() => reject(new Error('Wallet response timed out. No automatic retry.')), 120_000); })]);
  } finally { clearTimeout(timer); }
  assertSignature(signature); await guard();
  if ((await recoverTypedDataAddress({ ...data, signature })).toLowerCase() !== account.toLowerCase()) throw new Error('Wallet signature owner mismatch');
  return signature;
}
async function post(path: string, body: unknown) { return api<unknown>(path, await getFusionSession(), body); }
export const executionApi = {
  prepare: (request: FusionRequest, clientRequestId: string, deadlineMinutes = DEFAULT_SWAP_DEADLINE_MINUTES, review?: {previewId:string;minimumReceiveAmount:string;minimumPolicy?:'sdk-executable-v1'}) => post('/fusion/execution/prepare', { ...request, clientRequestId, deadlineMinutes: fixedSwapDeadlineMinutesSchema.parse(deadlineMinutes), ...review }),
  cancelUnsigned: (id: string, clientRequestId: string) => post(`/fusion/execution/${id}/cancel-unsigned`, {clientRequestId,reason:'wallet-rejected-before-signature'}),
  cancellation: (id: string) => api<unknown>(`/fusion/execution/${id}/cancel-unsigned`),
  build: (id: string, permitSignature: Hex) => post(`/fusion/execution/${id}/build`, { permitSignature }),
  submit: (id: string, orderSignature: Hex) => post(`/fusion/execution/${id}/submit`, { orderSignature }),
  status: (id: string) => api<unknown>(`/fusion/execution/${id}`),
  reconcile: (id: string) => post(`/fusion/execution/${id}/reconcile`, {}),
  ownershipChallenge: (account: Address) => post('/fusion/execution/ownership/challenge', { account }),
  ownershipRecover: (challengeId: string, signature: Hex) => post('/fusion/execution/ownership/recover', { challengeId, signature }),
  recover: (clientRequestId: string, account: Address) => post('/fusion/execution/recover', { clientRequestId, account }),
};

// This non-spending recovery proof is reconstructed locally. The session hash
// is an opaque server binding, never an arbitrary typed-data domain or method.
export function validateRecoveryChallenge(raw: unknown, account: Address, origin: string, now = Date.now()) {
  const fields = [{name:'account',type:'address'},{name:'session',type:'bytes32'},{name:'origin',type:'string'},{name:'challenge',type:'string'},{name:'deadline',type:'uint256'}] as const;
  const value=z.object({challengeId:z.string().regex(/^[0-9a-f]{32}$/),expiresAt:seconds,typedData:z.object({domain:z.object({name:z.literal('Harbor execution recovery'),version:z.literal('1'),chainId:z.literal(137)}).strict(),primaryType:z.literal('Recovery'),types:z.object({Recovery:z.array(z.object({name:z.string(),type:z.string()}).strict())}).strict(),message:z.object({account:address,session:hash,origin:z.string(),challenge:z.string(),deadline:uint}).strict()}).strict()}).strict().parse(raw);
  const m=value.typedData.message;
  if(value.expiresAt<=now || value.expiresAt>now+120_000 || m.account!==account.toLowerCase() || m.origin!==origin || m.challenge!==value.challengeId || m.deadline!==String(Math.floor(value.expiresAt/1000)) || JSON.stringify(value.typedData.types.Recovery)!==JSON.stringify(fields)) throw new Error('Unsafe recovery proof');
  return {challengeId:value.challengeId,expiresAt:value.expiresAt,typedData:{domain:{name:'Harbor execution recovery',version:'1',chainId:137},primaryType:'Recovery' as const,types:{Recovery:fields},message:{account:account.toLowerCase() as Address,session:m.session,origin,challenge:value.challengeId,deadline:m.deadline}}};
}
export const recoveredExecutionsSchema = z.object({executions:z.array(executionStatusSchema).max(100)}).strict();
export const EXECUTION_JOURNAL_KEY = 'harbor:fusion:pending:v1';
export const publicRecoveryEvidenceSchema = z.object({ request: executionRequestSchema, permit: z.object({nonce:uint,deadline:seconds}).strict(), order: z.object({orderHash:hash,nonce:uint,minimumReceiveAmount:positive,deadline:seconds}).strict().optional() }).strict().refine(v => !v.order || v.order.deadline <= v.permit.deadline);
export function recoveryOrderEvidence(b: BuiltExecution) {
  const order=FusionOrder.fromDataAndExtension(b.order,Extension.decode(b.extension));
  if(!order.isBitInvalidatorMode) throw new Error('Unsupported order invalidator');
  return {orderHash:b.orderHash,nonce:String(order.nonce),minimumReceiveAmount:b.minimumReceiveAmount,deadline:b.deadline};
}
const journalSchema = z.object({ buildOutcome: z.literal('minimum-unavailable-not-published').optional(), reviewExited: z.boolean().optional(), version: z.literal(1), account: address, clientRequestId: z.string().uuid(), id: z.string().uuid().optional(), orderHash: hash.optional(), state: z.enum(['preparing','prepared','permit-requested','permit-exposed','built','order-requested','submitting','pending','unknown','filled','expired','cancelled','failed']), updatedAt: seconds, permitRequested: z.boolean().optional(), publicRecovery: publicRecoveryEvidenceSchema.optional() }).strict().refine(j => (!j.buildOutcome || (!j.orderHash && ['permit-exposed','expired'].includes(j.state) && j.permitRequested===true)) && (!j.reviewExited || Boolean(j.buildOutcome) || (Boolean(j.orderHash) && j.permitRequested===true))).refine(j => !j.publicRecovery || (j.publicRecovery.request.account === j.account && (!j.orderHash || j.publicRecovery.order?.orderHash === j.orderHash)));
export type ExecutionJournal = z.infer<typeof journalSchema>;
// The server's prepared state cannot prove a wallet never returned a signature.
// Only our write-ahead local evidence permits discarding; missing legacy evidence
// is unknown. Status recovery must never reset this monotonic exposure latch.
// A persisted ID is identity, not signature exposure: explicit local false is
// sufficient in preparing too. Retain only the existing no-ID legacy exception.
export function canDiscardUnsigned(j: ExecutionJournal | null): boolean {
  return Boolean(j && !j.buildOutcome && !j.orderHash && !j.publicRecovery?.order && j.permitRequested !== true &&
    ((j.state === 'preparing' && !j.id) || (['preparing', 'prepared'].includes(j.state) && j.permitRequested === false)));
}
// Cosmetic exit only. Never changes exposure, authority, order identity or reservation.
export function canExitProtectedReview(j: ExecutionJournal | null): boolean {
  return Boolean(j && !j.reviewExited && (j.buildOutcome ||
    (['built','order-requested'].includes(j.state) && j.permitRequested===true && j.orderHash)));
}
// Caller must hold the same execution Web Lock used by signing/recovery.
export function exitProtectedReview(storage: Pick<Storage,'getItem'|'setItem'>, expected: ExecutionJournal, now = Date.now()): ExecutionJournal {
  if (!canExitProtectedReview(expected) || !sameExecutionJournal(readExecutionJournal(storage),expected)) throw new Error('Protected review changed');
  const next={...expected,reviewExited:true,updatedAt:now};
  saveExecutionJournal(storage,next);
  if (!sameExecutionJournal(readExecutionJournal(storage),next)) throw new Error('Protected review exit was not persisted');
  return next;
}
export function recoveryPermitRequested(j: ExecutionJournal): boolean | undefined {
  return ['preparing', 'prepared'].includes(j.state) ? j.permitRequested : true;
}
// Prepared is server-side absence of a received permit, not proof that the
// wallet never requested/returned one. Keep local high-water evidence visible.
export function recoveredJournalState(j: ExecutionJournal, state: z.infer<typeof executionStatusSchema>['state'], settlementVerified: boolean): ExecutionJournal['state'] {
  if(state==='approval-pending' || state==='approval-confirmed')throw new Error('Approval state cannot replace permit recovery');
  if (state === 'filled' && !settlementVerified) return 'unknown';
  if (state !== 'prepared') return state;
  if (!['preparing', 'prepared'].includes(j.state)) return j.state;
  return j.permitRequested === true ? 'permit-requested' : 'prepared';
}
export function sameExecutionJournal(a: ExecutionJournal | null, b: ExecutionJournal): boolean {
  return a !== null && JSON.stringify(journalSchema.parse(a)) === JSON.stringify(journalSchema.parse(b));
}
export function discardUnsignedJournal(storage: Pick<Storage, 'getItem' | 'removeItem'>, expected: ExecutionJournal): void {
  const j = readExecutionJournal(storage);
  if (!canDiscardUnsigned(j) || !sameExecutionJournal(j, expected)) throw new Error('Unsigned journal proof changed');
  storage.removeItem(EXECUTION_JOURNAL_KEY);
  if (storage.getItem(EXECUTION_JOURNAL_KEY) !== null) throw new Error('Unsigned journal could not be removed');
}
const unsignedCancellationSchema=z.object({id:z.string().uuid(),clientRequestId:z.string().uuid(),account:address,outcome:z.literal('unsigned-cancelled')}).strict();
export function validateUnsignedCancellation(raw:unknown,j:ExecutionJournal) {
  const receipt=unsignedCancellationSchema.parse(raw);
  if(receipt.id!==j.id || receipt.clientRequestId!==j.clientRequestId || receipt.account!==j.account)throw new Error('Unsigned cancellation identity mismatch');
  return receipt;
}
// Caller holds withExecutionLock. This is a narrow exception after a proven
// first-RPC rejection, never a downgrade of permitRequested or generic discard.
export function releaseRejectedPermit(storage:Pick<Storage,'getItem'|'removeItem'>,expected:ExecutionJournal,raw:unknown) {
  validateUnsignedCancellation(raw,expected);
  if(expected.state!=='permit-requested' || expected.permitRequested!==true || !expected.id || expected.orderHash || expected.publicRecovery?.order || expected.buildOutcome ||
    !sameExecutionJournal(readExecutionJournal(storage),expected))throw new Error('Rejected permit evidence changed');
  storage.removeItem(EXECUTION_JOURNAL_KEY);
  if(storage.getItem(EXECUTION_JOURNAL_KEY)!==null)throw new Error('Rejected permit journal removal failed');
}
export function readExecutionJournal(storage: Pick<Storage,'getItem'>): ExecutionJournal | null {
  const text = storage.getItem(EXECUTION_JOURNAL_KEY);
  if (!text) return null;
  return journalSchema.parse(JSON.parse(text)); // Corruption blocks new orders; never silently discard recovery.
}
export function saveExecutionJournal(storage: Pick<Storage,'setItem'>, journal: ExecutionJournal) {
  storage.setItem(EXECUTION_JOURNAL_KEY, JSON.stringify(journalSchema.parse(journal)));
}
export function validateExecutionStatus(raw: unknown, j: ExecutionJournal) {
  const s = executionStatusSchema.parse(raw);
  if (j.buildOutcome && (s.orderHash || !['permit-exposed','prepared','expired'].includes(s.state))) throw new Error('Failure outcome conflicts with saved recovery');
  if ((s.clientRequestId && s.clientRequestId !== j.clientRequestId) || (s.request && s.request.account !== j.account) || s.account !== j.account || (j.id && s.id !== j.id) || (j.orderHash && s.orderHash !== j.orderHash)) throw new Error('Recovery identity mismatch');
  return s;
}
// Ownership recovery can rekey clientRequestId when moving an execution into a
// session with a colliding request ID. Never relax ordinary status validation:
// adopt only after the non-spending recovery response proves the saved identity.
export function validateOwnershipRecoveryStatus(raw: unknown, j: ExecutionJournal) {
  const s = executionStatusSchema.parse(raw);
  if (!j.id || s.id !== j.id || !s.clientRequestId) throw new Error('Recovery identity mismatch');
  return validateExecutionStatus(s, { ...j, clientRequestId: s.clientRequestId });
}
export async function withExecutionLock<T>(work: () => Promise<T>): Promise<T> {
  if (!navigator.locks) throw new Error('Secure cross-tab lock unavailable. Execution is blocked in this browser.');
  return navigator.locks.request('harbor:fusion:execution', { ifAvailable: true }, async lock => {
    if (!lock) throw new Error('Another Harbor tab is processing a swap. Recover its status instead.');
    return work();
  });
}
