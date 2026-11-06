import { encodeAbiParameters, keccak256, type PublicClient } from "viem";
import { checkedAddress } from "../shared/index.js";
import { CONTRACTS, assertDirection } from "./registry.js";
import {
  discoverPools,
  enumerateRoutes,
  mapLimit,
  type Discovery,
} from "./routing.js";
import { quoterAbi } from "./abi.js";
import { quoteAlgebra, routeProtocol } from "./algebra.js";
import type { QuoteProvider, QuoteRequest, SwapQuote } from "./types.js";
export const QUOTE_TTL_SECONDS = 120;
export const MAX_SLIPPAGE_BPS = 2000;
export function minimumOutput(amountOut: bigint, slippageBps: number): bigint {
  if (
    !Number.isInteger(slippageBps) ||
    slippageBps < 0 ||
    slippageBps > MAX_SLIPPAGE_BPS
  )
    throw new Error("Slippage must be 0–2000 basis points");
  if (amountOut <= 0n || amountOut >= 1n << 256n)
    throw new Error("Invalid quote output");
  const min = (amountOut * BigInt(10000 - slippageBps)) / 10000n;
  if (min <= 0n) throw new Error("Minimum output rounds to zero");
  return min;
}
export function validateRequest(request: QuoteRequest): void {
  assertDirection(request.tokenIn, request.tokenOut);
  checkedAddress(request.account);
  if (request.amountIn <= 0n || request.amountIn >= 1n << 256n)
    throw new Error("Invalid input amount");
  minimumOutput(10000n, request.slippageBps);
}
export function quoteId(q: Omit<SwapQuote, "id">): string {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "bytes" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        q.account,
        q.tokenIn.address,
        q.tokenOut.address,
        q.amountIn,
        q.amountOut,
        q.minAmountOut,
        routeProtocol(q.route) === "quickswap-v3-algebra" ? (`0x01${q.route.path.slice(2)}` as const) : q.route.path,
        q.blockHash,
        q.deadline,
        BigInt(q.quotedAt),
        BigInt(q.expiresAt),
      ],
    ),
  );
}
export class ViemQuoteProvider implements QuoteProvider {
  private cache?: { blockHash: string; discovery: Discovery };
  constructor(readonly client: PublicClient) {}
  async quote(request: QuoteRequest): Promise<SwapQuote> {
    const snapshot = structuredClone(request);
    validateRequest(snapshot);
    return this.quoteAt(
      snapshot,
      await this.client.getBlockNumber({ cacheTime: 0 }),
    );
  }
  async discoveryAt(blockNumber: bigint): Promise<Discovery> {
    const block = await this.client.getBlock({ blockNumber });
    if (!block.hash) throw new Error("Discovery requires a mined block");
    if (
      !this.cache ||
      this.cache.discovery.blockNumber !== blockNumber ||
      this.cache.blockHash !== block.hash
    ) {
      const discovery = await discoverPools(this.client, blockNumber);
      const after = await this.client.getBlock({ blockNumber });
      if (after.hash !== block.hash)
        throw new Error("Pinned block reorged during pool discovery");
      this.cache = { blockHash: block.hash, discovery };
    }
    return structuredClone(this.cache.discovery);
  }
  async quoteAt(
    request: QuoteRequest,
    blockNumber: bigint,
  ): Promise<SwapQuote> {
    request = structuredClone(request);
    validateRequest(request);
    const chainId = await this.client.getChainId();
    if (
      chainId !== 137 &&
      !(chainId === 31337 && this.client.chain?.id === 31337)
    )
      throw new Error("Quote RPC must be Polygon or explicit local fork");
    const block = await this.client.getBlock({ blockNumber });
    if (!block.hash) throw new Error("Quote requires a mined block");
    const discovery = await this.discoveryAt(blockNumber);
    if (discovery.errors.length)
      throw new Error(
        `Incomplete pool discovery: ${discovery.errors.length} RPC/identity errors`,
      );
    const routes = enumerateRoutes(
      discovery.pools,
      request.tokenIn.address,
      request.tokenOut.address,
    );
    if (!routes.length)
      throw new Error("No allowlisted 1–3 hop route with active liquidity");
    const attempts = await mapLimit(routes, 2, async (route) => {
      try {
        if (routeProtocol(route) === "quickswap-v3-algebra")
          return { route, ...await quoteAlgebra(this.client, route, request.amountIn, blockNumber) };
        const { result } = await this.client.simulateContract({
          address: CONTRACTS.quoterV2,
          abi: quoterAbi,
          functionName: "quoteExactInput",
          args: [route.path, request.amountIn],
          blockNumber,
        });
        return { route, amountOut: result[0], gasEstimate: result[3], gasEstimateReliability: "quoter-unpriced" as const };
      } catch {
        return undefined;
      }
    });
    const valid = attempts
      .filter(
        (a): a is NonNullable<typeof a> => a !== undefined && a.amountOut > 0n,
      )
      .sort((a, b) =>
        a.amountOut === b.amountOut ? 0 : a.amountOut > b.amountOut ? -1 : 1,
      );
    const best = valid[0];
    if (!best)
      throw new Error(
        `Quote unavailable: all ${routes.length} Quoter simulations failed or lacked full-input capacity`,
      );
    const after = await this.client.getBlock({ blockNumber });
    if (after.hash !== block.hash)
      throw new Error("Pinned block reorged during quote");
    const now = Math.floor(Date.now() / 1000);
    const quote: Omit<SwapQuote, "id"> = {
      ...request,
      ...best,
      selectionPolicy: "highest-output-unpriced-gas",
      chainId: 137,
      blockNumber,
      blockHash: block.hash,
      blockTimestamp: block.timestamp,
      quotedAt: now,
      expiresAt: Math.min(
        now + QUOTE_TTL_SECONDS,
        Number(block.timestamp) + QUOTE_TTL_SECONDS,
      ),
      deadline: block.timestamp + BigInt(QUOTE_TTL_SECONDS),
      minAmountOut: minimumOutput(best.amountOut, request.slippageBps),
    };
    return { ...quote, id: quoteId(quote) };
  }
}
