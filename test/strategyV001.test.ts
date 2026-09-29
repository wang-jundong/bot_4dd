import { describe, expect, it } from "vitest";
import { loadStrategyV001Config } from "../src/config/strategyV001.js";
import { PHASE_DONE, PHASE_HOLDING, PHASE_WATCHING, StrategyV001Engine } from "../src/strategy/strategyV001Engine.js";
import type { StrategyMarketEvent } from "../src/strategy/strategyV001Engine.js";

const cfg = () => loadStrategyV001Config();

const event = (overrides: Partial<StrategyMarketEvent> = {}): StrategyMarketEvent => ({
  signature: "sig",
  slot: 1,
  timestampSec: 1_700_000_000,
  timestampMs: 1_700_000_000_000,
  side: "BUY",
  wallet: "target",
  solAmount: 3.0,
  price: 50e-9, // -> mcap = 50 SOL
  ...overrides
});

describe("strategy_v_001 engine", () => {
  it("binds an in-clip gate buy into watching", () => {
    const engine = new StrategyV001Engine(cfg());
    const decision = engine.bindGateBuy({
      price: 50e-9,
      sol: 3.0,
      tsSec: 1_700_000_000,
      wallet: "target",
      gateSig: "gate",
      nowMs: 1_700_000_000_000
    });
    expect(decision.kind).toBe("none");
    expect(engine.phaseName).toBe(PHASE_WATCHING);
  });

  it("skips gate buys outside the SOL clip", () => {
    const engine = new StrategyV001Engine(cfg());
    const decision = engine.bindGateBuy({
      price: 50e-9,
      sol: 1.0,
      tsSec: 1_700_000_000,
      wallet: "target",
      gateSig: "gate",
      nowMs: 1_700_000_000_000
    });
    expect(decision.kind).toBe("skip");
    expect(engine.phaseName).toBe(PHASE_DONE);
  });

  it("fires rule_1 after the watch window when momentum is calm", () => {
    const engine = new StrategyV001Engine(cfg());
    engine.bindGateBuy({
      price: 50e-9,
      sol: 3.0,
      tsSec: 1_700_000_000,
      wallet: "target",
      gateSig: "gate",
      nowMs: 1_700_000_000_000
    });
    // Seed a lookback sample so 1s momentum is flat.
    engine.onTimer(50e-9, 1_700_000_000_000);
    const decision = engine.onTimer(50e-9, 1_700_000_000_000 + 6_000);
    expect(decision.kind).toBe("fire_buy");
    if (decision.kind === "fire_buy") expect(decision.reason).toContain("rule_1");
  });

  it("exits on mark take-profit vs gate buy", () => {
    const engine = new StrategyV001Engine(cfg());
    engine.bindGateBuy({
      price: 50e-9,
      sol: 3.0,
      tsSec: 1_700_000_000,
      wallet: "target",
      gateSig: "gate",
      nowMs: 1_700_000_000_000
    });
    engine.onTimer(50e-9, 1_700_000_000_000 + 6_000);
    engine.onBuyFill(50e-9, 1_700_000_006, 10);
    expect(engine.phaseName).toBe(PHASE_HOLDING);
    const decision = engine.onTimer(50e-9 * 1.55, 1_700_000_000_000 + 7_000);
    expect(decision.kind).toBe("fire_sell");
    if (decision.kind === "fire_sell") expect(decision.reason).toContain("rule_1_mark_tp");
  });

  it("aborts when the target sells before our buy", () => {
    const engine = new StrategyV001Engine(cfg());
    engine.bindGateBuy({
      price: 50e-9,
      sol: 3.0,
      tsSec: 1_700_000_000,
      wallet: "target",
      gateSig: "gate",
      nowMs: 1_700_000_000_000
    });
    const decision = engine.onEvent(event({ side: "SELL", signature: "sell1", solAmount: 1, timestampMs: 1_700_000_001_000 }), false);
    expect(decision.kind).toBe("skip");
    if (decision.kind === "skip") expect(decision.detail).toContain("sold_before");
    expect(engine.phaseName).toBe(PHASE_DONE);
  });
});
