import { createPublicClient, http, parseAbi, hashDomain, toHex, zeroAddress, type Address, type TypedData } from 'viem';
import { polygon } from 'viem/chains';
import { TOKENS } from '../swap/registry';

export const PERMIT_RPC = 'https://rpc-mainnet.matic.quiknode.pro';
export const permitDefinitions = {
  USDC: { address: TOKENS.USDC.address, name: 'USD Coin', version: '2' },
  USDT0: { address: TOKENS.USDT.address, name: 'USDT0', version: '1' },
} as const;
export type PermitToken = keyof typeof permitDefinitions;
export const permitFields = [
  { name: 'owner', type: 'address' }, { name: 'spender', type: 'address' },
  { name: 'value', type: 'uint256' }, { name: 'nonce', type: 'uint256' }, { name: 'deadline', type: 'uint256' },
] as const;
export function diagnosticPermit(token: PermitToken, owner: Address, nonce: bigint) {
  if (!Object.hasOwn(permitDefinitions, token) || nonce < 0n || nonce >= 2n ** 256n) throw new Error('Invalid diagnostic token or nonce');
  const { address, name, version } = permitDefinitions[token];
  const salted = token === 'USDT0';
  const domain = { name, version, verifyingContract: address, ...(salted ? { salt: toHex(137n, { size: 32 }) } : { chainId: 137 }) };
  const EIP712Domain = salted ? [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'verifyingContract', type: 'address' }, { name: 'salt', type: 'bytes32' }] as const
    : [{ name: 'name', type: 'string' }, { name: 'version', type: 'string' }, { name: 'chainId', type: 'uint256' }, { name: 'verifyingContract', type: 'address' }] as const;
  return { domain, types: { EIP712Domain, Permit: permitFields }, primaryType: 'Permit' as const,
    message: { owner, spender: zeroAddress, value: '0', nonce: String(nonce), deadline: '1' } };
}
// Exact structural equality: no caller-supplied domains/extra fields/unsafe overrides.
export function assertDiagnosticPermit(data: ReturnType<typeof diagnosticPermit>, token: PermitToken, owner: Address, nonce: bigint) {
  if (JSON.stringify(data) !== JSON.stringify(diagnosticPermit(token, owner, nonce))) throw new Error('Unsafe diagnostic permit refused');
}
const abi = parseAbi(['function DOMAIN_SEPARATOR() view returns(bytes32)', 'function nonces(address) view returns(uint256)']);
// Only fixed chain and read methods; never a wallet transport or arbitrary RPC request.
const client = createPublicClient({ chain: polygon, transport: http(PERMIT_RPC, { timeout: 12_000, retryCount: 0, fetchOptions: { redirect: 'error', credentials: 'omit' } }) });
export async function readDiagnosticPermit(token: PermitToken, owner: Address, guard: () => Promise<void> = async () => {}) {
  const checked = async <T,>(read: () => Promise<T>) => { await guard(); const value = await read(); await guard(); return value; };
  if (!Object.hasOwn(permitDefinitions, token)) throw new Error('Unsupported diagnostic token');
  if (await checked(() => client.getChainId()) !== 137) throw new Error('Diagnostic RPC network mismatch');
  const block = await checked(() => client.getBlock());
  if (block.timestamp <= 1n || Math.abs(Date.now() / 1000 - Number(block.timestamp)) > 300) throw new Error('Diagnostic RPC block is stale');
  const address = permitDefinitions[token].address;
  const nonce = await checked(() => client.readContract({ address, abi, functionName: 'nonces', args: [owner], blockNumber: block.number }));
  const separator = await checked(() => client.readContract({ address, abi, functionName: 'DOMAIN_SEPARATOR', blockNumber: block.number }));
  const data = diagnosticPermit(token, owner, nonce);
  if (hashDomain({ domain: data.domain, types: data.types as TypedData }) !== separator) throw new Error('Diagnostic token domain mismatch');
  if ((await checked(() => client.getBlock({ blockNumber: block.number }))).hash !== block.hash) throw new Error('Diagnostic RPC block changed');
  return { data, nonce };
}
