import { describe, expect, it } from "vitest";
import { HeliusSender } from "../src/helius/sender.js";

describe("disabled live submission safety", () => {
  it("blocks submission before making an HTTP request", async () => {
    const sender = new HeliusSender("https://sender.helius-rpc.com/fast", true, false);
    await expect(sender.send("not-a-real-transaction", performance.now())).rejects.toThrow("LIVE_SUBMISSION_BLOCKED");
    await sender.close();
  });
});
