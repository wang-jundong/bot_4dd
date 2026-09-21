import type { Connection, PublicKey } from "@solana/web3.js";
import type { FillResult, VenueAdapter } from "../venues/types.js";

const wait = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class ConfirmationTimeoutError extends Error {}

export class ConfirmationTracker {
  constructor(private readonly connection: Connection, private readonly timeoutMs = 30_000) {}

  async waitProcessed(signature: string, adapter: VenueAdapter, owner: PublicKey, mint: string): Promise<FillResult> {
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const status = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
      if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
      if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") {
        const tx = await this.connection.getTransaction(signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (tx?.meta?.err) throw new Error(`transaction failed: ${JSON.stringify(tx.meta.err)}`);
        if (tx) return adapter.parseFill(tx, owner, mint);
      }
      await wait(500);
    }
    throw new ConfirmationTimeoutError(`confirmation timed out for ${signature}`);
  }

  async checkConfirmed(signature: string): Promise<boolean> {
    const status = (await this.connection.getSignatureStatuses([signature], { searchTransactionHistory: true })).value[0];
    return !!status && status.err === null && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized");
  }
}
