import type { ParsedTargetTransaction, PoolDescriptor } from "../venues/types.js";
import { createRequire } from "node:module";
import bs58 from "bs58";
import { CommitmentLevel, type SubscribeRequest, type SubscribeUpdate } from "@triton-one/yellowstone-grpc";

export interface VibeConnectionOptions { endpoint: string; token: string; }
export interface Subscription { close(): Promise<void>; }
export interface VibeClient {
  connect(): Promise<void>;
  subscribeWallet(wallet: string, onTransaction: (tx: ParsedTargetTransaction) => void): Promise<Subscription>;
  subscribePool(pool: PoolDescriptor, onTransaction: (tx: ParsedTargetTransaction) => void): Promise<Subscription>;
  close(): Promise<void>;
}

const require = createRequire(import.meta.url);
interface Stream {
  on(event: "data", listener: (update: SubscribeUpdate) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  on(event: "end" | "close", listener: () => void): this;
  write(request: SubscribeRequest, callback: (error?: Error | null) => void): boolean;
  cancel(): void;
}
interface YellowstoneClientApi { ping(count: number): Promise<number>; subscribe(): Promise<Stream>; close?(): void; }
const YellowstoneClient = (require("@triton-one/yellowstone-grpc") as {
  default: new (endpoint: string, token: string | undefined, options: Record<string, number>) => YellowstoneClientApi;
}).default;

export class YellowstoneVibeClient implements VibeClient {
  readonly #client: YellowstoneClientApi;
  readonly #handlers = new Map<string, Set<(tx: ParsedTargetTransaction) => void>>();
  readonly #retryTimers = new Set<NodeJS.Timeout>();
  #stream?: Stream;
  #opening?: Promise<void>;
  #retryAttempt = 0;
  #closing = false;

  constructor(options: VibeConnectionOptions, private readonly onError: (error: unknown) => void = console.error) {
    this.#client = new YellowstoneClient(options.endpoint, options.token || undefined, { "grpc.max_receive_message_length": 16 * 1024 * 1024 });
  }

  async connect(): Promise<void> {}
  subscribeWallet(wallet: string, onTransaction: (tx: ParsedTargetTransaction) => void): Promise<Subscription> { return this.#subscribe(wallet, onTransaction); }
  subscribePool(pool: PoolDescriptor, onTransaction: (tx: ParsedTargetTransaction) => void): Promise<Subscription> { return this.#subscribe(pool.pool, onTransaction); }

  async #subscribe(account: string, onTransaction: (tx: ParsedTargetTransaction) => void): Promise<Subscription> {
    let handlers = this.#handlers.get(account);
    if (!handlers) { handlers = new Set(); this.#handlers.set(account, handlers); }
    handlers.add(onTransaction);
    while (!this.#closing) {
      try {
        await this.#ensureStream();
        await this.#writeSubscription();
        break;
      } catch (error) {
        this.onError(error);
        const baseDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(this.#retryAttempt++, 6));
        const delayMs = Math.round(baseDelayMs * (0.8 + Math.random() * 0.4));
        await new Promise<void>(resolve => setTimeout(resolve, delayMs));
      }
    }
    if (this.#closing) {
      handlers.delete(onTransaction);
      if (handlers.size === 0) this.#handlers.delete(account);
      throw new Error("Vibe client closed while subscribing");
    }
    let closed = false;
    return {
      close: async () => {
        if (closed) return;
        closed = true;
        const current = this.#handlers.get(account);
        current?.delete(onTransaction);
        if (current?.size === 0) this.#handlers.delete(account);
        if (this.#stream && !this.#closing) await this.#writeSubscription();
      }
    };
  }

  #request(): SubscribeRequest {
    return {
      accounts: {}, slots: {}, transactionsStatus: {}, blocks: {}, blocksMeta: {}, entry: {},
      transactions: { tracked: { vote: false, failed: false, signature: undefined, accountInclude: [...this.#handlers.keys()], accountExclude: [], accountRequired: [] } },
      commitment: CommitmentLevel.PROCESSED, accountsDataSlice: [], ping: undefined, fromSlot: undefined
    };
  }

  async #ensureStream(): Promise<void> {
    if (this.#stream || this.#closing) return;
    if (!this.#opening) this.#opening = this.#open().finally(() => { this.#opening = undefined; });
    await this.#opening;
  }

  async #open(): Promise<void> {
    if (this.#closing) return;
    const stream = await this.#client.subscribe();
    this.#stream = stream;
    const disconnected = (error?: unknown): void => {
      if (this.#stream !== stream) return;
      this.#stream = undefined;
      if (error) this.onError(error);
      this.#scheduleReconnect();
    };
    stream.on("data", update => {
      this.#retryAttempt = 0;
      const info = update.transaction?.transaction;
      const message = info?.transaction?.message;
      if (!info || !message || info.meta?.err) return;
      const accountKeys = [...message.accountKeys, ...(info.meta?.loadedWritableAddresses ?? []), ...(info.meta?.loadedReadonlyAddresses ?? [])].map(key => bs58.encode(key));
      const programIds = message.instructions.map(ix => accountKeys[ix.programIdIndex]).filter((key): key is string => key !== undefined);
      const transaction = { signature: bs58.encode(info.signature), slot: Number(update.transaction!.slot), timestampMs: Date.now(), accountKeys, programIds, raw: info };
      for (const account of accountKeys) {
        const handler = this.#handlers.get(account)?.values().next().value;
        if (handler) { handler(transaction); break; }
      }
    });
    stream.on("error", error => disconnected(error));
    stream.on("end", () => disconnected(new Error("Vibe shared stream ended")));
    stream.on("close", () => disconnected(new Error("Vibe shared stream closed")));
    try { await this.#writeSubscription(); }
    catch (error) {
      if (this.#stream === stream) this.#stream = undefined;
      stream.cancel();
      throw error;
    }
  }

  async #writeSubscription(): Promise<void> {
    const stream = this.#stream;
    if (!stream) return;
    const request = this.#request();
    await new Promise<void>((resolve, reject) => stream.write(request, error => error ? reject(error) : resolve()));
  }

  #scheduleReconnect(): void {
    if (this.#closing || this.#handlers.size === 0 || this.#retryTimers.size > 0) return;
    const baseDelayMs = Math.min(60_000, 1_000 * 2 ** Math.min(this.#retryAttempt++, 6));
    const delayMs = Math.round(baseDelayMs * (0.8 + Math.random() * 0.4));
    const timer = setTimeout(() => {
      this.#retryTimers.delete(timer);
      void this.#ensureStream().catch(error => { this.onError(error); this.#scheduleReconnect(); });
    }, delayMs);
    this.#retryTimers.add(timer);
  }

  async close(): Promise<void> {
    this.#closing = true;
    for (const timer of this.#retryTimers) clearTimeout(timer);
    this.#retryTimers.clear();
    this.#handlers.clear();
    this.#stream?.cancel();
    this.#stream = undefined;
    this.#client.close?.();
  }
}
