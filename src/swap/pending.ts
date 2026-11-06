import { isAddress, isHex } from "viem";
import type { PendingOperation, PendingStore } from "./types.js";
export class MemoryPendingStore implements PendingStore {
  private operation: PendingOperation | undefined;
  private completed = new Set<string>();
  private locked = false;
  hasCompleted(id: string) {
    return this.completed.has(id);
  }
  markCompleted(id: string) {
    this.completed.add(id);
  }
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (this.locked)
      throw new Error("Another swap holds the pending-store lock");
    this.locked = true;
    try {
      return await operation();
    } finally {
      this.locked = false;
    }
  }
  get() {
    return this.operation ? structuredClone(this.operation) : undefined;
  }
  set(operation: PendingOperation) {
    this.operation = structuredClone(operation);
  }
  clear() {
    this.operation = undefined;
  }
}
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}
export class BrowserPendingStore implements PendingStore {
  constructor(
    private storage: StorageLike,
    private key = "harbor.swap.pending.v1",
  ) {}
  private completed(): string[] {
    const values: unknown = JSON.parse(
      this.storage.getItem(`${this.key}.completed`) ?? "[]",
    );
    if (!Array.isArray(values) || values.some((v) => typeof v !== "string"))
      throw new Error("Invalid completed-operation journal");
    return values;
  }
  hasCompleted(id: string) {
    return this.completed().includes(id);
  }
  markCompleted(id: string) {
    this.storage.setItem(
      `${this.key}.completed`,
      JSON.stringify([...new Set([...this.completed(), id])]),
    );
  }
  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    if (!globalThis.navigator?.locks)
      throw new Error(
        "Web Locks unavailable; signing disabled to prevent duplicate tabs",
      );
    return globalThis.navigator.locks.request(
      this.key,
      { ifAvailable: true },
      async (lock) => {
        if (!lock) throw new Error("Another tab is submitting a swap");
        return operation();
      },
    );
  }
  get(): PendingOperation | undefined {
    const raw = this.storage.getItem(this.key);
    if (raw === null) return undefined;
    const p = JSON.parse(raw) as Partial<PendingOperation>;
    if (
      p.version !== 1 ||
      typeof p.quoteId !== "string" ||
      !p.account ||
      !isAddress(p.account) ||
      !Number.isInteger(p.chainId) ||
      !["approval-reset", "approval", "swap"].includes(p.stage ?? "") ||
      !["broadcasting", "pending", "confirmed", "reverted"].includes(
        p.status ?? "",
      ) ||
      !Number.isSafeInteger(p.createdAt) ||
      (p.hash !== undefined && (!isHex(p.hash) || p.hash.length !== 66))
    )
      throw new Error("Invalid pending operation; reconcile storage manually");
    return p as PendingOperation;
  }
  set(operation: PendingOperation) {
    this.storage.setItem(this.key, JSON.stringify(operation));
  }
  clear() {
    this.storage.removeItem(this.key);
  }
}
