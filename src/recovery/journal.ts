import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface JournalRecord {
  event?: string;
  descriptor?: { mint: string; pool: string; programId: string; venue: string; tokenProgram?: string; quoteMint?: string; relevantAccounts: readonly string[] };
  lifecycle?: string;
  actualTokenAmount?: string;
  actualEntrySolAmount?: string;
  buyLamports?: string;
  entryProcessedMs?: number;
  signature?: string;
  buySignature?: string;
  sellSignature?: string;
  prices?: { actualEntryFillPrice?: number; actualExitFillPrice?: number; currentMarkPrice?: number };
  fill?: { price?: number; success?: boolean; solAmount?: string; tokenAmount?: string };
}

export class RecoveryJournal {
  #pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}
  record(value: object): void {
    const line = JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v) + "\n";
    this.#pending = this.#pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line);
    }).catch(() => undefined);
  }
  async read(): Promise<readonly JournalRecord[]> {
    await this.#pending;
    try {
      return (await readFile(this.path, "utf8")).split("\n").filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as JournalRecord]; } catch { return []; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
