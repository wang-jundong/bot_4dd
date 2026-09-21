import { describe, expect, it } from "vitest";
import { createConfirmation, createReentryConfirmation, entryDeviationPct, entryMarketCapSol, isEntryMarketCapAllowed, evaluateBundleDump, evaluateConfirmation, evaluateReentryConfirmation, exitReason, qualifyTargetSell, shouldArmProfitLock, updateConfirmation, updateReentryConfirmation, type StrategyThresholds } from "../src/strategy/calculations.js";
import { EventBuffer } from "../src/state/eventBuffer.js";
import type { PoolTradeEvent } from "../src/events/types.js";

const t: StrategyThresholds = { minTargetSellLamports: 0n, minCurve: .6, preSellWindowMs: 60_000, minTrades: 11, maxTrades: 60, boundToTargetBuy: true, minBuyPressure: .45, maxDrawdownPct: 5, minReturnPct: -5, maxReturnPct: 10, profitLockEnabled: true, profitLockActivatePct: 30, profitLockFloorPct: 20, takeProfitPct: 50, stopLossPct: -30, maxHoldMs: 3_600_000, reentry: { enabled: true, dumpWindowMs: 2000, minSellPressure: .85, minSellLamports: 3_000_000_000n, sameSlotMinSellers: 3, waitMs: 60_000, triggerBuyLamports: 100_000_000n, confirmMs: 2000, minBuyPressure: .6, maxBuyPressure: .9, minDistinctBuyers: 3, minRecoveryPct: 10, noNewLowMs: 1000, maxTriggerReturnPct: 20, takeProfitPct: 60, stopLossPct: -20, maxHoldMs: 3_600_000 } };
const event = (i: number, o: Partial<PoolTradeEvent> = {}): PoolTradeEvent => ({ signature: `s${i}`, slot: i, eventIndex: 0, timestampMs: 10_000 + i, receivedMonoMs: i, mint: "m", pool: "p", programId: "x", trader: "w", side: "buy", solAmount: 1n, tokenAmount: 1n, price: 100, ...o });
const sell = (o: Partial<PoolTradeEvent> = {}) => event(100, { side: "sell", timestampMs: 20_000, curveProgress: .6, ...o });

describe("qualification", () => {
  it("rejects curve below 60%", () => expect(qualifyTargetSell(Array.from({length:11},(_,i)=>event(i)), 0, sell({curveProgress:.599}), t).pass).toBe(false));
  it.each([[10,false],[11,true],[60,true],[61,false]])("handles %i preceding trades", (n, pass) => expect(qualifyTargetSell(Array.from({length:n},(_,i)=>event(i)), 0, sell(), t).pass).toBe(pass));
  it("excludes pre-target-buy events", () => expect(qualifyTargetSell(Array.from({length:11},(_,i)=>event(i,{timestampMs:1000+i})), 10_000, sell(), t).count).toBe(0));
  it("allows partial sells at zero minimum", () => expect(qualifyTargetSell(Array.from({length:11},(_,i)=>event(i)), 0, sell({solAmount:0n}), t).pass).toBe(true));
});
  it("reports which qualification check failed", () => {
    const result = qualifyTargetSell(Array.from({length:10},(_,i)=>event(i)), 0, sell({curveProgress:.5}), t);
    expect(result.checks).toEqual({ curve: false, amount: true, tradeCount: false });
  });

