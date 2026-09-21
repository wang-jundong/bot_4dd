import { describe, expect, it } from "vitest";
import { LossStreakPositionSizer } from "../src/execution/positionSizer.js";

describe("loss-streak position sizing", () => {
  it("reduces after two closed losses and resets after a win", () => {
    const sizer = new LossStreakPositionSizer(10_000_000n, true, 2, 0.5);
    expect(sizer.currentBuyLamports()).toBe(10_000_000n);
    sizer.recordClosedPosition(100, 90);
    expect(sizer.currentBuyLamports()).toBe(10_000_000n);
    sizer.recordClosedPosition(100, 80);
    expect(sizer.currentBuyLamports()).toBe(5_000_000n);
    sizer.recordClosedPosition(100, 70);
    expect(sizer.currentBuyLamports()).toBe(5_000_000n);
    sizer.recordClosedPosition(100, 101);
    expect(sizer.currentBuyLamports()).toBe(10_000_000n);
  });

  it("does nothing while disabled", () => {
    const sizer = new LossStreakPositionSizer(10_000_000n, false, 2, 0.5);
    sizer.recordClosedPosition(100, 50);
    sizer.recordClosedPosition(100, 50);
    expect(sizer.currentBuyLamports()).toBe(10_000_000n);
  });

  it("restores only confirmed closed-position outcomes", () => {
    const sizer = new LossStreakPositionSizer(10_000_000n, true, 2, 0.5);
    sizer.restore([
      { event: "buy_processed", prices: { actualEntryFillPrice: 100 } },
      { event: "position_closed", prices: { actualEntryFillPrice: 100, actualExitFillPrice: 90 } },
      { event: "sell_sent", prices: { actualEntryFillPrice: 100, actualExitFillPrice: 80 } },
      { event: "position_closed", prices: { actualEntryFillPrice: 100 }, fill: { price: 80 } }
    ]);
    expect(sizer.lossStreak).toBe(2);
    expect(sizer.currentBuyLamports()).toBe(5_000_000n);
  });

  it("ignores flat or incomplete outcomes", () => {
    const sizer = new LossStreakPositionSizer(10_000_000n, true, 1, 0.5);
    sizer.recordClosedPosition(undefined, 90);
    sizer.recordClosedPosition(100, 100);
    expect(sizer.lossStreak).toBe(0);
  });
});
