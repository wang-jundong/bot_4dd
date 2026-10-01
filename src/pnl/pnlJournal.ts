import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PositionPrices } from "../state/tokenState.js";
import type { PoolDescriptor } from "../venues/types.js";

const LAMPORTS_PER_SOL = 1_000_000_000;
// Internal fill prices use raw token units scaled by 1e9; standard Pump supply is 1e15 raw units.
const MARKET_CAP_MULTIPLIER = 1_000_000;

export interface ClosedTradePnlInput {
  strategy: string;
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
  strategy: string;
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
    strategy: input.strategy,
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

export interface DailyStrategyPnl {
  date: string;
  strategy: string;
  trades: number;
  wins: number;
  losses: number;
  flats: number;
  buyLamports: string;
  sellLamports: string;
  pnlLamports: string;
  pnlSol: number;
}

export interface DailyPnlFile {
  timezone: "UTC";
  days: DailyStrategyPnl[];
}

export function utcDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function dailyPnlPath(pnlPath: string): string {
  return join(dirname(pnlPath), "pnl-daily.json");
}

export function summarizeDailyPnl(records: readonly PnlRecord[]): DailyPnlFile {
  const groups = new Map<string, { date: string; strategy: string; trades: number; wins: number; losses: number; flats: number; buy: bigint; sell: bigint }>();
  for (const record of records) {
    const date = utcDate(record.timestampMs);
    const strategy = record.strategy || "unknown";
    const key = `${date}\0${strategy}`;
    const group = groups.get(key) ?? { date, strategy, trades: 0, wins: 0, losses: 0, flats: 0, buy: 0n, sell: 0n };
    group.trades += 1;
    if (record.outcome === "win") group.wins += 1;
    else if (record.outcome === "loss") group.losses += 1;
    else group.flats += 1;
    group.buy += BigInt(record.buyLamports);
    group.sell += BigInt(record.sellLamports);
    groups.set(key, group);
  }
  const days = [...groups.values()].map(group => {
    const pnlLamports = group.sell - group.buy;
    return {
      date: group.date,
      strategy: group.strategy,
      trades: group.trades,
      wins: group.wins,
      losses: group.losses,
      flats: group.flats,
      buyLamports: group.buy.toString(),
      sellLamports: group.sell.toString(),
      pnlLamports: pnlLamports.toString(),
      pnlSol: Number(pnlLamports) / LAMPORTS_PER_SOL
    };
  }).sort((a, b) => a.date.localeCompare(b.date) || a.strategy.localeCompare(b.strategy));
  return { timezone: "UTC", days };
}

export class PnlJournal {
  #pending: Promise<void> = Promise.resolve();
  readonly dailyPath: string;
  constructor(private readonly path: string, dailyPath = dailyPnlPath(path)) {
    this.dailyPath = dailyPath;
  }

  record(input: ClosedTradePnlInput): Promise<DailyStrategyPnl> {
    const line = JSON.stringify(createPnlRecord(input)) + "\n";
    const write = this.#pending.then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      await appendFile(this.path, line);
      const summary = summarizeDailyPnl(await this.#readFile());
      await writeFile(this.dailyPath, JSON.stringify(summary, null, 2) + "\n");
      const day = summary.days.find(entry => entry.date === utcDate(input.closedAtMs) && entry.strategy === input.strategy);
      if (!day) throw new Error(`daily PNL missing for ${input.strategy} ${utcDate(input.closedAtMs)}`);
      return day;
    });
    this.#pending = write.then(() => undefined, () => undefined);
    return write;
  }

  async read(): Promise<readonly PnlRecord[]> {
    await this.#pending;
    return this.#readFile();
  }

  async #readFile(): Promise<readonly PnlRecord[]> {
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
