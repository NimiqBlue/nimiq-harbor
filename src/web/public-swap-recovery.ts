import { createPublicClient, http, parseAbi, type Hex, type TransactionReceipt } from 'viem';
import { exactSwapSettlement } from './exact-swap-settlement';
import { polygon } from 'viem/chains';
import { api } from './api';
import { FUSION_SPENDER, publicRecoveryEvidenceSchema, type ExecutionJournal } from './fusion-execution';
import { PERMIT_RPC } from './permit-diagnostic';
import { publicOrderStatusSchema } from '../shared/fusion-public-status';
import { terminalReleaseBinding, verifyTerminalRelease } from '../shared/terminal-release';
import { TOKENS } from '../swap/registry';

const client=createPublicClient({chain:polygon,transport:http(PERMIT_RPC,{timeout:12000,retryCount:0,fetchOptions:{redirect:'error',credentials:'omit'}})});
const abi=parseAbi(['function nonces(address) view returns(uint256)','function allowance(address,address) view returns(uint256)','function bitInvalidatorForOrder(address,uint256) view returns(uint256)']);
type Head={number:bigint|null;hash:Hex|null;timestamp:bigint};
export interface PublicRecoveryReads {
  hint(hash:Hex):Promise<unknown>;
  terminalRelease?(binding:string):Promise<unknown>;
  chain():Promise<number>;
  block(number?:bigint):Promise<Head>;
  nonce(token:Hex,account:Hex,block:bigint):Promise<bigint>;
  allowance(token:Hex,account:Hex,block:bigint):Promise<bigint>;
  invalidator(account:Hex,nonce:bigint,block:bigint):Promise<bigint>;
  receipt(hash:Hex):Promise<TransactionReceipt>;
}
const reads:PublicRecoveryReads={
  terminalRelease:async binding=>{
    const response=await fetch(`/recovery/terminal/${binding}.json`,{credentials:'omit',redirect:'error',cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok || Number(response.headers.get('content-length')??0)>4096)throw new Error('No published terminal release');
    const body=await response.text();if(body.length>4096)throw new Error('Invalid terminal release');return JSON.parse(body) as unknown;
  },
  hint:hash=>api(`/fusion/status?orderHash=${hash}`),chain:()=>client.getChainId(),
  block:number=>client.getBlock(number===undefined?{blockTag:'finalized'}:{blockNumber:number}),
  nonce:(token,account,blockNumber)=>client.readContract({address:token,abi,functionName:'nonces',args:[account],blockNumber}),
  allowance:(token,account,blockNumber)=>client.readContract({address:token,abi,functionName:'allowance',args:[account,FUSION_SPENDER],blockNumber}),
  invalidator:(account,nonce,blockNumber)=>client.readContract({address:FUSION_SPENDER,abi,functionName:'bitInvalidatorForOrder',args:[account,nonce],blockNumber}),
  receipt:hash=>client.getTransactionReceipt({hash}),
};
export type VerifiedSwapReceipt={account:Hex;clientRequestId:string;orderHash:Hex;transactionHash:Hex;tokenOut:Hex;receivedAmount:string};
export type PublicRecoveryResult={state:'unknown'|'pending'|'filled'|'expired';transactionHash?:Hex;receipt?:VerifiedSwapReceipt};
// Physical work remains serialized even if React unmounts or changes accounts.
let inFlight=false;
const automaticChecks=new Set<string>();
export function claimAutomaticPublicRecovery(j:ExecutionJournal):boolean {
  const key=`${j.account}:${j.clientRequestId}`;
  if(automaticChecks.has(key) || automaticChecks.size>=100)return false;
  automaticChecks.add(key);return true;
}
export async function recoverPublicSwap(j:ExecutionJournal,isCurrent:()=>boolean,r:PublicRecoveryReads=reads):Promise<PublicRecoveryResult> {
  if(inFlight)throw new Error('A public status read is already running');
  inFlight=true;
  const check=()=>{if(!isCurrent())throw new Error('Recovery context changed');};
  const read=async<T>(p:()=>Promise<T>)=>{check();const value=await p();check();return value;};
  try {
    check();
    let result:PublicRecoveryResult={state:'unknown'};
    let tx:Hex|undefined;
    if(j.orderHash) {
      try {const hint=publicOrderStatusSchema.parse(await read(()=>r.hint(j.orderHash!)));if(hint.orderHash!==j.orderHash)throw new Error('Order mismatch');result={state:hint.status};tx=hint.transactionHash as Hex|undefined;}
      catch {check();} // Provider absence/failure is unknown, never failed/expired.
    }
    const e=j.publicRecovery && publicRecoveryEvidenceSchema.parse(j.publicRecovery);
    if(!e) {
      // Immutable operator-published, redacted certificates only. This does not
      // query any private journal, discover an account or restore a session.
      if(!j.id || j.orderHash || !r.terminalRelease)return result;
      try {
        const binding=await read(()=>terminalReleaseBinding(j.id!,j.account));
        const c=await read(async()=>verifyTerminalRelease(await r.terminalRelease!(binding),binding));
        if(!Object.values(TOKENS).some(t=>t.address.toLowerCase()===c.token))throw new Error('Unsupported token');
        if(await read(()=>r.chain())!==137)throw new Error('Polygon required');
        const final=await read(()=>r.block()),n=BigInt(c.blockNumber);
        if(final.number===null || !final.hash || final.number<n || final.timestamp<BigInt(c.blockTimestamp))throw new Error('Finality unavailable');
        const block=await read(()=>r.block(n));
        if(block.number!==n || block.hash!==c.blockHash || block.timestamp!==BigInt(c.blockTimestamp) || block.timestamp<=BigInt(c.deadline))throw new Error('Terminal release block mismatch');
        const [nonce,allowance]=await read(()=>Promise.all([r.nonce(c.token as Hex,j.account,n),r.allowance(c.token as Hex,j.account,n)]));
        if(nonce!==BigInt(c.nonce) || allowance!==0n || (await read(()=>r.block(n))).hash!==c.blockHash)throw new Error('Unused expiry not proven');
        return {state:'expired'};
      }catch {check();return result;} // Missing/invalid certificates never clear protection.
    }
    if(e.request.account!==j.account || (j.orderHash && e.order?.orderHash!==j.orderHash))throw new Error('Recovery identity mismatch');
    if(await read(()=>r.chain())!==137)throw new Error('Polygon required');
    const head=await read(()=>r.block());
    if(head.number===null || !head.hash || typeof head.timestamp!=='bigint')throw new Error('Finality unavailable');
    const n=head.number;
    const [nonce,allowance]=await read(()=>Promise.all([r.nonce(e.request.tokenIn,j.account,n),r.allowance(e.request.tokenIn,j.account,n)]));
    // LOP checkSlot shifts internally: pass the full nonce, never nonce >> 8.
    const slot=e.order ? await read(()=>r.invalidator(j.account,BigInt(e.order!.nonce),n)):0n;
    const invalidated=e.order ? (slot&(1n<<(BigInt(e.order.nonce)&255n)))!==0n:false;
    if(tx && e.order && j.orderHash && invalidated && nonce===BigInt(e.permit.nonce)+1n && allowance===0n) {
      const receipt=await exactSwapSettlement({...e.request,clientRequestId:j.clientRequestId,orderHash:j.orderHash,minimumReceiveAmount:e.order.minimumReceiveAmount},tx,n,head.hash,()=>read(()=>r.receipt(tx!)),number=>read(()=>r.block(number)));
      return {state:'filled',transactionHash:tx,receipt};
    }
    if(head.timestamp>BigInt(e.permit.deadline) && nonce===BigInt(e.permit.nonce) && allowance===0n && !invalidated && (await read(()=>r.block(n))).hash===head.hash)return {state:'expired'};
    return result;
  } finally {inFlight=false;}
}
