import { parseAbi, type Hex } from 'viem';
import { api } from './api';
import { approvalClient, sameApprovalJournal, type ApprovalJournal } from './usdt0-approval';
import { APPROVAL_SPENDER, APPROVAL_TOKEN } from '../shared/usdt0-approval';
import { publicOrderStatusSchema } from '../shared/fusion-public-status';
import { exactSwapSettlement } from './exact-swap-settlement';
import type { PublicRecoveryReads, PublicRecoveryResult } from './public-swap-recovery';
const abi=parseAbi(['function allowance(address,address) view returns(uint256)','function bitInvalidatorForOrder(address,uint256) view returns(uint256)']);
export type ApprovalRecoveryReads=Omit<PublicRecoveryReads,'nonce'|'terminalRelease'>;
const reads:ApprovalRecoveryReads={
  hint:hash=>api(`/fusion/status?orderHash=${hash}`),chain:()=>approvalClient.getChainId(),
  block:n=>approvalClient.getBlock(n===undefined?{blockTag:'finalized'}:{blockNumber:n}),
  allowance:(token,account,blockNumber)=>approvalClient.readContract({address:token,abi,functionName:'allowance',args:[account,APPROVAL_SPENDER],blockNumber}),
  invalidator:(account,nonce,blockNumber)=>approvalClient.readContract({address:APPROVAL_SPENDER,abi,functionName:'bitInvalidatorForOrder',args:[account,nonce],blockNumber}),
  receipt:hash=>approvalClient.getTransactionReceipt({hash}),
};
let inFlight=false;
// No private GET/POST, permit-nonce assumption, approval confirmation, expired-
// unused release, build, signature or retransmission belongs in this monitor.
export async function recoverApprovalSwap(j:ApprovalJournal,isCurrent:()=>boolean,r:ApprovalRecoveryReads=reads):Promise<PublicRecoveryResult>{
  if(inFlight)throw new Error('Approval status read already running');
  inFlight=true;
  const check=()=>{if(!isCurrent())throw new Error('Approval recovery context changed');};
  const read=async<T>(work:()=>Promise<T>)=>{check();const value=await work();check();return value;};
  try{
    check();
    // Roundtrip through the durable schema as well as the caller's exact guard.
    if(!sameApprovalJournal(j,j))throw new Error('Invalid approval journal');
    const p=j.prepared,o=j.order;
    if(!p || !o || !j.orderHash || !j.requested || p.authorization!=='onchain-approval' || p.request.tokenIn!==APPROVAL_TOKEN)return {state:'unknown'};
    const hint=publicOrderStatusSchema.parse(await read(()=>r.hint(j.orderHash!)));
    if(hint.orderHash!==j.orderHash)throw new Error('Order hint mismatch');
    if(!hint.transactionHash)return {state:hint.status};
    if(await read(()=>r.chain())!==137)throw new Error('Polygon required');
    const head=await read(()=>r.block());
    if(head.number===null || !head.hash || typeof head.timestamp!=='bigint')throw new Error('Finality unavailable');
    const n=head.number;
    const [allowance,slot]=await read(()=>Promise.all([r.allowance(p.request.tokenIn,j.account as Hex,n),r.invalidator(j.account as Hex,BigInt(o.nonce),n)]));
    if(allowance!==0n || (slot&(1n<<(BigInt(o.nonce)&255n)))===0n)return {state:hint.status};
    const tx=hint.transactionHash as Hex;
    const receipt=await exactSwapSettlement({...p.request,clientRequestId:j.clientRequestId,orderHash:j.orderHash,minimumReceiveAmount:o.minimumReceiveAmount},tx,n,head.hash,()=>read(()=>r.receipt(tx)),number=>read(()=>r.block(number)));
    return {state:'filled',transactionHash:tx,receipt};
  }finally{inFlight=false;}
}
