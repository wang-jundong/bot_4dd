import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPnlRecord, PnlJournal, summarizeDailyPnl, utcDate, type ClosedTradePnlInput, type PnlRecord } from "../src/pnl/pnlJournal.js";

const input = (overrides: Partial<ClosedTradePnlInput> = {}): ClosedTradePnlInput => ({
  strategy: "strategy_v_011",
  closedAtMs: Date.parse("2026-10-01T16:00:00.000Z"),
  descriptor: { mint: "mint", pool: "pool", programId: "program", venue: "pump", relevantAccounts: [] },
  buyLamports: 10_000_000n,
  sellLamports: 12_500_000n,
  tokenAmount: 123n,
  entryPrice: 80e-6,
  exitPrice: 100e-6,
  prices: { entrySignalPrice: 79e-6, actualEntryFillPrice: 80e-6, actualExitFillPrice: 100e-6 },
  exitReason: "TAKE_PROFIT",
  buySignature: "buy-signature",
  sellSignature: "sell-signature",
  entryProcessedMs: Date.parse("2026-10-01T16:00:00.000Z") - 10_000,
  ...overrides
});

describe("PNL journal", () => {
  it("calculates exact fill PNL and percent for a closed position", () => {
    const record = createPnlRecord(input());
    expect(record.outcome).toBe("win");
    expect(record.buyLamports).toBe("10000000");
    expect(record.sellLamports).toBe("12500000");
    expect(record.pnlLamports).toBe("2500000");
    expect(record.pnlSol).toBe(.0025);
    expect(record.pnlPct).toBe(25);
    expect(record.entryMarketCapSol).toBe(80);
    expect(record.holdingTimeMs).toBe(10_000);
    expect(record.strategy).toBe("strategy_v_011");
    expect(utcDate(record.timestampMs)).toBe("2026-10-01");
  });

  it("records negative PNL", () => {
    const record = createPnlRecord(input({ sellLamports: 8_000_000n }));
    expect(record.outcome).toBe("loss");
    expect(record.pnlLamports).toBe("-2000000");
    expect(record.pnlPct).toBe(-20);
  });

  it("serializes concurrent appends into one valid JSONL file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pnl-"));
    try {
      const journal = new PnlJournal(join(directory, "pnl.jsonl"));
      await Promise.all(Array.from({ length: 20 }, (_, index) => journal.record(input({ descriptor: { mint: `mint-${index}`, pool: "pool", programId: "program", venue: "pump", relevantAccounts: [] } }))));
      const records = await journal.read();
      expect(records).toHaveLength(20);
      expect(records.map(record => record.mint)).toEqual(Array.from({ length: 20 }, (_, index) => `mint-${index}`));
    } finally { await rm(directory, { recursive: true }); }
  });

  it("sums daily PNL per strategy in UTC", () => {
    const records = [
      createPnlRecord(input({ strategy: "strategy_v_011", closedAtMs: Date.parse("2026-10-01T16:00:00.000Z") })),
      createPnlRecord(input({ strategy: "strategy_v_022", closedAtMs: Date.parse("2026-10-01T23:30:00.000Z"), sellLamports: 8_000_000n })),
      createPnlRecord(input({ strategy: "strategy_v_011", closedAtMs: Date.parse("2026-10-02T00:30:00.000Z") }))
    ];
    const summary = summarizeDailyPnl(records);
    expect(summary.timezone).toBe("UTC");
    expect(summary.days.map(day => [day.date, day.strategy, day.trades, day.pnlLamports])).toEqual([
      ["2026-10-01", "strategy_v_011", 1, "2500000"],
      ["2026-10-01", "strategy_v_022", 1, "-2000000"],
      ["2026-10-02", "strategy_v_011", 1, "2500000"]
    ]);
  });

  it("rewrites the UTC daily file from the trade log", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pnl-daily-"));
    try {
      const journal = new PnlJournal(join(directory, "pnl.jsonl"));
      const day = await journal.record(input({ strategy: "strategy_v_022", closedAtMs: Date.parse("2026-10-01T23:30:00.000Z") }));
      expect(day.date).toBe("2026-10-01");
      expect(day.strategy).toBe("strategy_v_022");
      const saved = JSON.parse(await readFile(journal.dailyPath, "utf8")) as { timezone: string; days: PnlRecord[] };
      expect(saved.timezone).toBe("UTC");
      expect(saved.days).toHaveLength(1);
    } finally { await rm(directory, { recursive: true }); }
  });

  it("rejects records without a positive confirmed BUY amount", () => {
    expect(() => createPnlRecord(input({ buyLamports: 0n }))).toThrow("confirmed BUY SOL amount must be positive");
  });
});
