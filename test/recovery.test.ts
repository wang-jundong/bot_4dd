import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { RecoveryJournal } from "../src/recovery/journal.js";

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
});
