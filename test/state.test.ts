import { describe, expect, it } from "vitest";
import { TokenLifecycleState, assertTransition, canQualifyTargetSell } from "../src/strategy/state.js";
import { TokenState } from "../src/state/tokenState.js";
import type { PoolTradeEvent } from "../src/events/types.js";
import type { PoolDescriptor, VenueAdapter } from "../src/venues/types.js";

const descriptor: PoolDescriptor = { mint: "mint", pool: "pool", programId: "program", venue: "pump", relevantAccounts: [] };
const adapter = { name: "pump" } as VenueAdapter;
const trade = (signature: string, side: "buy" | "sell", tokenAmount: bigint): PoolTradeEvent => ({
  signature, slot: 1, eventIndex: 0, timestampMs: 1, receivedMonoMs: 1, mint: "mint", pool: "pool", programId: "program",
  trader: "target", side, solAmount: 1n, tokenAmount, price: 1, curveProgress: 0.5
});
describe("state machine", () => {
  it("allows the normal tracking transition", () => expect(() => assertTransition(TokenLifecycleState.TARGET_BUY_DETECTED, TokenLifecycleState.TRACKING_POOL)).not.toThrow());
  it("rejects duplicate/invalid execution transitions", () => expect(() => assertTransition(TokenLifecycleState.BUY_SENT, TokenLifecycleState.BUY_SENT)).toThrow());
});

describe("target sell routing", () => {
  it("qualifies target sells only while tracking", () => {
    expect(canQualifyTargetSell(TokenLifecycleState.TRACKING_POOL)).toBe(true);
  });

  it.each([
    TokenLifecycleState.CONFIRMING_REVERSAL,
    TokenLifecycleState.BUY_PREPARED,
    TokenLifecycleState.POSITION_ACTIVE_UNCONFIRMED,
    TokenLifecycleState.POSITION_ACTIVE_CONFIRMED,
    TokenLifecycleState.SELL_PREPARED
  ])("keeps %s target sells in position monitoring", lifecycle => {
    expect(canQualifyTargetSell(lifecycle)).toBe(false);
  });
});

describe("target wallet observed balance", () => {
  it("keeps a positive balance after a partial sell", () => {
    const state = new TokenState(descriptor, adapter, trade("buy", "buy", 100n), 1_000);
    expect(state.recordTargetTrade(trade("partial", "sell", 40n))).toBe(true);
    expect(state.targetObservedTokenAmount).toBe(60n);
  });
  it("reaches zero after a complete sell and deduplicates the trade", () => {
    const state = new TokenState(descriptor, adapter, trade("buy", "buy", 100n), 1_000);
    const sell = trade("exit", "sell", 100n);
    expect(state.recordTargetTrade(sell)).toBe(true);
    expect(state.recordTargetTrade(sell)).toBe(false);
    expect(state.targetObservedTokenAmount).toBe(0n);
  });
  it("includes subsequent target buys", () => {
    const state = new TokenState(descriptor, adapter, trade("buy", "buy", 100n), 1_000);
    state.recordTargetTrade(trade("buy-again", "buy", 25n));
    state.recordTargetTrade(trade("partial", "sell", 100n));
    expect(state.targetObservedTokenAmount).toBe(25n);
  });
});
