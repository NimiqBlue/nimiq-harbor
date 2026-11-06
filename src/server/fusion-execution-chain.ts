import { FusionOrder, Extension } from '@1inch/fusion-sdk';
import { createPublicClient, parseAbi, parseAbiItem, decodeEventLog, type Address, type Hex, type TransactionReceipt } from 'viem';
import { polygonReadTransport } from './polygon-read-transport.js';
import { polygon } from 'viem/chains';
import { assertPreparationFreshness, PreparationFailure } from '../fusion/preparation-freshness.js';
import { preparationRpc } from '../shared/fusion-preparation-rpc.js';
import { SPENDER, SETTLEMENT, type QuoteRequest } from '../fusion/policy.js';
import type { ExecutionRecord, PermitSnapshot, SavedOrder } from './fusion-execution-store.js';
import { verifyApprovalReceipt, approvalIntent, APPROVAL_TOKEN } from '../shared/usdt0-approval.js';

// LOP forwards its misleadingly named `slot` argument to checkSlot(nonce),
// which shifts right by eight internally. Always pass the full order nonce.
const abi=parseAbi([
  'function nonces(address) view returns (uint256)', 'function DOMAIN_SEPARATOR() view returns (bytes32)',
  'function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)',
  'function bitInvalidatorForOrder(address,uint256) view returns (uint256)',
]);
const fillEvent=parseAbiItem('event OrderFilled(bytes32 orderHash, uint256 remainingAmount)');
const transferEvent=parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
export interface SettlementProof {transactionHash:string;blockHash:string;blockNumber:string;spent:string;received:string}
export interface ExecutionChain {
  snapshot(request:QuoteRequest,now:()=>number,built?:SavedOrder,expectedApprovalAllowance?:bigint):Promise<PermitSnapshot>;
  verifyApproval?(record:ExecutionRecord,hash:Hex):Promise<void>;
  verify(record:ExecutionRecord,txHash:Hex):Promise<SettlementProof>;
  expiredUnused(record:ExecutionRecord):Promise<boolean>;
}
/** Receipt verification is independent of provider amounts/status. Conservatively
 * require a single LOP fill per transaction: batch attribution is not guessed. */
