import type { Address, Hex } from "viem";
import type { Token } from "./registry.js";
export interface Transaction {
  account: Address;
  chainId: number;
  to: Address;
  data: Hex;
  value: bigint;
  gas?: bigint;
}
export interface WalletAdapter {
  getAccount(): Promise<Address | undefined>;
  getChainId(): Promise<number>;
  sendTransaction(transaction: Transaction): Promise<Hex>;
}
export interface QuoteRequest {
  tokenIn: Token;
  tokenOut: Token;
  amountIn: bigint;
  slippageBps: number;
  account: Address;
}
export type SwapProtocol = "uniswap-v3" | "quickswap-v3-algebra";
export interface Route {
  /** Missing means legacy Uniswap only; all newly discovered routes are explicit. */
  protocol?: SwapProtocol;
  tokens: readonly Address[];
  fees: readonly number[];
  pools: readonly Address[];
  path: Hex;
}
export interface SwapQuote extends QuoteRequest {
  id: string;
  chainId: 137;
  blockNumber: bigint;
  blockHash: Hex;
  blockTimestamp: bigint;
  /** Unix seconds, never JavaScript milliseconds. */
  quotedAt: number;
  /** Unix seconds, bounded by the actual router deadline. */
  expiresAt: number;
  deadline: bigint;
  route: Route;
  amountOut: bigint;
  minAmountOut: bigint;
  gasEstimate: bigint;
  gasEstimateReliability?: "quoter-unpriced" | "conservative-unpriced";
  fullInputVerification?: "inverse-capacity";
  selectionPolicy?: "highest-output-unpriced-gas";
}
export interface QuoteProvider {
  quote(request: QuoteRequest): Promise<SwapQuote>;
}
export type OperationStage = "approval-reset" | "approval" | "swap";
export interface PendingOperation {
  version: 1;
  quoteId: string;
  account: Address;
  chainId: number;
  stage: OperationStage;
  createdAt: number;
  hash?: Hex;
  status: "broadcasting" | "pending" | "confirmed" | "reverted";
  transaction?: { to: Address; data: Hex; value: string };
}
export interface PendingStore {
  get(): PendingOperation | undefined;
  set(operation: PendingOperation): void;
  clear(): void;
  hasCompleted(quoteId: string): boolean;
  markCompleted(quoteId: string): void;
  withLock<T>(operation: () => Promise<T>): Promise<T>;
}
export interface SwapExecutor {
  execute(quote: SwapQuote): Promise<Hex>;
  recover(): Promise<PendingOperation | undefined>;
}
