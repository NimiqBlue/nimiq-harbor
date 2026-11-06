import {
  decodeFunctionData,
  decodeFunctionResult,
  encodeFunctionData,
  erc20Abi,
  type Hex,
  type PublicClient,
} from "viem";
import { sameAddress } from "../shared/index.js";
import { CONTRACTS, QUICKSWAP } from "./registry.js";
import { routerAbi, factoryAbi, quoterAbi, algebraFactoryAbi, algebraRouterAbi } from "./abi.js";
import { encodeAlgebraPath, quoteAlgebra, routeProtocol, verifyAlgebraPeriphery } from "./algebra.js";
import { encodePath } from "./routing.js";
import {
  minimumOutput,
  quoteId,
  validateRequest,
  QUOTE_TTL_SECONDS,
} from "./quote.js";
import type {
  PendingOperation,
  PendingStore,
  SwapExecutor,
  SwapQuote,
  Transaction,
  WalletAdapter,
} from "./types.js";

export interface ExecutorOptions {
  expectedChainId?: 137 | 31337;
  /** Intentionally false by default. Never enable in automated tests. */
  mainnetSigningEnabled?: boolean;
  now?: () => number;
  receiptTimeoutMs?: number;
}
export function buildSwapTransaction(
  quote: SwapQuote,
  chainId: number,
): Transaction {
  validateRequest(quote);
  if (
    quote.minAmountOut !== minimumOutput(quote.amountOut, quote.slippageBps) ||
    quote.minAmountOut <= 0n
  )
    throw new Error("Unsafe minimum output");
  if (quote.id !== quoteId(quote)) throw new Error("Quote was modified");
  const algebra = routeProtocol(quote.route) === "quickswap-v3-algebra";
  if (
    (algebra ? encodeAlgebraPath(quote.route.tokens) : encodePath(quote.route.tokens, quote.route.fees)).toLowerCase() !==
      quote.route.path.toLowerCase() ||
    !sameAddress(quote.route.tokens[0]!, quote.tokenIn.address) ||
    !sameAddress(quote.route.tokens.at(-1)!, quote.tokenOut.address) ||
    quote.route.pools.length !== quote.route.fees.length
  )
    throw new Error("Invalid quote route");
  if (algebra && (quote.route.pools.length !== 1 || quote.route.fees.length !== 1 || quote.fullInputVerification !== "inverse-capacity"))
    throw new Error("Unverified Algebra input capacity");
  const data = encodeFunctionData({
    abi: algebra ? algebraRouterAbi : routerAbi,
    functionName: "exactInput",
    args: [
      {
        path: quote.route.path,
        recipient: quote.account,
        deadline: quote.deadline,
        amountIn: quote.amountIn,
        amountOutMinimum: quote.minAmountOut,
      },
    ],
  });
  const decoded = decodeFunctionData({ abi: routerAbi, data });
  if (
    decoded.functionName !== "exactInput" ||
    decoded.args[0].deadline !== quote.deadline ||
    decoded.args[0].amountOutMinimum <= 0n ||
    decoded.args[0].amountIn !== quote.amountIn ||
    !sameAddress(decoded.args[0].recipient, quote.account)
  )
    throw new Error("Unsafe router calldata");
  return {
    account: quote.account,
    chainId,
    to: algebra ? QUICKSWAP.router : CONTRACTS.router,
    data,
    value: 0n,
  };
}
export class GuardedSwapExecutor implements SwapExecutor {
  private busy = false;
  private readonly chainId: 137 | 31337;
  private readonly now: () => number;
  constructor(
    readonly wallet: WalletAdapter,
    readonly client: PublicClient,
    readonly store: PendingStore,
    readonly options: ExecutorOptions = {},
  ) {
    this.chainId = options.expectedChainId ?? 137;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }
  private async identity(q?: SwapQuote): Promise<void> {
    if (this.chainId === 137 && !this.options.mainnetSigningEnabled)
      throw new Error("Mainnet signing disabled");
    const [account, walletChain, rpcChain] = await Promise.all([
      this.wallet.getAccount(),
      this.wallet.getChainId(),
      this.client.getChainId(),
    ]);
    if (
      walletChain !== this.chainId ||
      rpcChain !== this.chainId ||
      (this.chainId !== 137 && this.chainId !== 31337)
    )
      throw new Error("Wallet/RPC chain mismatch");
    if (!account || (q && !sameAddress(account, q.account)))
      throw new Error("Wallet account changed or disconnected");
  }
  private async freshness(q: SwapQuote): Promise<void> {
    const now = this.now();
    if (
      q.chainId !== 137 ||
      !Number.isSafeInteger(q.quotedAt) ||
      !Number.isSafeInteger(q.expiresAt) ||
      q.quotedAt > now + 5 ||
      now >= q.expiresAt ||
      now - q.quotedAt > QUOTE_TTL_SECONDS ||
      q.expiresAt > q.quotedAt + QUOTE_TTL_SECONDS ||
      q.expiresAt <= q.quotedAt ||
      q.deadline > q.blockTimestamp + BigInt(QUOTE_TTL_SECONDS)
    )
      throw new Error("Stale or invalid quote");
    const [head, pinned] = await Promise.all([
      this.client.getBlock(),
      this.client.getBlock({ blockNumber: q.blockNumber }),
    ]);
    if (
      pinned.hash !== q.blockHash ||
      pinned.timestamp !== q.blockTimestamp ||
      head.number === null ||
      head.number < q.blockNumber ||
      head.number - q.blockNumber > 60n ||
      head.timestamp >= q.deadline ||
      q.deadline <= q.blockTimestamp
    )
      throw new Error("Quote expired, too old, or reorged");
  }
  private async verifyTransaction(
    operation: PendingOperation,
    hash: Hex,
  ): Promise<void> {
    if (!operation.transaction)
      throw new Error(
        "Pending transaction details missing; reconcile manually",
      );
    const tx = await this.client.getTransaction({ hash });
    if (
      !tx.to ||
      !sameAddress(tx.from, operation.account) ||
      !sameAddress(tx.to, operation.transaction.to) ||
      tx.input.toLowerCase() !== operation.transaction.data.toLowerCase() ||
      tx.value !== BigInt(operation.transaction.value) ||
      (tx.chainId !== undefined && tx.chainId !== operation.chainId)
    )
      throw new Error(
        "Wallet broadcast transaction does not match approved intent",
      );
  }
  private async send(
    tx: Transaction,
    q: SwapQuote,
    stage: PendingOperation["stage"],
  ): Promise<Hex> {
    await this.identity(q);
    await this.freshness(q);
    const simulation = await this.client.call({
      account: tx.account,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    });
    if (stage === "swap") {
      if (
        !simulation.data ||
        decodeFunctionResult({
          abi: routerAbi,
          functionName: "exactInput",
          data: simulation.data,
        }) < q.minAmountOut
      )
        throw new Error("Swap simulation below minimum");
    } else if (
      simulation.data &&
      simulation.data !== "0x" &&
      !decodeFunctionResult({
        abi: erc20Abi,
        functionName: "approve",
        data: simulation.data,
      })
    )
      throw new Error("Token approval simulation returned false");
    const [gas, gasPrice, balance] = await Promise.all([
      this.client.estimateGas({
        account: tx.account,
        to: tx.to,
        data: tx.data,
        value: tx.value,
      }),
      this.client.getGasPrice(),
      this.client.getBalance({ address: tx.account }),
    ]);
    tx.gas = (gas * 125n) / 100n;
    if (balance < tx.gas * gasPrice * 2n)
      throw new Error("Insufficient POL for gas safety reserve");
    // Recheck after asynchronous preflight; adapters must pass explicit account and chain to wallet.
    await this.identity(q);
    await this.freshness(q);
    const operation: PendingOperation = {
      version: 1,
      quoteId: q.id,
      account: q.account,
      chainId: this.chainId,
      stage,
      createdAt: this.now(),
      status: "broadcasting",
      transaction: { to: tx.to, data: tx.data, value: tx.value.toString() },
    };
    this.store.set(operation); // write-ahead: storage failure prevents signing
    // Unknown wallet errors remain blocking: the wallet may have broadcast before failing.
    const hash = await this.wallet.sendTransaction(tx);
    operation.hash = hash;
    operation.status = "pending";
    this.store.set(operation);
    const receipt = await this.client.waitForTransactionReceipt({
      hash,
      confirmations: 2,
      timeout: this.options.receiptTimeoutMs ?? 120000,
    });
    await this.verifyTransaction(operation, receipt.transactionHash);
    operation.hash = receipt.transactionHash;
    // Persist consumption before releasing the pending barrier. If this write fails,
    // the previous pending record must remain blocking, including for other quotes.
    if (stage === "swap" && receipt.status === "success")
      this.store.markCompleted(q.id);
    operation.status = receipt.status === "success" ? "confirmed" : "reverted";
    this.store.set(operation);
    if (operation.status === "reverted")
      throw new Error(`${stage} transaction reverted`);
    return receipt.transactionHash;
  }
  async execute(input: SwapQuote): Promise<Hex> {
    if (this.busy) throw new Error("Swap already in progress");
    this.busy = true;
    try {
      // Snapshot caller-owned data before asynchronous wallet/RPC operations.
      const q = structuredClone(input);
      return await this.store.withLock(async () => {
        await this.identity(q);
        const previous = this.store.get();
        if (
          this.store.hasCompleted(q.id) ||
          (previous?.stage === "swap" && previous.quoteId === q.id)
        )
          throw new Error("Quote already submitted");
        if (
          previous &&
          (previous.status === "broadcasting" || previous.status === "pending")
        )
          throw new Error(
            "Pending transaction requires recovery; do not resubmit",
          );
        if (previous) this.store.clear();
        const tx = buildSwapTransaction(q, this.chainId);
        const algebra = routeProtocol(q.route) === "quickswap-v3-algebra";
        const spender = algebra ? QUICKSWAP.router : CONTRACTS.router;
        await this.freshness(q);
        if (algebra) await verifyAlgebraPeriphery(this.client);
        for (let i = 0; i < q.route.fees.length; i++) {
          const pool = algebra ? await this.client.readContract({
            address: QUICKSWAP.factory, abi: algebraFactoryAbi, functionName: "poolByPair",
            args: [q.route.tokens[i]!, q.route.tokens[i + 1]!],
          }) : await this.client.readContract({
            address: CONTRACTS.factory,
            abi: factoryAbi,
            functionName: "getPool",
            args: [
              q.route.tokens[i]!,
              q.route.tokens[i + 1]!,
              q.route.fees[i]!,
            ],
          });
          if (!sameAddress(pool, q.route.pools[i]!))
            throw new Error("Quote pool identity mismatch");
        }
        const currentOut = algebra ? (await quoteAlgebra(this.client, q.route, q.amountIn)).amountOut : (await this.client.simulateContract({
          address: CONTRACTS.quoterV2,
          abi: quoterAbi,
          functionName: "quoteExactInput",
          args: [q.route.path, q.amountIn],
        })).result[0];
        if (currentOut < q.minAmountOut)
          throw new Error("Price moved below quote minimum");
        const [nativeBalance, gasPrice] = await Promise.all([
          this.client.getBalance({ address: q.account }),
          this.client.getGasPrice(),
        ]);
        if (
          q.gasEstimate <= 0n ||
          nativeBalance < (q.gasEstimate + 350000n) * gasPrice * 2n
        )
          throw new Error("Insufficient POL for swap and approval gas reserve");
        const balance = await this.client.readContract({
          address: q.tokenIn.address,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [q.account],
        });
        if (balance < q.amountIn) throw new Error("Insufficient token balance");
        const allowance = () =>
          this.client.readContract({
            address: q.tokenIn.address,
            abi: erc20Abi,
            functionName: "allowance",
            args: [q.account, spender],
          });
        const approve = (amount: bigint) => ({
          account: q.account,
          chainId: this.chainId,
          to: q.tokenIn.address,
          value: 0n,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [spender, amount],
          }),
        });
        const existing = await allowance();
        if (existing < q.amountIn) {
          if (existing > 0n) {
            await this.send(approve(0n), q, "approval-reset");
            if ((await allowance()) !== 0n)
              throw new Error("Approval reset not reflected on-chain");
          }
          await this.send(approve(q.amountIn), q, "approval");
          if ((await allowance()) < q.amountIn)
            throw new Error("Approval not reflected on-chain");
        }
        await this.identity(q);
        await this.freshness(q);
        if ((await allowance()) < q.amountIn)
          throw new Error("Allowance changed");
        if (algebra && (await quoteAlgebra(this.client, q.route, q.amountIn)).amountOut < q.minAmountOut)
          throw new Error("Price moved below quote minimum");
        return this.send(tx, q, "swap");
      });
    } finally {
      this.busy = false;
    }
  }
  async recover(): Promise<PendingOperation | undefined> {
    return this.store.withLock(async () => {
      const operation = this.store.get();
      if (!operation) return undefined;
      const [account, chain, rpcChain] = await Promise.all([
        this.wallet.getAccount(),
        this.wallet.getChainId(),
        this.client.getChainId(),
      ]);
      if (
        !account ||
        !sameAddress(account, operation.account) ||
        chain !== operation.chainId ||
        rpcChain !== operation.chainId
      )
        throw new Error("Recovery account/chain mismatch");
      if (!operation.hash)
        throw new Error(
          "Unknown broadcast outcome: reconcile wallet activity before clearing pending state",
        );
      // No replacement / retry broadcast here. Missing/dropped hashes stay pending.
      const receipt = await this.client.getTransactionReceipt({
        hash: operation.hash,
      });
      const head = await this.client.getBlockNumber({ cacheTime: 0 });
      if (head < receipt.blockNumber + 1n) return operation;
      await this.verifyTransaction(operation, receipt.transactionHash);
      if (operation.stage === "swap" && receipt.status === "success")
        this.store.markCompleted(operation.quoteId);
      operation.status =
        receipt.status === "success" ? "confirmed" : "reverted";
      this.store.set(operation);
      return operation;
    });
  }
}