export function verifyExecutionReceipt(record:ExecutionRecord,receipt:TransactionReceipt,canonicalHash:Hex,finalizedBlock:bigint) {
  if(!record.built || receipt.status!=='success' || receipt.blockHash.toLowerCase()!==canonicalHash.toLowerCase() || receipt.blockNumber>finalizedBlock)throw new Error('Unfinalized, reverted or reorganized receipt');
  let matching=0, allFills=0, spent=0n, received=0n;
  const indices=new Set<number>();
  for(const log of receipt.logs) {
    if(log.removed || log.blockNumber!==receipt.blockNumber || log.transactionIndex!==receipt.transactionIndex || log.logIndex===null || indices.has(log.logIndex) || log.transactionHash?.toLowerCase()!==receipt.transactionHash.toLowerCase() || log.blockHash?.toLowerCase()!==receipt.blockHash.toLowerCase())throw new Error('Inconsistent receipt log');
    indices.add(log.logIndex);
    if(log.address.toLowerCase()===SPENDER) {
      try {
        const event=decodeEventLog({abi:[fillEvent],data:log.data,topics:log.topics,strict:true});
        allFills++;
        if(event.args.orderHash.toLowerCase()===record.built.orderHash.toLowerCase() && event.args.remainingAmount===0n)matching++;
      }catch{/* other router logs are not fill evidence */}
    }
    const token=log.address.toLowerCase();
    if(token!==record.request.tokenIn && token!==record.request.tokenOut)continue;
    try {
      const {args}=decodeEventLog({abi:[transferEvent],data:log.data,topics:log.topics,strict:true});
      const from=args.from.toLowerCase(),to=args.to.toLowerCase(),maker=record.request.account;
      if(token===record.request.tokenIn)spent+=(from===maker?args.value:0n)-(to===maker?args.value:0n);
      if(token===record.request.tokenOut)received+=(to===maker?args.value:0n)-(from===maker?args.value:0n);
    }catch{/* unrelated token events */}
  }
  if(matching!==1 || allFills!==1 || spent!==BigInt(record.request.amount) || received<BigInt(record.built.minimumReceiveAmount))throw new Error('Receipt does not prove the exact order input and net recipient output');
  return {transactionHash:receipt.transactionHash,blockHash:receipt.blockHash,blockNumber:receipt.blockNumber.toString(),spent:spent.toString(),received:received.toString()};
}
/** Public/read-only client: never instantiates accounts, wallet clients or send APIs. */
export class PolygonExecutionChain implements ExecutionChain {
  private readonly client;
  constructor(url:string) {this.client=createPublicClient({chain:polygon,transport:polygonReadTransport(url)});}
  async snapshot(request:QuoteRequest,now:()=>number,built?:SavedOrder,expectedApprovalAllowance?:bigint):Promise<PermitSnapshot> {
    const approval=expectedApprovalAllowance!==undefined;
    if(approval && request.tokenIn!==APPROVAL_TOKEN)throw new Error('USDT0 approval required');
    if(await preparationRpc('FUSION_PREPARATION_RPC_CHAIN',()=>this.client.getChainId())!==137)throw new PreparationFailure('FUSION_CHAIN_MISMATCH','RPC is not Polygon mainnet. Preparation stopped.');
    const block=await preparationRpc('FUSION_PREPARATION_RPC_HEAD',()=>this.client.getBlock({blockTag:'latest'}));
    if(!block.hash || block.number===null || typeof block.timestamp!=='bigint')throw new PreparationFailure('FUSION_HEAD_INVALID','Polygon head is incomplete. Preparation stopped.');
    assertPreparationFreshness(block.timestamp,Math.floor(now()/1000));
    const token=request.tokenIn as Address,account=request.account as Address;
    const [nonce,domainSeparator,balance,allowance,codes]=await Promise.all([
      approval ? Promise.resolve(0n) : preparationRpc('FUSION_PREPARATION_RPC_NONCE',()=>this.client.readContract({address:token,abi,functionName:'nonces',args:[account],blockNumber:block.number})),
      approval ? Promise.resolve(`0x${'0'.repeat(64)}` as Hex) : preparationRpc('FUSION_PREPARATION_RPC_DOMAIN',()=>this.client.readContract({address:token,abi,functionName:'DOMAIN_SEPARATOR',blockNumber:block.number})),
      preparationRpc('FUSION_PREPARATION_RPC_BALANCE',()=>this.client.readContract({address:token,abi,functionName:'balanceOf',args:[account],blockNumber:block.number})),
      preparationRpc('FUSION_PREPARATION_RPC_ALLOWANCE',()=>this.client.readContract({address:token,abi,functionName:'allowance',args:[account,SPENDER],blockNumber:block.number})),
      Promise.all([
        preparationRpc('FUSION_PREPARATION_RPC_INPUT_CODE',()=>this.client.getCode({address:token,blockNumber:block.number})),
        preparationRpc('FUSION_PREPARATION_RPC_OUTPUT_CODE',()=>this.client.getCode({address:request.tokenOut as Address,blockNumber:block.number})),
        preparationRpc('FUSION_PREPARATION_RPC_ROUTER_CODE',()=>this.client.getCode({address:SPENDER,blockNumber:block.number})),
        preparationRpc('FUSION_PREPARATION_RPC_SETTLEMENT_CODE',()=>this.client.getCode({address:SETTLEMENT,blockNumber:block.number})),
      ]),
    ]);
    if(balance<BigInt(request.amount))throw new PreparationFailure('FUSION_INPUT_BALANCE','Input token balance is insufficient. Preparation stopped.');
    if(allowance!==(expectedApprovalAllowance??0n))throw new PreparationFailure('FUSION_EXISTING_ALLOWANCE','Router allowance differs from the required exact amount. Reset existing allowance to zero before a new preparation.');
    if(codes.some(code=>!code || code==='0x'))throw new PreparationFailure('FUSION_CODE_MISSING','Required token or router code is missing. Preparation stopped.');
    if(built) {
      const order=FusionOrder.fromDataAndExtension(built.order,Extension.decode(built.extension));
      if(!order.isBitInvalidatorMode)throw new Error('Order nonce mode mismatch');
      const slot=await preparationRpc('FUSION_PREPARATION_RPC_ORDER_NONCE',()=>this.client.readContract({address:SPENDER,abi,functionName:'bitInvalidatorForOrder',args:[account,order.nonce],blockNumber:block.number}));
      if((slot & (1n<<(order.nonce & 255n)))!==0n)throw new Error('Order nonce already filled or cancelled');
    }
    // Domain validation is token-specific in prepareFusionPermit; never trust RPC-supplied typed data.
    const rechecked=await preparationRpc('FUSION_PREPARATION_RPC_CANONICALITY',()=>this.client.getBlock({blockNumber:block.number}));
    if(rechecked.hash!==block.hash)throw new PreparationFailure('FUSION_STATE_REORGANIZED','Polygon state changed during preparation. Preparation stopped.');
    // Contract reads and canonicality checks can consume the freshness window too.
    assertPreparationFreshness(block.timestamp,Math.floor(now()/1000));
    return {chainId:137,account:request.account,token:request.tokenIn,nonce:nonce.toString(),domainSeparator:domainSeparator.toLowerCase() as Hex,
      blockNumber:block.number.toString(),blockHash:block.hash.toLowerCase() as Hex,recheckedBlockHash:rechecked.hash!.toLowerCase() as Hex,blockTimestamp:Number(block.timestamp)};
  }
  async verifyApproval(record:ExecutionRecord,hash:Hex):Promise<void> {
    if(record.authorization!=='onchain-approval' || record.request.tokenIn!==APPROVAL_TOKEN || await this.client.getChainId()!==137)throw new Error('Approval context mismatch');
    const [tx,receipt,finalized]=await Promise.all([this.client.getTransaction({hash}),this.client.getTransactionReceipt({hash}),this.client.getBlock({blockTag:'finalized'})]);
    if(finalized.number===null)throw new Error('Finality unavailable');
    const [block,allowance]=await Promise.all([this.client.getBlock({blockNumber:receipt.blockNumber}),this.client.readContract({address:APPROVAL_TOKEN,abi,functionName:'allowance',args:[record.request.account as Address,SPENDER],blockNumber:receipt.blockNumber})]);
    if(!block.hash)throw new Error('Canonicality unavailable');
    verifyApprovalReceipt(record.request.account,record.request.amount,hash,tx,receipt,block.hash,finalized.number,allowance);
    if((await this.client.getBlock({blockNumber:receipt.blockNumber})).hash!==block.hash)throw new Error('Approval reorganized');
  }
  async expiredUnused(record:ExecutionRecord):Promise<boolean> {
    if(await this.client.getChainId()!==137)return false;
    const block=await this.client.getBlock({blockTag:'finalized'});
    if(!block.hash || block.number===null || block.timestamp<=BigInt(record.permitDeadline))return false;
    // approve() has NO deadline: finalized zero allowance alone cannot release
    // an unknown/pending broadcast that may still mine in the future.
    if(record.authorization==='onchain-approval') {
      if(!record.approvalTransactionHash)return false;
      const hash=record.approvalTransactionHash as Hex;
      const [tx,receipt]=await Promise.all([this.client.getTransaction({hash}),this.client.getTransactionReceipt({hash})]);
      const mined=await this.client.getBlock({blockNumber:receipt.blockNumber});
      if((receipt.status!=='success' && receipt.status!=='reverted') || receipt.from.toLowerCase()!==record.request.account || receipt.to?.toLowerCase()!==APPROVAL_TOKEN || !mined.hash || receipt.blockNumber>block.number || tx.blockHash!==receipt.blockHash || tx.blockNumber!==receipt.blockNumber || receipt.blockHash!==mined.hash || tx.chainId!==137 || tx.from.toLowerCase()!==record.request.account || tx.to?.toLowerCase()!==APPROVAL_TOKEN || tx.input.toLowerCase()!==approvalIntent(record.request.account,record.request.amount).data.toLowerCase() || tx.value!==0n || tx.hash.toLowerCase()!==hash || receipt.transactionHash.toLowerCase()!==hash)return false;
      // Either mined success or mined revert consumes this exact transaction;
      // residual allowance at the finalized expiry block is checked separately.
    }
    if(!record.built) {
      // An exposed standalone permit can have been consumed without any saved
      // order. Expiry alone must not hide residual approval or changed nonce.
      const [nonce,allowance]=await Promise.all([
        record.authorization==='onchain-approval' ? Promise.resolve(0n) : this.client.readContract({address:record.request.tokenIn as Address,abi,functionName:'nonces',args:[record.request.account as Address],blockNumber:block.number}),
        this.client.readContract({address:record.request.tokenIn as Address,abi,functionName:'allowance',args:[record.request.account as Address,SPENDER],blockNumber:block.number}),
      ]);
      return (record.authorization==='onchain-approval' || nonce===BigInt(record.snapshot.nonce)) && allowance===0n && (await this.client.getBlock({blockNumber:block.number})).hash===block.hash;
    }
    const order=FusionOrder.fromDataAndExtension(record.built.order,Extension.decode(record.built.extension));
    if(!order.isBitInvalidatorMode || order.deadline>BigInt(record.permitDeadline))return false;
    const [nonce,allowance,slot]=await Promise.all([
      record.authorization==='onchain-approval' ? Promise.resolve(0n) : this.client.readContract({address:record.request.tokenIn as Address,abi,functionName:'nonces',args:[record.request.account as Address],blockNumber:block.number}),
      this.client.readContract({address:record.request.tokenIn as Address,abi,functionName:'allowance',args:[record.request.account as Address,SPENDER],blockNumber:block.number}),
      this.client.readContract({address:SPENDER,abi,functionName:'bitInvalidatorForOrder',args:[record.request.account as Address,order.nonce],blockNumber:block.number}),
    ]);
    const recheck=await this.client.getBlock({blockNumber:block.number});
    return recheck.hash===block.hash && (record.authorization==='onchain-approval' || nonce===BigInt(record.snapshot.nonce)) && allowance===0n && (slot & (1n<<(order.nonce & 255n)))===0n;
  }
  async verify(record:ExecutionRecord,txHash:Hex):Promise<SettlementProof> {
    if(await this.client.getChainId()!==137)throw new Error('Polygon RPC chain mismatch');
    const receipt=await this.client.getTransactionReceipt({hash:txHash});
    const [finalized,block]=await Promise.all([this.client.getBlock({blockTag:'finalized'}),this.client.getBlock({blockNumber:receipt.blockNumber})]);
    if(!finalized.hash || finalized.number===null || !block.hash)throw new Error('No finality evidence');
    const proof=verifyExecutionReceipt(record,receipt,block.hash,finalized.number);
    const [nonce,allowance]=await Promise.all([
      record.authorization==='onchain-approval' ? Promise.resolve(0n) : this.client.readContract({address:record.request.tokenIn as Address,abi,functionName:'nonces',args:[record.request.account as Address],blockNumber:receipt.blockNumber}),
      this.client.readContract({address:record.request.tokenIn as Address,abi,functionName:'allowance',args:[record.request.account as Address,SPENDER],blockNumber:receipt.blockNumber}),
    ]);
    if((record.authorization!=='onchain-approval' && nonce!==BigInt(record.snapshot.nonce)+1n) || allowance!==0n)throw new Error('Permit not consumed exactly once or residual allowance remains');
    const order=FusionOrder.fromDataAndExtension(record.built!.order,Extension.decode(record.built!.extension));
    const slot=await this.client.readContract({address:SPENDER,abi,functionName:'bitInvalidatorForOrder',args:[record.request.account as Address,order.nonce],blockNumber:receipt.blockNumber});
    if(!order.isBitInvalidatorMode || (slot & (1n<<(order.nonce & 255n)))===0n)throw new Error('Order nonce was not invalidated by the fill');
    const recheck=await this.client.getBlock({blockNumber:receipt.blockNumber});
    if(recheck.hash!==block.hash)throw new Error('Reorganized verification');
    return proof;
  }
}
