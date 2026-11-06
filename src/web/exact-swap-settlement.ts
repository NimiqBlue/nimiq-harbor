import { decodeEventLog, parseAbiItem, type Hex, type TransactionReceipt } from 'viem';
import { FUSION_SPENDER } from './fusion-execution';
import type { VerifiedSwapReceipt } from './public-swap-recovery';
const fill=parseAbiItem('event OrderFilled(bytes32 orderHash, uint256 remainingAmount)');
const transfer=parseAbiItem('event Transfer(address indexed from,address indexed to,uint256 value)');
// Shared exact full-fill log attribution. Callers must independently establish
// chain, finalized head, allowance, full-nonce invalidator and authorization mode.
// Final canonical-head recheck stays after ALL receipt/log reads.
export async function exactSwapSettlement(input:{account:Hex;clientRequestId:string;orderHash:Hex;tokenIn:Hex;tokenOut:Hex;amount:string;minimumReceiveAmount:string},tx:Hex,n:bigint,headHash:Hex,readReceipt:()=>Promise<TransactionReceipt>,block:(n:bigint)=>Promise<{hash:Hex|null}>):Promise<VerifiedSwapReceipt>{
  const receipt=await readReceipt();
  if(receipt.status!=='success' || receipt.transactionHash.toLowerCase()!==tx || receipt.blockNumber>n)throw new Error('Unfinalized receipt');
  if((await block(receipt.blockNumber)).hash!==receipt.blockHash)throw new Error('Reorganized receipt');
  let fills=0,matched=0,spent=0n,received=0n;
  const indices=new Set<number>();
  for(const log of receipt.logs){
    if(log.removed || log.logIndex===null || indices.has(log.logIndex) || log.blockHash!==receipt.blockHash || log.blockNumber!==receipt.blockNumber || log.transactionHash!==receipt.transactionHash || log.transactionIndex!==receipt.transactionIndex)throw new Error('Invalid receipt log');
    indices.add(log.logIndex);
    if(log.address.toLowerCase()===FUSION_SPENDER){try{const event=decodeEventLog({abi:[fill],data:log.data,topics:log.topics,strict:true});fills++;if(event.args.orderHash.toLowerCase()===input.orderHash && event.args.remainingAmount===0n)matched++;}catch{/* unrelated router event */}}
    const token=log.address.toLowerCase();if(token!==input.tokenIn && token!==input.tokenOut)continue;
    try{const {args}=decodeEventLog({abi:[transfer],data:log.data,topics:log.topics,strict:true});const from=args.from.toLowerCase(),to=args.to.toLowerCase();if(token===input.tokenIn)spent+=(from===input.account?args.value:0n)-(to===input.account?args.value:0n);if(token===input.tokenOut)received+=(to===input.account?args.value:0n)-(from===input.account?args.value:0n);}catch{/* unrelated token event */}
  }
  if(fills!==1 || matched!==1 || spent!==BigInt(input.amount) || received<BigInt(input.minimumReceiveAmount))throw new Error('Exact settlement not proven');
  if((await block(n)).hash!==headHash)throw new Error('Finalized block changed');
  return {account:input.account,clientRequestId:input.clientRequestId,orderHash:input.orderHash,transactionHash:tx,tokenOut:input.tokenOut,receivedAmount:received.toString()};
}
