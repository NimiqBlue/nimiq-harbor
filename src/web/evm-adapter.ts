import { getAddress, numberToHex, type Hex } from 'viem';
import type { WalletAdapter, Transaction } from '../swap/types';
import { ALLOWLIST, CONTRACTS } from '../swap/registry';
import { sameAddress } from '../shared/index';
import { authorizedAccount, parseAccount, type HarborProvider } from './wallet';
/** Real injected EIP-1193 transport. Not wired to any staging swap CTA. */
export class InjectedWalletAdapter implements WalletAdapter {
  constructor(private provider: HarborProvider, private options: { mainnetSigningEnabled?: boolean; selectedAccount?: Hex } = {}) {}
  async getAccount() {
    const accounts = await this.provider.request({method:'eth_accounts'});
    const account = this.options.selectedAccount ? authorizedAccount(accounts, this.options.selectedAccount) : parseAccount(accounts);
    return account ? getAddress(account) : undefined;
  }
  async getChainId() {
    const chain=await this.provider.request({method:'eth_chainId'});
    if(typeof chain!=='string'||!/^0x[0-9a-f]+$/i.test(chain))throw new Error('Invalid wallet chain');
    const id=Number(BigInt(chain));if(!Number.isSafeInteger(id))throw new Error('Invalid wallet chain');return id;
  }
  async sendTransaction(transaction: Transaction): Promise<Hex> {
    const tx=structuredClone(transaction);
    if(tx.chainId!==31337 && !(tx.chainId===137 && this.options.mainnetSigningEnabled))throw new Error('Wallet broadcast disabled for this environment');
    if(tx.value!==0n || ![CONTRACTS.router,...ALLOWLIST.map(t=>t.address)].some(to=>sameAddress(to,tx.to)))throw new Error('Unexpected swap transaction destination or native value');
    const [account,chainId]=await Promise.all([this.getAccount(),this.getChainId()]);
    if(!account||!sameAddress(account,tx.account)||chainId!==tx.chainId)throw new Error('Wallet account or chain changed before submission');
    const hash=await this.provider.request({method:'eth_sendTransaction',params:[{from:account,to:tx.to,data:tx.data,value:'0x0',chainId:numberToHex(chainId),...(tx.gas ? {gas:numberToHex(tx.gas)} : {})}]});
    if(typeof hash!=='string'||!/^0x[0-9a-f]{64}$/i.test(hash))throw new Error('Wallet submission result is unknown. Reconcile; do not resend.');
    return hash as Hex;
  }
}
