import { createPublicClient, http } from 'viem';
import { polygon } from 'viem/chains';

// Uncoded failures require no visible rejection, revert or other coded failure.
export function canUseIndependentEstimate(error: unknown, timedOut: boolean): boolean {
  if (timedOut || error == null || !['string', 'object'].includes(typeof error)) return false;
  const seen = new Set<object>();
  let codes = 0, unsafe = false, nodes = 0, directCode: unknown;
  const inspect = (value: unknown, depth: number): void => {
    if (typeof value === 'string') {
      if (/revert|reject|denied|declin|cancel|user refused|execution failed|0x08c379a0|0x4e487b71/i.test(value)) unsafe = true;
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (depth > 5 || ++nodes > 40 || seen.has(value)) { unsafe = true; return; }
    seen.add(value);
    try {
      const obj = value as Record<string, unknown>;
      if (obj.code !== undefined && obj.code !== null) { codes++; if (depth === 0) directCode = obj.code; }
      inspect(obj.message, depth + 1);
      for (const key of ['data', 'originalError', 'error', 'cause', 'reason', 'shortMessage', 'details']) inspect(obj[key], depth + 1);
    } catch { unsafe = true; }
  };
  inspect(error, 0);
  if (unsafe) return false;
  if ((directCode === 4200 || directCode === -32601) && codes === 1) return true;
  return codes === 0;
}

export async function independentEstimate(params: { from: `0x${string}`; to: `0x${string}`; data?: `0x${string}`; value?: `0x${string}` }): Promise<`0x${string}`> {
  const client = createPublicClient({ chain: polygon, transport: http(undefined, { timeout: 10000, retryCount: 0 }) });
  if (await client.getChainId() !== polygon.id) throw Error('Wrong network');
  const gas = await client.estimateGas({ account: params.from, to: params.to, data: params.data, value: params.value === undefined ? undefined : BigInt(params.value) });
  if (gas <= 0n || gas >= 2n ** 256n) throw Error('Invalid estimate');
  return `0x${gas.toString(16)}`;
}
