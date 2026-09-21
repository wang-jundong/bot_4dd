import type { Connection } from "@solana/web3.js";
export class BlockhashManager {
  #current?: { blockhash: string; lastValidBlockHeight: number; fetchedAt: number };
  #timer?: NodeJS.Timeout;
  constructor(private readonly connection: Connection, private readonly refreshMs: number) {}
  async refresh(): Promise<void> { const b = await this.connection.getLatestBlockhash("confirmed"); this.#current = { ...b, fetchedAt: Date.now() }; }
  start(onError: (error: unknown) => void = console.error): void {
    const refresh = (): void => { void this.refresh().catch(onError); };
    refresh();
    this.#timer = setInterval(refresh, this.refreshMs);
  }
  async get(): Promise<{ blockhash: string; lastValidBlockHeight: number; fetchedAt: number }> { if (!this.#current || Date.now() - this.#current.fetchedAt > this.refreshMs * 2) await this.refresh(); return this.#current!; }
  stop(): void { if (this.#timer) clearInterval(this.#timer); }
}
