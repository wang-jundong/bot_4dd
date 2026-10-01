import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RecoveryJournal } from "../src/recovery/journal.js";
import { journalRecordMatchesStrategy } from "../src/runtime.js";
import { allocateRecoveredTokens } from "../src/recovery/recoveredTokens.js";
import { MintTradeLock } from "../src/execution/mintTradeLock.js";

describe("recovery journal", () => {
  it("persists records in call order and reads bigint values as strings", async () => {
    const directory = await mkdtemp(join(tmpdir(), "recovery-"));
    try {
      const journal = new RecoveryJournal(join(directory, "lifecycle.jsonl"));
      journal.record({ event: "buy_sent", amount: 1n });
      journal.record({ event: "buy_confirmed", amount: 2n, actualEntrySolAmount: 9_876_542n, buySignature: "buy-signature" });
      const records = await journal.read();
      expect(records.map(record => record.event)).toEqual(["buy_sent", "buy_confirmed"]);
      expect(records[1]?.actualEntrySolAmount).toBe("9876542");
      expect(records[1]?.buySignature).toBe("buy-signature");
    } finally { await rm(directory, { recursive: true }); }
  });

  it("gives an untagged open position to the first active strategy only", () => {
    const both = ["strategy_v_011", "strategy_v_022"];
    expect(journalRecordMatchesStrategy(undefined, "strategy_v_011", both)).toBe(true);
    expect(journalRecordMatchesStrategy(undefined, "strategy_v_022", both)).toBe(false);
    expect(journalRecordMatchesStrategy("strategy_v_022", "strategy_v_022", both)).toBe(true);
    expect(journalRecordMatchesStrategy("strategy_v_011", "strategy_v_022", ["strategy_v_022"])).toBe(false);
    expect(journalRecordMatchesStrategy(undefined, "strategy_v_022", ["strategy_v_022"])).toBe(true);
  });

  it("keeps each strategy inside its own recovered token amount", () => {
    expect(allocateRecoveredTokens(100n, 150n, 50n, 0)).toBe(100n);
    expect(allocateRecoveredTokens(50n, 150n, 100n, 0)).toBe(50n);
    expect(allocateRecoveredTokens(0n, 150n, 100n, 0)).toBe(50n);
    expect(allocateRecoveredTokens(0n, 150n, 0n, 1)).toBe(0n);
    expect(allocateRecoveredTokens(0n, 80n, 0n, 0)).toBe(80n);
  });

  it("runs trades for one mint one at a time", async () => {
    const lock = new MintTradeLock();
    const order: string[] = [];
    const first = lock.run("mint", async () => {
      order.push("first-start");
      await new Promise(resolve => setTimeout(resolve, 20));
      order.push("first-end");
    });
    const second = lock.run("mint", async () => {
      order.push("second-start");
      order.push("second-end");
    });
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });
});
