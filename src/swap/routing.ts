import {
  concatHex,
  getAddress,
  numberToHex,
  zeroAddress,
  type Address,
  type Hex,
  type PublicClient,
} from "viem";
import { sameAddress } from "../shared/index.js";
import { ALLOWLIST, CONTRACTS, FEES, registeredToken } from "./registry.js";
import { factoryAbi, poolAbi } from "./abi.js";
import type { Route, SwapProtocol } from "./types.js";
import { algebraRoutes, discoverAlgebraPools } from "./algebra.js";
export interface Pool {
  protocol?: SwapProtocol;
  address: Address;
  token0: Address;
  token1: Address;
  fee: number;
  liquidity: bigint;
}
export interface Discovery {
  pools: Pool[];
  errors: string[];
  blockNumber: bigint;
}
export async function mapLimit<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const output: R[] = new Array(items.length);
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (cursor < items.length) {
        const i = cursor++;
        output[i] = await fn(items[i]!);
      }
    }),
  );
  return output;
}
export function encodePath(
  tokens: readonly Address[],
  fees: readonly number[],
): Hex {
  if (fees.length < 1 || fees.length > 3 || tokens.length !== fees.length + 1)
    throw new Error("Route must have 1–3 hops");
  const normalized = tokens.map((t) => registeredToken(t).address);
  if (new Set(normalized.map((t) => t.toLowerCase())).size !== tokens.length)
    throw new Error("Cyclic route");
  if (fees.some((f) => !FEES.includes(f as (typeof FEES)[number])))
    throw new Error("Unsupported fee");
  const parts: Hex[] = [normalized[0]!];
  fees.forEach((fee, i) =>
    parts.push(numberToHex(fee, { size: 3 }), normalized[i + 1]!),
  );
  return concatHex(parts).toLowerCase() as Hex;
}
export function enumerateRoutes(
  pools: readonly Pool[],
  tokenIn: Address,
  tokenOut: Address,
): Route[] {
  registeredToken(tokenIn);
  registeredToken(tokenOut);
  const routes: Route[] = [];
  function visit(tokens: Address[], fees: number[], addresses: Address[]) {
    const last = tokens[tokens.length - 1]!;
    if (sameAddress(last, tokenOut) && fees.length > 0) {
      routes.push({
        protocol: "uniswap-v3",
        tokens,
        fees,
        pools: addresses,
        path: encodePath(tokens, fees),
      });
      return;
    }
    if (fees.length === 3) return;
    for (const pool of pools) {
      if (pool.protocol && pool.protocol !== "uniswap-v3") continue;
      if (pool.liquidity <= 0n) continue;
      const next = sameAddress(pool.token0, last)
        ? pool.token1
        : sameAddress(pool.token1, last)
          ? pool.token0
          : undefined;
      if (!next || tokens.some((t) => sameAddress(t, next))) continue;
      registeredToken(next);
      visit(
        [...tokens, next],
        [...fees, pool.fee],
        [...addresses, pool.address],
      );
    }
  }
  visit([tokenIn], [], []);
  return [...routes, ...algebraRoutes(pools, tokenIn, tokenOut)];
}
export async function discoverPools(
  client: PublicClient,
  blockNumber: bigint,
): Promise<Discovery> {
  const requests: { a: Address; b: Address; fee: number }[] = [];
  for (let i = 0; i < ALLOWLIST.length; i++)
    for (let j = i + 1; j < ALLOWLIST.length; j++) {
      for (const fee of FEES)
        requests.push({
          a: ALLOWLIST[i]!.address,
          b: ALLOWLIST[j]!.address,
          fee,
        });
    }
  const errors: string[] = [];
  const results = await mapLimit(requests, 3, async ({ a, b, fee }) => {
    try {
      const address = await client.readContract({
        address: CONTRACTS.factory,
        abi: factoryAbi,
        functionName: "getPool",
        args: [a, b, fee],
        blockNumber,
      });
      if (sameAddress(address, zeroAddress)) return undefined;
      const [token0, token1, actualFee, factory, liquidity] = await Promise.all(
        [
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "token0",
            blockNumber,
          }),
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "token1",
            blockNumber,
          }),
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "fee",
            blockNumber,
          }),
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "factory",
            blockNumber,
          }),
          client.readContract({
            address,
            abi: poolAbi,
            functionName: "liquidity",
            blockNumber,
          }),
        ],
      );
      if (
        !sameAddress(factory, CONTRACTS.factory) ||
        actualFee !== fee ||
        ![a, b].every(
          (t) => sameAddress(t, token0) || sameAddress(t, token1),
        ) ||
        sameAddress(token0, token1)
      )
        throw new Error("Pool identity mismatch");
      return {
        protocol: "uniswap-v3",
        address: getAddress(address),
        token0,
        token1,
        fee,
        liquidity,
      } satisfies Pool;
    } catch (e) {
      errors.push(
        `${a}/${b}/${fee}: ${e instanceof Error ? e.message.slice(0, 500) : "RPC error"}`,
      );
      return undefined;
    }
  });
  const algebra = await discoverAlgebraPools(client, blockNumber);
  return {
    pools: [...results.filter((p): p is NonNullable<typeof p> => p !== undefined), ...algebra.pools],
    errors: [...errors, ...algebra.errors],
    blockNumber,
  };
}
