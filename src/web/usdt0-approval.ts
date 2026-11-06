import { createPublicClient, http, type Address, type Hex } from 'viem';
import { polygon } from 'viem/chains';
import { z } from 'zod';
import { api, getFusionSession } from './api';
import { PERMIT_RPC } from './permit-diagnostic';
import { preparedSchema, readExecutionJournal, sameRequest, executionStatusSchema, type PreparedExecution } from './fusion-execution';
import type { HarborProvider } from './wallet';
import { approvalAbi, approvalIntent, APPROVAL_TOKEN, APPROVAL_SPENDER, verifyApprovalReceipt } from '../shared/usdt0-approval';
import { assertPreparationFreshness } from '../fusion/preparation-freshness';

export const APPROVAL_JOURNAL_KEY='harbor:fusion:approval:v1';
const hash=z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(v=>v.toLowerCase() as Hex);
export const approvalOrderEvidenceSchema=z.object({orderHash:hash,nonce:z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v=>BigInt(v)<2n**256n),minimumReceiveAmount:z.string().regex(/^[1-9][0-9]*$/),deadline:z.number().int().positive()}).strict();
const journalSchema=z.object({order:approvalOrderEvidenceSchema.optional(),version:z.literal(1),account:z.string().regex(/^0x[0-9a-f]{40}$/),clientRequestId:z.string().uuid(),id:z.string().uuid().optional(),prepared:preparedSchema.optional(),requested:z.boolean(),phase:z.enum(['preparing','prepared','approval-pending','approval-confirmed','building','built','order-requested','submitting','pending','unknown','filled','expired','cancelled']),transactionHash:hash.optional(),orderHash:hash.optional(),resetRequested:z.boolean().optional(),resetHash:hash.optional(),updatedAt:z.number().int().positive()}).strict().superRefine((j,c)=>{
  if(j.prepared && (j.id!==j.prepared.id || j.account!==j.prepared.request.account || j.clientRequestId!==j.prepared.clientRequestId || j.prepared.authorization!=='onchain-approval' || j.prepared.request.tokenIn!==APPROVAL_TOKEN))c.addIssue({code:'custom',message:'Approval journal mismatch'});
  if(j.order && (!j.prepared || j.orderHash!==j.order.orderHash || j.order.deadline!==j.prepared.orderDeadline))c.addIssue({code:'custom',message:'Approval order evidence mismatch'});
  if((!['preparing','prepared'].includes(j.phase) && !j.requested) || (j.transactionHash && !j.requested) || (j.orderHash && !j.requested))c.addIssue({code:'custom',message:'Missing approval request barrier'});
});
export type ApprovalJournal=z.infer<typeof journalSchema>;
export function readApprovalJournal(storage:Pick<Storage,'getItem'>):ApprovalJournal|null {const raw=storage.getItem(APPROVAL_JOURNAL_KEY);return raw===null?null:journalSchema.parse(JSON.parse(raw));}
export function sameApprovalJournal(a:ApprovalJournal|null,b:ApprovalJournal|null){return JSON.stringify(a && journalSchema.parse(a))===JSON.stringify(b && journalSchema.parse(b));}
export function saveApprovalJournal(storage:Pick<Storage,'getItem'|'setItem'>,j:ApprovalJournal){const value=journalSchema.parse(j);storage.setItem(APPROVAL_JOURNAL_KEY,JSON.stringify(value));if(!sameApprovalJournal(readApprovalJournal(storage),value))throw new Error('Approval journal write failed');}
export function clearApprovalJournal(storage:Pick<Storage,'getItem'|'removeItem'>,expected:ApprovalJournal,terminal=false){
  if(!sameApprovalJournal(readApprovalJournal(storage),expected) || (!terminal && (expected.requested || !['preparing','prepared'].includes(expected.phase))) || (terminal && !['filled','expired','cancelled'].includes(expected.phase)))throw new Error('Approval recovery remains protected');
  storage.removeItem(APPROVAL_JOURNAL_KEY);if(storage.getItem(APPROVAL_JOURNAL_KEY)!==null)throw new Error('Approval journal removal failed');
}
export function assertNoSwapJournal(storage:Pick<Storage,'getItem'>){if(readExecutionJournal(storage) || readApprovalJournal(storage))throw new Error('Saved swap must be recovered first');}
export const approvalClient=createPublicClient({chain:polygon,transport:http(PERMIT_RPC,{timeout:12000,retryCount:0,fetchOptions:{redirect:'error',credentials:'omit'}})});
export class InsufficientApprovalPol extends Error {constructor(){super('Not enough POL for the approval transaction. Add POL on Polygon to this account. Before any approval request, discard the unsigned local attempt and Review again; otherwise keep recovery and check status. Fusion settlement gas is still resolver-paid.');}}
export class ApprovalAllowanceMismatch extends Error {constructor(){super('The existing USDT0 allowance does not match this step. Do not overwrite it or increase it automatically. Recover any saved swap first; reset the 1inch router allowance to zero in your wallet (requires POL) before a fresh approval.');}}
export async function approvalReadiness(account:Address,amount:string,expectedAllowance:bigint,estimate=false,client=approvalClient){
  if(await client.getChainId()!==137)throw new Error('Polygon required');
  const block=await client.getBlock();if(!block.hash || block.number===null)throw new Error('Head unavailable');
  assertPreparationFreshness(block.timestamp,Math.floor(Date.now()/1000));
  const [allowance,balance]=await Promise.all([client.readContract({address:APPROVAL_TOKEN,abi:approvalAbi,functionName:'allowance',args:[account,APPROVAL_SPENDER],blockNumber:block.number}),client.getBalance({address:account,blockNumber:block.number})]);
  if(allowance!==expectedAllowance)throw new ApprovalAllowanceMismatch();
  let cost:bigint|null=null;
  if(estimate){
    const intent=approvalIntent(account,amount);
    const [gas,fees]=await Promise.all([client.estimateGas({account,to:APPROVAL_TOKEN,data:intent.data,value:0n}),client.estimateFeesPerGas()]);
    const fee=fees.maxFeePerGas;
    if(fee===undefined || fee<=0n || gas<=0n)throw new Error('Approval gas estimate unavailable');
    cost=((gas*120n+99n)/100n)*fee; // explicit 20% gas-unit cushion; wallet chooses actual fees
    if(balance<cost)throw new InsufficientApprovalPol();
  }
  if((await client.getBlock({blockNumber:block.number})).hash!==block.hash)throw new Error('Approval state reorganized');
  assertPreparationFreshness(block.timestamp,Math.floor(Date.now()/1000));
  return cost;
}
export async function checkApprovalTransaction(p:PreparedExecution,txHash:Hex,client=approvalClient){
  if(p.authorization!=='onchain-approval' || p.request.tokenIn!==APPROVAL_TOKEN || await client.getChainId()!==137)throw new Error('Approval context mismatch');
  const [tx,receipt,finalized]=await Promise.all([client.getTransaction({hash:txHash}),client.getTransactionReceipt({hash:txHash}),client.getBlock({blockTag:'finalized'})]);
  if(finalized.number===null)throw new Error('No finality');
  const [block,allowance]=await Promise.all([client.getBlock({blockNumber:receipt.blockNumber}),client.readContract({address:APPROVAL_TOKEN,abi:approvalAbi,functionName:'allowance',args:[p.request.account,APPROVAL_SPENDER],blockNumber:receipt.blockNumber})]);
  if(!block.hash)throw new Error('No canonical block');
  verifyApprovalReceipt(p.request.account,p.request.amount,txHash,tx,receipt,block.hash,finalized.number,allowance);
  if((await client.getBlock({blockNumber:receipt.blockNumber})).hash!==block.hash)throw new Error('Reorganized approval');
  await approvalReadiness(p.request.account,p.request.amount,BigInt(p.request.amount),false,client);
}
export async function requestApprovalTransaction(provider:HarborProvider,account:Address,amount:string,guard:()=>Promise<void>){
  await guard();
  // The caller durably writes requested BEFORE this physical RPC. A timeout,
  // disconnect, unknown error or invalid returned hash must remain non-retryable.
  let result:unknown;
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {result=await Promise.race([provider.request({method:'eth_sendTransaction',params:[approvalIntent(account,amount)]}),new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error('Approval wallet response timed out; keep recovery')),120000);})]);}
  catch(error){const e=error as {code?:unknown;data?:{originalError?:{code?:unknown}}}|null;if(e && (e.code===4001 || (e.code===-32603 && e.data?.originalError?.code===4001)))throw new ApprovalTransactionRejected();throw error;}
  finally{clearTimeout(timer);}
  return hash.parse(result);
}
export class ApprovalTransactionRejected extends Error {}
async function post(path:string,body:unknown){return api<unknown>(path,await getFusionSession(),body);}
export const approvalApi={rejected:(id:string)=>post(`/fusion/execution/${id}/approval/rejected`,{reason:'wallet-rejected-before-broadcast'}),request:(id:string)=>post(`/fusion/execution/${id}/approval/request`,{}),confirm:(id:string,transactionHash:Hex)=>post(`/fusion/execution/${id}/approval/confirm`,{transactionHash}),build:(id:string)=>post(`/fusion/execution/${id}/approval/build`,{})};
export function validateApprovalStatus(raw:unknown,j:ApprovalJournal){
  const s=executionStatusSchema.parse(raw);
  if(s.authorization!=='onchain-approval' || s.id!==j.id || s.account!==j.account || s.clientRequestId!==j.clientRequestId || !s.request || (j.prepared && !sameRequest(s.request,j.prepared.request)) || (j.transactionHash && s.approvalTransactionHash!==j.transactionHash) || (j.orderHash && s.orderHash!==j.orderHash))throw new Error('Approval status identity changed');
  return s;
}
