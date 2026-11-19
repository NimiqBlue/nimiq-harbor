import { isAddress, zeroAddress } from 'viem';

export type Provider = {request(a:{method:string;params?:unknown[]}):Promise<unknown>; on?(e:string,f:(...a:unknown[])=>void):void;removeListener?(e:string,f:(...a:unknown[])=>void):void};
export const NETWORKS = {
  polygon:{id:137,hex:'0x89',name:'Polygon',native:'POL',rpc:'https://polygon.drpc.org',explorer:'https://polygonscan.com'},
  ethereum:{id:1,hex:'0x1',name:'Ethereum',native:'ETH',rpc:'https://eth.drpc.org',explorer:'https://etherscan.io'},
} as const;
export type Network = keyof typeof NETWORKS;
export const ASSETS = [
 {key:'USDT',symbol:'USDT0',network:'polygon',decimals:6,address:'0xc2132D05D31c914a87C6611C10748AEb04B58e8F',mark: '₮'},
 {key:'USDC',symbol:'USDC',network:'polygon',decimals:6,address:'0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',mark: '$'},
 {key:'POL',symbol:'POL',network:'polygon',decimals:18,address:null,mark: 'P'},
 {key:'ETH',symbol:'ETH',network:'ethereum',decimals:18,address:null,mark: 'Ξ'},
 {key:'XAUt',symbol:'XAUt',network:'ethereum',decimals:6,address:'0x68749665FF8D2d112Fa859AA293F07A622782F38',mark: 'Au'},
 {key:'PAXG',symbol:'PAXG',network:'ethereum',decimals:18,address:'0x45804880De22913dAFE09f4980848ECE6EcbAf78',mark: 'Au'},
 {key:'EURC',symbol:'EURC',network:'ethereum',decimals:6,address:'0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c',mark: '€'},
 {key:'ETH_USDT',symbol:'USDT',network:'ethereum',decimals:6,address:'0xdAC17F958D2ee523a2206206994597C13D831ec7',mark: '₮'},
 {key:'ETH_USDC',symbol:'USDC',network:'ethereum',decimals:6,address:'0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',mark: '$'},
] as const;
export type Asset = typeof ASSETS[number];
export const validPayAddress = (value: string) => isAddress(value) && value.toLowerCase() !== zeroAddress;
export const hex=(v:bigint)=>`0x${v.toString(16)}`;
export function quantity(v:unknown){if(typeof v!=='string'||!/^0x[0-9a-f]+$/i.test(v))throw Error('Read unavailable. Review again.');return BigInt(v);}
export const same=(a:unknown,b:unknown)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
export const rejected=(e:unknown)=>{const v=e as {code?:number;data?:{originalError?:{code?:number}}};return v?.code===4001||(v?.code===-32603&&v?.data?.originalError?.code===4001)};
export async function walletRead(p:Provider,method:string){let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([p.request({method}),new Promise<never>((_,r)=>{timer=setTimeout(()=>r(Error('Wallet read unavailable. Review again.')),15000)})]);}catch{throw Error('Could not read the wallet account or network. Unlock the wallet and review again.');}finally{clearTimeout(timer)}}
export async function preflight(p:Provider,account:string,network:Network,guard:()=>void){
 if (!validPayAddress(account)) throw Error('Invalid sending wallet address. Reconnect and review again.');
 guard();const accounts=await walletRead(p,'eth_accounts');guard();const chain=await walletRead(p,'eth_chainId');guard();
 if(!Array.isArray(accounts)||!accounts.some(a=>same(a,account)))throw Error('Selected account is no longer authorized. Reconnect and review again.');
 if(quantity(chain)!==BigInt(NETWORKS[network].id))throw Error(`Switch your wallet to ${NETWORKS[network].name} using the network button, then review again.`);
}
let rpcId=0;
export async function rpc(network:Network,method:string,params:unknown[]=[]):Promise<unknown>{
 if(!['eth_getBalance','eth_call','eth_estimateGas','eth_gasPrice','eth_getBlockByNumber','eth_getCode','eth_getTransactionReceipt','eth_getTransactionByHash'].includes(method))throw Error('Read method not allowed');
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),15000);
 async function call(m:string,a:unknown[]){const id=++rpcId;const response=await fetch(NETWORKS[network].rpc,{method:'POST',credentials:'omit',headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method:m,params:a}),signal:controller.signal});if(!response.ok)throw Error('RPC unavailable');const out=await response.json();if(out.id!==id||out.error||!('result'in out))throw Error('RPC unavailable');return out.result;}
 try{if(quantity(await call('eth_chainId',[]))!==BigInt(NETWORKS[network].id))throw Error('Wrong read network');return await call(method,params);}catch{throw Error(`Could not verify ${NETWORKS[network].name} balances or network fee. No transaction was requested. Review again later.`);}finally{clearTimeout(timer)}
}
export function parseAmount(text:string,decimals:number){if(!new RegExp(`^(?:0|[1-9][0-9]*)(?:[.,][0-9]{1,${decimals}})?$`).test(text))throw Error(`Enter a decimal amount with at most ${decimals} decimal places.`);const [whole='0',fraction='']=text.replace(',','.').split('.');const n=BigInt(whole)*10n**BigInt(decimals)+BigInt(fraction.padEnd(decimals,'0'));if(n<=0n||n>=2n**256n)throw Error('Enter a positive amount within the token limit.');return n;}
export function format(n:bigint,decimals:number){const s=n.toString().padStart(decimals+1,'0');return decimals?`${s.slice(0,-decimals)}.${s.slice(-decimals)}`.replace(/\.?0+$/,''):s;}
export function transfer(asset:Asset,from:string,to:string,units:bigint){return asset.address?{from,to:asset.address,data:`0xa9059cbb${to.slice(2).toLowerCase().padStart(64,'0')}${units.toString(16).padStart(64,'0')}`,value:'0x0'}:{from,to,value:hex(units)};}
export async function balance(asset:Asset,from:string){if(!validPayAddress(from))throw Error('Invalid sending wallet address.');return quantity(await rpc(asset.network,asset.address?'eth_call':'eth_getBalance',asset.address?[{to:asset.address,data:`0x70a08231${from.slice(2).toLowerCase().padStart(64,'0')}`},'latest']:[from,'latest']));}
export async function nativeBalance(network:Network,from:string){return quantity(await rpc(network,'eth_getBalance',[from,'latest']));}
export const gasMargin=(g:bigint)=>(g*120n+99n)/100n;
export async function fee(asset:Asset,from:string,to:string,units:bigint){const price=quantity(await rpc(asset.network,'eth_gasPrice'));const estimate=quantity(await rpc(asset.network,'eth_estimateGas',[transfer(asset,from,to,units)]));if(price<=0n||estimate<=0n)throw Error('Could not estimate a positive network fee.');const gas=gasMargin(estimate),gasPrice=price*2n;return{gas,gasPrice,fee:gas*gasPrice};}
export async function enough(asset:Asset,from:string,units:bigint,reserve:bigint){if(asset.address&&await balance(asset,from)<units)throw Error(`Insufficient ${asset.symbol} balance.`);const native=await nativeBalance(asset.network,from);if(native<reserve+(asset.address?0n:units))throw Error(`Insufficient ${NETWORKS[asset.network].native} for the amount plus the conservative network fee.`);return native;}
export async function maxNative(asset:Asset,from:string,to:string,guard:()=>Promise<void>){
 if(asset.address)throw Error('Max is available for native assets only.');await guard();let b=await nativeBalance(asset.network,from);const initial=await fee(asset,from,to,1n);let units=b-initial.fee;if(units<=0n)throw Error('Insufficient native balance for network fee.');
 for(let i=0;i<6;i++){await guard();const actual=await fee(asset,from,to,units);b=await nativeBalance(asset.network,from);await guard();if(units+actual.fee<=b)return units;units=b-actual.fee;if(units<=0n)throw Error('Insufficient native balance for network fee.');}
 throw Error('Could not calculate a verified Max for this recipient. Review again.');
}
