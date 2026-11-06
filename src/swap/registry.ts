import { checkedAddress, sameAddress } from "../shared/index.js";
import type { Address } from "viem";
export interface Token {
  readonly symbol: string;
  readonly address: Address;
  readonly decimals: number;
  readonly chainId: 137;
  readonly source: string;
  readonly verifiedAt: string;
}
const token = (
  symbol: string,
  address: string,
  decimals: number,
  source: string,
): Token =>
  Object.freeze({
    symbol,
    address: checkedAddress(address),
    decimals,
    chainId: 137,
    source,
    verifiedAt: '2026-10-17',
  });
export const USDT_SOURCE_STRING = "0xc2132D05D31c914a87C6611C10748AEb04B58e8F";
export const TOKENS = Object.freeze({
  USDC: token(
    "USDC",
    "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    6,
    "https://developers.circle.com/stablecoins/usdc-contract-addresses",
  ),
  USDT: token(
    "USDT",
    USDT_SOURCE_STRING,
    6,
    "https://docs.usdt0.to/technical-documentation/deployments",
  ),
  frxUSD: token(
    "frxUSD",
    "0x80Eede496655FB9047dd39d9f418d5483ED600df",
    18,
    "https://raw.githubusercontent.com/FraxFinance/docs/master/pages/frxusd/frxusd-contracts.mdx",
  ),
  WPOL: token(
    "WPOL",
    "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270",
    18,
    "https://developers.uniswap.org/docs/protocols/v3/deployments/v3-polygon-deployments",
  ),
});
export const ALLOWLIST = Object.freeze(Object.values(TOKENS));
export const DIRECTIONS = Object.freeze([
  [TOKENS.USDC, TOKENS.USDT],
  [TOKENS.USDT, TOKENS.USDC],
] as const);
export const CONTRACTS = Object.freeze({
  factory: checkedAddress("0x1F98431c8aD98523631AE4a59f267346ea31F984"),
  quoterV2: checkedAddress("0x61fFE014bA17989E743c5F6cB21bF9697530B21e"),
  router: checkedAddress("0xE592427A0AEce92De3Edee1F18E0157C05861564"),
  router02: checkedAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45"),
});
// Official QuickSwap Polygon PoS V3 Algebra (not Integral/V4 or Base).
export const QUICKSWAP = Object.freeze({
  factory: checkedAddress("0x411b0fAcC3489691f28ad58c47006AF5E3Ab3A28"),
  quoter: checkedAddress("0xa15F0D7377B2A0C0c10db057f641beD21028FC89"),
  router: checkedAddress("0xf5b509bB0909a69B1c207E495f687a596C168E12"),
  poolDeployer: checkedAddress("0x2D98E2FA9da15aa6dC9581AB097Ced7af697CB92"),
});
export const FEES = [100, 500, 3000, 10000] as const;

export function registeredToken(address: string): Token {
  const found = ALLOWLIST.find((t) => sameAddress(t.address, address));
  if (!found) throw new Error("Token is not allowlisted");
  return found;
}
export function assertDirection(tokenIn: Token, tokenOut: Token): void {
  for (const t of [tokenIn, tokenOut]) {
    const canonical = registeredToken(t.address);
    if (
      t.decimals !== canonical.decimals ||
      t.chainId !== canonical.chainId ||
      t.symbol !== canonical.symbol
    )
      throw new Error("Token metadata mismatch");
  }
  if (
    !DIRECTIONS.some(
      ([a, b]) =>
        sameAddress(a.address, tokenIn.address) &&
        sameAddress(b.address, tokenOut.address),
    )
  )
    throw new Error("Unsupported swap direction");
}
