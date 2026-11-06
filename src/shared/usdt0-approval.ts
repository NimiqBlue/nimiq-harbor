// Canonical transaction intent; never trust a wallet's returned hash as approval.
import { encodeFunctionData, decodeEventLog, parseAbi, type Hex, type TransactionReceipt } from 'viem';
export const APPROVAL_TOKEN = '0xc2132d05d31c914a87c6611c10748aeb04b58e8f' as const;
export const APPROVAL_SPENDER = '0x111111125421ca6dc452d289314280a0f8842a65' as const;
export const approvalAbi = parseAbi(['function approve(address spender,uint256 value) returns(bool)', 'function allowance(address,address) view returns(uint256)', 'event Approval(address indexed owner,address indexed spender,uint256 value)']);
export function approvalIntent(account:string, amount:string) {
  if(!/^0x[0-9a-f]{40}$/i.test(account) || !/^(0|[1-9][0-9]{0,77})$/.test(amount) || BigInt(amount)>=2n**256n)throw new Error('Invalid approval intent');
  return {from:account.toLowerCase(),to:APPROVAL_TOKEN,chainId:'0x89',value:'0x0',data:encodeFunctionData({abi:approvalAbi,functionName:'approve',args:[APPROVAL_SPENDER,BigInt(amount)]})};
}
export function verifyApprovalReceipt(account:string,amount:string,hash:Hex,tx:{hash:string;from:string;to:string|null;input:string;value:bigint;chainId?:number|undefined;blockHash:string|null;blockNumber:bigint|null},receipt:TransactionReceipt,canonicalHash:string,finalizedBlock:bigint,allowance:bigint) {
  const intent=approvalIntent(account,amount);
  if(tx.chainId!==137 || tx.hash.toLowerCase()!==hash.toLowerCase() || receipt.transactionHash.toLowerCase()!==hash.toLowerCase() || tx.from.toLowerCase()!==intent.from || tx.to?.toLowerCase()!==intent.to || tx.input.toLowerCase()!==intent.data.toLowerCase() || tx.value!==0n || receipt.status!=='success' || receipt.from.toLowerCase()!==intent.from || receipt.to?.toLowerCase()!==intent.to || tx.blockNumber!==receipt.blockNumber || tx.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase() || receipt.blockHash.toLowerCase()!==canonicalHash.toLowerCase() || receipt.blockNumber>finalizedBlock || allowance!==BigInt(amount))throw new Error('Approval transaction not independently verified');
  let count=0;
  for(const log of receipt.logs) {
    if(log.address.toLowerCase()!==APPROVAL_TOKEN)continue;
    let event;
    try {event=decodeEventLog({abi:approvalAbi,data:log.data,topics:log.topics,strict:true});}catch{continue;}
    if(event.eventName!=='Approval')continue;
    if(log.removed || log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase() || log.blockNumber!==receipt.blockNumber || log.transactionHash?.toLowerCase()!==hash.toLowerCase() || log.transactionIndex!==receipt.transactionIndex || log.logIndex===null || event.args.owner.toLowerCase()!==intent.from || event.args.spender.toLowerCase()!==APPROVAL_SPENDER || event.args.value!==BigInt(amount))throw new Error('Approval log mismatch');
    count++;
  }
  if(count!==1)throw new Error('One exact approval event required');
}
