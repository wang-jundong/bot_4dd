import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createPnlRecord, PnlJournal, type ClosedTradePnlInput } from "../src/pnl/pnlJournal.js";

const input = (overrides: Partial<ClosedTradePnlInput> = {}): ClosedTradePnlInput => ({
  closedAtMs: 1_700_000_010_000,
  descriptor: { mint: "mint", pool: "pool", programId: "program", venue: "pump", relevantAccounts: [] },
  isReentryPosition: false,
  buyLamports: 10_000_000n,
  sellLamports: 12_500_000n,
  tokenAmount: 123n,
  entryPrice: 80e-6,
  exitPrice: 100e-6,
  prices: { entrySignalPrice: 79e-6, actualEntryFillPrice: 80e-6, actualExitFillPrice: 100e-6 },
  exitReason: "TSR_TP",
  buySignature: "buy-signature",
  sellSignature: "sell-signature",
  entryProcessedMs: 1_700_000_000_000,
  profitLockArmed: false,
  lossStreakAfterClose: 0,
  ...overrides
});

describe("PNL journal", () => {
  it("calculates exact fill PNL and percent for a normal position", () => {
    const record = createPnlRecord(input());
    expect(record.positionType).toBe("normal");
    expect(record.outcome).toBe("win");
    expect(record.buyLamports).toBe("10000000");
    expect(record.sellLamports).toBe("12500000");
    expect(record.pnlLamports).toBe("2500000");
    expect(record.pnlSol).toBe(.0025);
    expect(record.pnlPct).toBe(25);
    expect(record.entryMarketCapSol).toBe(80);
    expect(record.holdingTimeMs).toBe(10_000);
  });

  it("records negative PNL and identifies re-entry positions", () => {
    const record = createPnlRecord(input({ isReentryPosition: true, sellLamports: 8_000_000n, lossStreakAfterClose: 2 }));
    expect(record.positionType).toBe("reentry");
    expect(record.outcome).toBe("loss");
    expect(record.pnlLamports).toBe("-2000000");
    expect(record.pnlPct).toBe(-20);
    expect(record.lossStreakAfterClose).toBe(2);
  });

  it("serializes concurrent appends into one valid JSONL file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tsr-pnl-"));
    try {
      const journal = new PnlJournal(join(directory, "pnl.jsonl"));
      await Promise.all(Array.from({ length: 20 }, (_, index) => journal.record(input({ descriptor: { mint: `mint-${index}`, pool: "pool", programId: "program", venue: "pump", relevantAccounts: [] } }))));
      const records = await journal.read();
      expect(records).toHaveLength(20);
      expect(records.map(record => record.mint)).toEqual(Array.from({ length: 20 }, (_, index) => `mint-${index}`));
    } finally { await rm(directory, { recursive: true }); }
  });

  it("rejects records without a positive confirmed BUY amount", () => {
    expect(() => createPnlRecord(input({ buyLamports: 0n }))).toThrow("confirmed BUY SOL amount must be positive");
  });
});
