import { hex, rpc, same, transfer, type Asset } from './pay-core';

export type Payment = { hash:string; asset:Asset; from:string; to:string; units:bigint };
export type ReceiptState = 'pending'|'confirmed'|'failed'|'unverified';

const hashPattern = /^0x[0-9a-f]{64}$/i;
const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const padWord = (value:string) => '0x'+value.slice(2).padStart(64,'0');
const record = (value:unknown):Record<string,unknown> => value && typeof value==='object' ? value as Record<string,unknown> : {};

export async function checkPayReceipt(payment:Payment):Promise<ReceiptState>{
 const {hash,asset,from,to,units}=payment;
 if(!hashPattern.test(hash))return 'unverified';
 const result=await rpc(asset.network,'eth_getTransactionReceipt',[hash]);
 if(result===null)return 'pending';
 const receipt=record(result),expected=transfer(asset,from,to,units);
 if(!same(receipt.transactionHash,hash)||!same(receipt.from,from)||!same(receipt.to,expected.to)||typeof receipt.blockHash!=='string'||!hashPattern.test(receipt.blockHash))return 'unverified';
 if(receipt.status==='0x0')return 'failed';
 if(receipt.status!=='0x1')return 'unverified';
 if(asset.address){
  const transferred=Array.isArray(receipt.logs)&&receipt.logs.some(entry=>{
   const log=record(entry),topics=log.topics;
   return log.removed!==true&&same(log.address,asset.address)&&same(log.transactionHash,hash)&&same(log.blockHash,receipt.blockHash)&&Array.isArray(topics)&&topics.length===3&&same(topics[0],transferTopic)&&same(topics[1],padWord(from))&&same(topics[2],padWord(to))&&same(log.data,padWord(hex(units)));
  });
  return transferred?'confirmed':'unverified';
 }
 const tx=record(await rpc(asset.network,'eth_getTransactionByHash',[hash]));
 return same(tx.hash,hash)&&same(tx.blockHash,receipt.blockHash)&&same(tx.from,from)&&same(tx.to,to)&&same(tx.input,'0x')&&same(tx.value,expected.value)?'confirmed':'unverified';
}