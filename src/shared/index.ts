import {
  formatUnits,
  getAddress,
  isAddress,
  parseUnits,
  type Address,
} from "viem";

export function checkedAddress(value: string): Address {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value))
    throw new Error("Invalid address length or characters");
  if (!isAddress(value, { strict: true }))
    throw new Error("Invalid address checksum");
  return getAddress(value);
}
export function parseAmount(text: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new Error("Invalid decimals");
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(text))
    throw new Error("Use a positive decimal amount");
  if ((text.split(".")[1]?.length ?? 0) > decimals)
    throw new Error("Too many decimal places");
  const value = parseUnits(text, decimals);
  if (value <= 0n || value > (1n << 256n) - 1n)
    throw new Error("Amount out of range");
  return value;
}
export const formatAmount = (value: bigint, decimals: number): string =>
  formatUnits(value, decimals);
export const sameAddress = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();
export const jsonBigint = (_key: string, value: unknown): unknown =>
  typeof value === "bigint" ? value.toString() : value;
