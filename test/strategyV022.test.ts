import { describe, expect, it } from "vitest";
import { loadStrategyV022Config, type StrategyV022Config } from "../src/config/strategyV022.js";
import { StrategyV022Engine, type StrategyV022MarketEvent } from "../src/strategy/strategyV022Engine.js";

const cfg = (overrides: Partial<StrategyV022Config> = {}): StrategyV022Config => ({
  ...loadStrategyV022Config(),
  ...overrides
});

const print = (overrides: Partial<StrategyV022MarketEvent> = {}): StrategyV022MarketEvent => ({
  signature: "sig",
  slot: 1,
  timestampSec: 1_700_000_000,
  timestampMs: 1_700_000_000_000,
  side: "SELL",
  wallet: "other",
  solAmount: 0.6,
  tokenAmount: 0,
  price: 50e-9,
  ...overrides
});

function bound(overrides: Partial<StrategyV022Config> = {}, ownWallet = ""): StrategyV022Engine {
  const engine = new StrategyV022Engine(cfg(overrides), ownWallet);
  engine.bindGate("target");
  return engine;
}

describe("strategy_v_022 engine", () => {
  it("skips the first qualifying sell round and buys the second", () => {
    const engine = bound();
    expect(engine.phaseName).toBe("seek_sell");
    expect(engine.needsPoolTape()).toBe(true);
    expect(engine.onEvent(print({ solAmount: 0.1, signature: "dust" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.6, signature: "s1" }))).toBeNull();
    expect(engine.onEvent(print({ side: "BUY", solAmount: 2, signature: "break" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.6, signature: "s2" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.5, signature: "s3" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.5, signature: "s4" }))).toBeNull();
    expect(engine.phaseName).toBe("seek_sell");
    expect(engine.onEvent(print({ solAmount: 0.6, signature: "s5" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.5, signature: "s6" }))).toBeNull();
    const decision = engine.onEvent(print({ solAmount: 0.5, signature: "s7" }));
    expect(decision).toBe("BUY");
    expect(engine.phaseName).toBe("pending");
    expect(engine.lastBuyReason).toContain("buy_hit");
    expect(engine.lastBuyDiag.buy_hit_sol).toBe(1.6);
  });

  it("waits when the buy round is above the market-cap cap", () => {
    const engine = bound();
    roundOfSells(engine, "early", 100e-9);
    expect(engine.phaseName).toBe("seek_sell");
    const decision = roundOfSells(engine, "cap", 100e-9);
    expect(decision).toBeNull();
    expect(engine.phaseName).toBe("wait");
    expect(engine.onEvent(print({ side: "BUY", wallet: "target", solAmount: 1, signature: "again" }))).toBeNull();
    expect(engine.phaseName).toBe("wait");
    expect(engine.onEvent(print({ side: "SELL", wallet: "target", solAmount: 1, tokenAmount: 1, signature: "flat" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");
    expect(engine.onEvent(print({ side: "BUY", wallet: "target", solAmount: 1, slot: 2, signature: "next" }))).toBeNull();
    expect(engine.phaseName).toBe("seek_sell");
  });

  it("sells a hold on a three-buy cluster, take-profit, stop, or the target sell", () => {
    const cluster = bound();
    arm(cluster);
    cluster.onBuyFill();
    expect(cluster.phaseName).toBe("hold");
    cluster.onEvent(print({ side: "BUY", solAmount: 1.5, signature: "b1" }));
    cluster.onEvent(print({ side: "BUY", solAmount: 1.5, signature: "b2" }));
    const sold = cluster.onEvent(print({ side: "BUY", solAmount: 1.5, signature: "b3" }));
    expect(sold).toBe("SELL");
    expect(cluster.lastSellReason).toContain("sell_hit");
    expect(cluster.phaseName).toBe("wait");

    const tp = bound();
    arm(tp);
    tp.onBuyFill();
    const took = tp.onEvent(print({ solAmount: 0.05, price: 50e-9 * 1.25, signature: "tp" }));
    expect(took).toBe("SELL");
    expect(tp.lastSellReason).toBe("take_profit");

    const stop = bound({ stop_loss: 0.1, take_profit: 0 });
    arm(stop);
    stop.onBuyFill();
    const cut = stop.onEvent(print({ solAmount: 0.05, price: 50e-9 * 0.8, signature: "sl" }));
    expect(cut).toBe("SELL");
    expect(stop.lastSellReason).toBe("stop");

    const target = bound({ take_profit: 0 });
    arm(target);
    target.onBuyFill();
    const dumped = target.onEvent(print({ side: "SELL", wallet: "target", solAmount: 0.05, tokenAmount: 1, signature: "ts" }));
    expect(dumped).toBe("SELL");
    expect(target.lastSellReason).toBe("target_sell");
    expect(target.phaseName).toBe("idle");
  });

  it("leaves our own prints out of the sell run and the three-buy exit", () => {
    const engine = bound({ buy_hit_round: 1 }, "me");
    engine.onEvent(print({ solAmount: 0.6, signature: "s1" }));
    expect(engine.onEvent(print({ side: "BUY", wallet: "me", solAmount: 3, signature: "my-buy" }))).toBeNull();
    engine.onEvent(print({ solAmount: 0.6, signature: "s2" }));
    expect(engine.onEvent(print({ wallet: "me", solAmount: 2, signature: "my-sell" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.6, signature: "s3" }))).toBe("BUY");
    engine.onBuyFill();
    engine.onEvent(print({ side: "BUY", solAmount: 2, signature: "b1" }));
    expect(engine.onEvent(print({ side: "BUY", wallet: "me", solAmount: 3, signature: "my-exit-buy" }))).toBeNull();
    engine.onEvent(print({ side: "BUY", solAmount: 2, signature: "b2" }));
    expect(engine.onEvent(print({ side: "BUY", solAmount: 2, signature: "b3" }))).toBe("SELL");
    expect(engine.lastSellReason).toContain("sell_hit");
  });

  it("drops a seek when the target sells, and a failed buy waits out the round", () => {
    const engine = bound();
    engine.onEvent(print({ solAmount: 0.6, signature: "s1" }));
    expect(engine.onEvent(print({ side: "SELL", wallet: "target", solAmount: 1, tokenAmount: 1, signature: "out" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");
    expect(engine.needsPoolTape()).toBe(false);
    expect(engine.onEvent(print({ side: "BUY", wallet: "target", solAmount: 1, slot: 2, signature: "next" }))).toBeNull();
    expect(engine.phaseName).toBe("seek_sell");
    expect(engine.needsPoolTape()).toBe(true);

    const failed = bound();
    arm(failed);
    expect(failed.needsPoolTape()).toBe(true);
    failed.onBuyFailed();
    expect(failed.phaseName).toBe("wait");
    expect(failed.needsPoolTape()).toBe(false);
    expect(failed.onEvent(print({ solAmount: 0.6, signature: "s1" }))).toBeNull();
    expect(failed.onEvent(print({ solAmount: 0.6, signature: "s2" }))).toBeNull();
    expect(failed.onEvent(print({ solAmount: 0.6, signature: "s3" }))).toBeNull();
    expect(failed.phaseName).toBe("wait");
  });

  it("restarts the round count after the target max sell", () => {
    const engine = bound();
    expect(roundOfSells(engine, "first")).toBeNull();
    expect(engine.phaseName).toBe("seek_sell");
    expect(engine.onEvent(print({ side: "SELL", wallet: "target", solAmount: 1, tokenAmount: 1, slot: 2, signature: "flat" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");
    expect(engine.onEvent(print({ side: "BUY", wallet: "target", solAmount: 1, slot: 3, signature: "again" }))).toBeNull();
    expect(roundOfSells(engine, "reborn")).toBeNull();
    expect(engine.phaseName).toBe("seek_sell");
    expect(roundOfSells(engine, "second")).toBe("BUY");
  });

  it("keeps a partial target sell on the tape and exits only on a max sell", () => {
    const seek = new StrategyV022Engine(cfg({ take_profit: 0 }));
    seek.bindGate("target", 1_000);
    seek.onEvent(print({ solAmount: 0.6, signature: "s1" }));
    expect(seek.onEvent(print({ side: "SELL", wallet: "target", solAmount: 0.6, tokenAmount: 100, signature: "partial" }))).toBeNull();
    expect(seek.phaseName).toBe("seek_sell");
    expect(seek.onEvent(print({ solAmount: 0.6, signature: "s3" }))).toBeNull();
    expect(roundOfSells(seek, "second")).toBe("BUY");

    const pending = new StrategyV022Engine(cfg({ take_profit: 0 }));
    pending.bindGate("target", 1_000);
    arm(pending);
    expect(pending.onEvent(print({ side: "SELL", wallet: "target", solAmount: 1, tokenAmount: 100, signature: "partial-pending" }))).toBeNull();
    expect(pending.phaseName).toBe("pending");
    expect(pending.onEvent(print({ side: "SELL", wallet: "target", solAmount: 1, tokenAmount: 900, signature: "max-pending" }))).toBeNull();
    expect(pending.phaseName).toBe("idle");

    const hold = new StrategyV022Engine(cfg({ take_profit: 0 }));
    hold.bindGate("target", 1_000);
    arm(hold);
    hold.onBuyFill();
    expect(hold.onEvent(print({ side: "BUY", wallet: "target", solAmount: 0.05, tokenAmount: 1_000, signature: "add" }))).toBeNull();
    expect(hold.onEvent(print({ side: "SELL", wallet: "target", solAmount: 0.05, tokenAmount: 1_000, signature: "half" }))).toBeNull();
    expect(hold.phaseName).toBe("hold");
    const dumped = hold.onEvent(print({ side: "SELL", wallet: "target", solAmount: 0.05, tokenAmount: 950, signature: "max" }));
    expect(dumped).toBe("SELL");
    expect(hold.lastSellReason).toBe("target_sell");
    expect(hold.phaseName).toBe("idle");
  });

  it("drops a short sell round and buys on the second full round", () => {
    const engine = bound();
    expect(engine.onEvent(print({ solAmount: 0.4, signature: "short-1" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.4, signature: "short-2" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.4, signature: "short-3" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.8, signature: "not-slid" }))).toBeNull();
    expect(engine.phaseName).toBe("seek_sell");
    expect(engine.onEvent(print({ solAmount: 0.8, signature: "q1-2" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.8, signature: "q1-3" }))).toBeNull();
    const decision = roundOfSells(engine, "q2", undefined, 0.5);
    expect(decision).toBe("BUY");
    expect(engine.lastBuyDiag.buy_hit_sol).toBe(1.5);
    expect(engine.phaseName).toBe("pending");
  });

  it("drops a short buy round and sells only when a fresh round reaches the minimum", () => {
    const engine = bound();
    arm(engine);
    engine.onBuyFill();
    engine.onEvent(print({ side: "BUY", solAmount: 1, signature: "b1" }));
    engine.onEvent(print({ side: "BUY", solAmount: 1, signature: "b2" }));
    expect(engine.onEvent(print({ side: "BUY", solAmount: 1, signature: "b3" }))).toBeNull();
    expect(engine.onEvent(print({ side: "BUY", solAmount: 2, signature: "b4" }))).toBeNull();
    expect(engine.phaseName).toBe("hold");
    engine.onEvent(print({ side: "BUY", solAmount: 1, signature: "b5" }));
    const sold = engine.onEvent(print({ side: "BUY", solAmount: 1, signature: "b6" }));
    expect(sold).toBe("SELL");
    expect(engine.lastSellReason).toContain("sell_hit");
    expect(engine.phaseName).toBe("wait");
  });

  it("uses sell_hit_count for the exit window", () => {
    const engine = bound({ sell_hit_count: 2 });
    arm(engine);
    engine.onBuyFill();
    expect(engine.onEvent(print({ side: "BUY", solAmount: 2, signature: "b1" }))).toBeNull();
    expect(engine.onEvent(print({ side: "BUY", solAmount: 2, signature: "b2" }))).toBe("SELL");
  });

  it("treats a zero hit count as a window of one", () => {
    const engine = bound({ buy_hit_count: 0, sell_hit_count: 0, buy_hit_min: 0.5, sell_hit_min: 0.5 });
    expect(engine.onEvent(print({ solAmount: 0.6, signature: "s1" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.6, signature: "s2" }))).toBe("BUY");
    engine.onBuyFill();
    expect(engine.onEvent(print({ side: "BUY", solAmount: 0.6, signature: "b1" }))).toBe("SELL");
  });

  it("does not reopen a seek when the target buy arrives after the max sell that closed it", () => {
    const engine = bound();
    expect(engine.onEvent(print({ side: "SELL", wallet: "target", solAmount: 1, tokenAmount: 1, slot: 5, signature: "flat" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");

    expect(engine.onEvent(print({ side: "SELL", wallet: "target", solAmount: 1.5, tokenAmount: 1_000, slot: 20, transactionIndex: 5, signature: "exit-first" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");
    expect(engine.onEvent(print({ side: "BUY", wallet: "target", solAmount: 1.5, tokenAmount: 1_000, slot: 19, signature: "buy-late" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");
    expect(engine.needsPoolTape()).toBe(false);

    expect(engine.onEvent(print({ solAmount: 0.6, slot: 21, signature: "s1" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.6, slot: 22, signature: "s2" }))).toBeNull();
    expect(engine.onEvent(print({ solAmount: 0.6, slot: 23, signature: "s3" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");

    expect(engine.onEvent(print({ side: "BUY", wallet: "target", solAmount: 1.5, tokenAmount: 1_000, slot: 20, transactionIndex: 4, signature: "same-slot-before" }))).toBeNull();
    expect(engine.phaseName).toBe("idle");
    expect(engine.onEvent(print({ side: "BUY", wallet: "target", solAmount: 1.5, tokenAmount: 1_000, slot: 20, transactionIndex: 9, signature: "same-slot-after" }))).toBeNull();
    expect(engine.phaseName).toBe("seek_sell");
  });
});

function roundOfSells(engine: StrategyV022Engine, tag: string, price?: number, solAmount = 0.6): "BUY" | "SELL" | null {
  const priced = price === undefined ? {} : { price };
  engine.onEvent(print({ solAmount, ...priced, signature: `${tag}-1` }));
  engine.onEvent(print({ solAmount, ...priced, signature: `${tag}-2` }));
  return engine.onEvent(print({ solAmount, ...priced, signature: `${tag}-3` }));
}

function arm(engine: StrategyV022Engine): void {
  for (let round = 0; round < 8; round++) {
    const decision = roundOfSells(engine, `arm-${round}`);
    if (decision === "BUY") return;
  }
  throw new Error("arm did not reach a buy");
}
