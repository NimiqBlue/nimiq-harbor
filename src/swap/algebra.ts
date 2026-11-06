import { concatHex, zeroAddress, type Address, type Hex, type PublicClient } from "viem";
import { sameAddress } from "../shared/index.js";
import { ALLOWLIST, QUICKSWAP, registeredToken } from "./registry.js";
import { algebraFactoryAbi, algebraPoolAbi, algebraQuoterAbi, algebraRouterAbi } from "./abi.js";
import type { Discovery, Pool } from "./routing.js";
import type { Route } from "./types.js";

export function routeProtocol(route: Route) {
  const protocol = route.protocol ?? "uniswap-v3";
  if (protocol !== "uniswap-v3" && protocol !== "quickswap-v3-algebra")
    throw new Error("Unsupported route protocol");
  return protocol;
}
export function encodeAlgebraPath(tokens: readonly Address[]): Hex {
  // Deliberately direct-only initially: no cross-router/mixed-protocol paths.
  if (tokens.length !== 2 || sameAddress(tokens[0]!, tokens[1]!))
    throw new Error("Algebra requires a noncyclic direct route");
  return concatHex(tokens.map(t => registeredToken(t).address)).toLowerCase() as Hex;
}
export async function verifyAlgebraPeriphery(client: PublicClient, blockNumber?: bigint) {
  for (const address of [QUICKSWAP.router, QUICKSWAP.quoter]) {
    const abi = address === QUICKSWAP.router ? algebraRouterAbi : algebraQuoterAbi;
    const factory = await client.readContract({ address, abi, functionName: "factory", blockNumber });
    const deployer = await client.readContract({ address, abi, functionName: "poolDeployer", blockNumber });
    if (!sameAddress(factory, QUICKSWAP.factory) || !sameAddress(deployer, QUICKSWAP.poolDeployer))
      throw new Error("Algebra periphery identity mismatch");
  }
}
export async function discoverAlgebraPools(client: PublicClient, blockNumber: bigint): Promise<Discovery> {
  const pools: Pool[] = [], errors: string[] = [];
  for (let i = 0; i < ALLOWLIST.length; i++) for (let j = i + 1; j < ALLOWLIST.length; j++) {
    const a = ALLOWLIST[i]!.address, b = ALLOWLIST[j]!.address;
    try {
      const address = await client.readContract({ address: QUICKSWAP.factory, abi: algebraFactoryAbi, functionName: "poolByPair", args: [a, b], blockNumber });
      if (sameAddress(address, zeroAddress)) continue;
      const token0 = await client.readContract({ address, abi: algebraPoolAbi, functionName: "token0", blockNumber });
      const token1 = await client.readContract({ address, abi: algebraPoolAbi, functionName: "token1", blockNumber });
      const factory = await client.readContract({ address, abi: algebraPoolAbi, functionName: "factory", blockNumber });
      const liquidity = await client.readContract({ address, abi: algebraPoolAbi, functionName: "liquidity", blockNumber });
      const state = await client.readContract({ address, abi: algebraPoolAbi, functionName: "globalState", blockNumber });
      if (!sameAddress(factory, QUICKSWAP.factory) || sameAddress(token0, token1) ||
          ![a, b].every(t => sameAddress(t, token0) || sameAddress(t, token1)) || !state[6] || state[0] <= 0n)
        throw new Error("Algebra pool identity/state mismatch");
      pools.push({ protocol: "quickswap-v3-algebra", address, token0, token1, liquidity, fee: state[2] });
    } catch (e) { errors.push(`Algebra ${a}/${b}: ${e instanceof Error ? e.message.slice(0, 300) : "RPC error"}`); }
  }
  if (pools.length) {
    try { await verifyAlgebraPeriphery(client, blockNumber); }
    catch { errors.push("Algebra periphery identity verification failed"); }
  }
  return { pools, errors, blockNumber };
}
export function algebraRoutes(pools: readonly Pool[], tokenIn: Address, tokenOut: Address): Route[] {
  return pools.filter(p => p.protocol === "quickswap-v3-algebra" && p.liquidity > 0n &&
    [tokenIn, tokenOut].every(t => sameAddress(t, p.token0) || sameAddress(t, p.token1))).map(p => ({
      protocol: "quickswap-v3-algebra", tokens: [tokenIn, tokenOut], fees: [p.fee], pools: [p.address], path: encodeAlgebraPath([tokenIn, tokenOut]),
    }));
}
export async function quoteAlgebra(client: PublicClient, route: Route, amountIn: bigint, blockNumber?: bigint) {
  if (routeProtocol(route) !== "quickswap-v3-algebra" || encodeAlgebraPath(route.tokens) !== route.path.toLowerCase())
    throw new Error("Invalid Algebra route");
  const args = [route.tokens[0]!, route.tokens[1]!] as const;
  // A live executor recheck must resolve latest once, not independently for each
  // Quoter call: an advancing head can otherwise make the inverse incomparable.
  // getBlock reads latest directly (no cached getBlockNumber); explicit research
  // pins remain historical. Verify that height's identity again before accepting.
  const block = await client.getBlock(blockNumber === undefined ? { blockTag: "latest" } : { blockNumber });
  if (!block.hash || block.number === null) throw new Error("Algebra capacity check requires a mined block");
  blockNumber = block.number;
  const { result } = await client.simulateContract({ address: QUICKSWAP.quoter, abi: algebraQuoterAbi, functionName: "quoteExactInputSingle", args: [...args, amountIn, 0n], blockNumber });
  const amountOut = result[0];
  if (amountOut <= 0n || amountOut >= (1n << 256n) - 1n) throw new Error("Invalid Algebra output");
  // Algebra V1 exact-input Quoter can silently partially fill. Its exact-output
  // Quoter with limit=0 requires the complete requested output. Probe one output
  // unit beyond the quote: a range-boundary plateau MUST revert, not be accepted.
  // The inverse must also cost strictly more than the requested input; otherwise
  // the diagnostic is inconsistent. Conservative: boundary/dust quotes may fail.
  const inverse = await client.simulateContract({ address: QUICKSWAP.quoter, abi: algebraQuoterAbi, functionName: "quoteExactOutputSingle", args: [...args, amountOut + 1n, 0n], blockNumber });
  if (inverse.result[0] <= amountIn) throw new Error("Algebra partial fill or inconsistent inverse capacity");
  const after = await client.getBlock({ blockNumber });
  if (after.hash !== block.hash) throw new Error("Pinned block reorged during Algebra capacity check");
  return { amountOut, dynamicFeePips: result[1], gasEstimate: 500000n,
    gasEstimateReliability: "conservative-unpriced" as const,
    fullInputVerification: "inverse-capacity" as const };
}
