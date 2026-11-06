import { verifyMessage, type Address, type Hex } from 'viem';

// Preserve r/s and message bytes; only canonicalize the recovery parity byte.
export function canonicalPersonalSignature(value: unknown): Hex {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(value)) throw new Error('signature');
  const parity = Number.parseInt(value.slice(-2), 16);
  if (![0, 1, 27, 28].includes(parity)) throw new Error('signature parity');
  return `${value.slice(0, -2)}${(parity < 2 ? parity + 27 : parity).toString(16)}` as Hex;
}

export async function verifiedPersonalSignature(address: Address, message: string, value: unknown): Promise<Hex> {
  const canonical = canonicalPersonalSignature(value);
  // Verify the wallet's original response independently before displaying a conversion.
  if (!await verifyMessage({ address, message, signature: value as Hex })) throw new Error('original signature');
  if (!await verifyMessage({ address, message, signature: canonical })) throw new Error('canonical signature');
  return canonical;
}
