import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { PositionPrices } from "../state/tokenState.js";
import type { PoolDescriptor } from "../venues/types.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
// Internal fill prices use raw token units scaled by 1e9; standard Pump supply is 1e15 raw units.
const MARKET_CAP_MULTIPLIER = 1_000_000;

export interface ClosedTradePnlInput {
  closedAtMs: number;
  descriptor: PoolDescriptor;
  buyLamports: bigint;
  sellLamports: bigint;
  tokenAmount: bigint;
  entryPrice: number;
  exitPrice: number;
  prices: PositionPrices;
  exitReason: string;
  buySignature?: string;
  sellSignature?: string;
  entryProcessedMs: number;
}

export interface PnlRecord {
  timestamp: string;
  timestampMs: number;
  mint: string;
  pool: string;
  programId: string;
  venue: string;
  tokenProgram?: string;
  quoteMint?: string;
  outcome: "win" | "loss" | "flat";
  buyLamports: string;
  sellLamports: string;
  pnlLamports: string;
  buySol: number;
  sellSol: number;
  pnlSol: number;
  pnlPct: number;
  tokenAmount: string;
  entryPrice: number;
  exitPrice: number;
  entryMarketCapSol: number;
  exitMarketCapSol: number;
  exitReason: string;
  buySignature?: string;
  sellSignature?: string;
  entryProcessedMs: number;
  holdingTimeMs: number;
  prices: PositionPrices;
}

export function createPnlRecord(input: ClosedTradePnlInput): PnlRecord {
  if (input.buyLamports <= 0n) throw new Error("confirmed BUY SOL amount must be positive");
  const pnlLamports = input.sellLamports - input.buyLamports;
  const buySol = Number(input.buyLamports) / LAMPORTS_PER_SOL;
  const sellSol = Number(input.sellLamports) / LAMPORTS_PER_SOL;
  return {
    timestamp: new Date(input.closedAtMs).toISOString(),
    timestampMs: input.closedAtMs,
    mint: input.descriptor.mint,
    pool: input.descriptor.pool,
    programId: input.descriptor.programId,
    venue: input.descriptor.venue,
    tokenProgram: input.descriptor.tokenProgram,
    quoteMint: input.descriptor.quoteMint,
    outcome: pnlLamports > 0n ? "win" : pnlLamports < 0n ? "loss" : "flat",
    buyLamports: input.buyLamports.toString(),
    sellLamports: input.sellLamports.toString(),
    pnlLamports: pnlLamports.toString(),
    buySol,
    sellSol,
    pnlSol: Number(pnlLamports) / LAMPORTS_PER_SOL,
    pnlPct: Number(pnlLamports) / Number(input.buyLamports) * 100,
    tokenAmount: input.tokenAmount.toString(),
    entryPrice: input.entryPrice,
    exitPrice: input.exitPrice,
    entryMarketCapSol: input.entryPrice * MARKET_CAP_MULTIPLIER,
    exitMarketCapSol: input.exitPrice * MARKET_CAP_MULTIPLIER,
    exitReason: input.exitReason,
    buySignature: input.buySignature,
    sellSignature: input.sellSignature,
    entryProcessedMs: input.entryProcessedMs,
    holdingTimeMs: Math.max(0, input.closedAtMs - input.entryProcessedMs),
    prices: { ...input.prices }
  };
}

export class PnlJournal {
  #pending: Promise<void> = Promise.resolve();
  constructor(private readonly path: string) {}

  record(input: ClosedTradePnlInput): Promise<void> {
    const line = JSON.stringify(createPnlRecord(input)) + "\n";
    const write = this.#pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line);
    });
    this.#pending = write.catch(() => undefined);
    return write;
  }

  async read(): Promise<readonly PnlRecord[]> {
    await this.#pending;
    try {
      return (await readFile(this.path, "utf8")).split("\n").filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line) as PnlRecord]; } catch { return []; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  }
}