describe("confirmation", () => {
  const result = (buy: bigint, sellSol: bigint, min: number, final: number) => evaluateConfirmation({buyLamports:buy,sellLamports:sellSol,minPrice:min,latestPrice:final,startTimestampMs:0,deadlineTimestampMs:2000},100,t);
  it("passes exactly 45% pressure", () => expect(result(45n,55n,95,95).pass).toBe(true));
  it("rejects pressure below 45%", () => expect(result(449n,551n,95,95).pass).toBe(false));
  it("passes exactly -5% drawdown", () => expect(result(45n,55n,95,95).pass).toBe(true));
  it("rejects drawdown below -5%", () => expect(result(45n,55n,94.99,95).pass).toBe(false));
  it("passes exactly -5% final return", () => expect(result(45n,55n,95,95).pass).toBe(true));
  it("rejects final return below -5%", () => expect(result(45n,55n,95,94.99).pass).toBe(false));
  it("passes exactly +10% final return", () => expect(result(45n,55n,100,110).pass).toBe(true));
  it("rejects final return above +10%", () => expect(result(45n,55n,100,110.01).pass).toBe(false));
  it("does not include the deadline-triggering event after deadline", () => { const s=createConfirmation(event(1,{timestampMs:0}),2000); updateConfirmation(s,event(2,{timestampMs:2001,solAmount:99n})); expect(s.buyLamports).toBe(0n); });
});
describe("event buffer", () => {
  it("deduplicates signature and event index", () => { const b=new EventBuffer(10000); expect(b.add(event(1))).toBe(true); expect(b.add(event(1))).toBe(false); expect(b.values()).toHaveLength(1); });
});
describe("exit priority", () => {
  it("takes profit at +50%", () => expect(exitReason(150,100,0,0,t)).toBe("TSR_TP"));
  it("does not exit at the floor before the lock is armed", () => expect(exitReason(120,100,0,0,t)).toBeUndefined());
  it("exits at the floor after the lock is armed", () => expect(exitReason(120,100,0,0,t,true)).toBe("TSR_PROFIT_LOCK"));
  it("ignores an armed lock when profit lock is disabled", () => expect(exitReason(100,100,0,0,{...t,profitLockEnabled:false,profitLockActivatePct:0,profitLockFloorPct:0},true)).toBeUndefined());
  it("does not arm profit lock when disabled", () => expect(shouldArmProfitLock(200,100,{...t,profitLockEnabled:false,profitLockActivatePct:0,profitLockFloorPct:0})).toBe(false));
  it("does not exit above the floor after the lock is armed", () => expect(exitReason(121,100,0,0,t,true)).toBeUndefined());
  it("stops at -30%", () => expect(exitReason(70,100,0,0,t)).toBe("TSR_STOP"));
describe("entry deviation", () => {
  it("calculates adverse fill deviation", () => expect(entryDeviationPct(110, 100)).toBeCloseTo(10));
});

describe("entry market-cap limit", () => {
  it("allows a normal entry below 100 SOL", () => expect(isEntryMarketCapAllowed(99.99 / 1_000_000, 100)).toBe(true));
  it("rejects a normal entry at exactly 100 SOL", () => expect(isEntryMarketCapAllowed(100 / 1_000_000, 100)).toBe(false));
  it("rejects a re-entry above 100 SOL", () => expect(isEntryMarketCapAllowed(100.01 / 1_000_000, 100)).toBe(false));
  it("calculates market cap from the latest observed price", () => expect(entryMarketCapSol(75 / 1_000_000)).toBeCloseTo(75));
});

  it("exits at 3600 seconds", () => expect(exitReason(100,100,3_600_000,0,t)).toBe("TSR_MAX_HOLD"));
  it("TP wins when max hold is also true", () => expect(exitReason(150,100,3_600_000,0,t)).toBe("TSR_TP"));
});
describe("re-entry qualification", () => {
  it("requires a strict dump and three sellers in one completed slot", () => {
    const signal = event(20, { slot: 20, transactionIndex: 5, timestampMs: 20_000, side: "sell" });
    const events = [
      event(1, { slot: 19, transactionIndex: 1, timestampMs: 18_500, trader: "a", side: "sell", solAmount: 1_100_000_000n }),
      event(2, { slot: 19, transactionIndex: 2, timestampMs: 18_600, trader: "b", side: "sell", solAmount: 1_100_000_000n }),
      event(3, { slot: 19, transactionIndex: 3, timestampMs: 18_700, trader: "c", side: "sell", solAmount: 1_100_000_000n }),
      event(4, { slot: 19, transactionIndex: 4, timestampMs: 18_800, trader: "d", side: "buy", solAmount: 100_000_000n })
    ];
    const result = evaluateBundleDump(events, signal, t.reentry);
    expect(result.eligible).toBe(true);
    expect(result.maxSameSlotSellers).toBe(3);
  });
  it("excludes sellers in the still-incomplete signal slot", () => {
    const signal = event(20, { slot: 20, transactionIndex: 5, timestampMs: 20_000, side: "sell" });
    const events = ["a", "b", "c"].map((trader, index) => event(index, { slot: 20, transactionIndex: index, timestampMs: 19_000 + index, trader, side: "sell", solAmount: 1_100_000_000n }));
    expect(evaluateBundleDump(events, signal, t.reentry).eligible).toBe(false);
  });
  it("treats 85% pressure and 3 SOL as non-passing boundaries", () => {
    const signal = event(20, { slot: 20, transactionIndex: 5, timestampMs: 20_000, side: "sell" });
    const sellers = ["a", "b", "c"].map((trader, index) => event(index, { slot: 19, transactionIndex: index, timestampMs: 19_000 + index, trader, side: "sell", solAmount: 1_000_000_000n }));
    expect(evaluateBundleDump(sellers, signal, t.reentry).eligible).toBe(false);
  });
});
describe("re-entry rebound confirmation", () => {
  it("passes pressure, buyer diversity, recovery, stability, and chase limits", () => {
    const trigger = event(1, { timestampMs: 1_000, trader: "a", solAmount: 200_000_000n, price: 100 });
    const confirmation = createReentryConfirmation(trigger, 2_000);
    updateReentryConfirmation(confirmation, event(2, { timestampMs: 2_000, trader: "b", solAmount: 200_000_000n, price: 105 }));
    updateReentryConfirmation(confirmation, event(3, { timestampMs: 2_500, trader: "c", solAmount: 200_000_000n, price: 110 }));
    updateReentryConfirmation(confirmation, event(4, { timestampMs: 2_700, side: "sell", solAmount: 200_000_000n, price: 110 }));
    expect(evaluateReentryConfirmation(confirmation, 100, 3_000, t.reentry).pass).toBe(true);
  });
  it("accepts confirmation buy pressure exactly at the maximum", () => {
    const confirmation = createReentryConfirmation(event(1, { timestampMs: 1_000, trader: "a", solAmount: 600n, price: 100 }), 2_000);
    updateReentryConfirmation(confirmation, event(2, { timestampMs: 2_000, trader: "b", solAmount: 200n, price: 105 }));
    updateReentryConfirmation(confirmation, event(3, { timestampMs: 2_500, trader: "c", solAmount: 100n, price: 110 }));
    updateReentryConfirmation(confirmation, event(4, { timestampMs: 2_700, side: "sell", solAmount: 100n, price: 110 }));
    const result = evaluateReentryConfirmation(confirmation, 100, 3_000, t.reentry);
    expect(result.buyPressure).toBe(.9);
    expect(result.pass).toBe(true);
  });
  it("rejects confirmation buy pressure above the maximum", () => {
    const confirmation = createReentryConfirmation(event(1, { timestampMs: 1_000, trader: "a", solAmount: 700n, price: 100 }), 2_000);
    updateReentryConfirmation(confirmation, event(2, { timestampMs: 2_000, trader: "b", solAmount: 200n, price: 105 }));
    updateReentryConfirmation(confirmation, event(3, { timestampMs: 2_500, trader: "c", solAmount: 100n, price: 110 }));
    const result = evaluateReentryConfirmation(confirmation, 100, 3_000, t.reentry);
    expect(result.buyPressure).toBe(1);
    expect(result.pass).toBe(false);
  });
  it("rejects a rebound driven by fewer than three buyers", () => {
    const trigger = event(1, { timestampMs: 1_000, trader: "a", solAmount: 200_000_000n, price: 100 });
    const confirmation = createReentryConfirmation(trigger, 2_000);
    updateReentryConfirmation(confirmation, event(2, { timestampMs: 2_500, trader: "b", solAmount: 200_000_000n, price: 110 }));
    expect(evaluateReentryConfirmation(confirmation, 100, 3_000, t.reentry).pass).toBe(false);
  });
});
