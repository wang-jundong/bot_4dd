import { describe, expect, it } from "vitest";
import { shouldTradeTargetBuy } from "../src/strategy/venuePolicy.js";

describe("target-buy venue policy", () => {
  it("rejects PumpSwap target buys", () => {
    expect(shouldTradeTargetBuy("pumpswap")).toBe(false);
  });

  it("keeps Pump bonding-curve target buys tradable", () => {
    expect(shouldTradeTargetBuy("pump")).toBe(true);
  });
});
