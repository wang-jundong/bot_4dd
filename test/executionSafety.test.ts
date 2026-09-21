import { describe, expect, it } from "vitest";
import { isNonRetryableBuyError, retryEntryDeviationPct } from "../src/execution/buyRetryPolicy.js";

describe("buy retry safety", () => {
  it("does not retry Pump buys rejected for excessive SOL", () => {
    expect(isNonRetryableBuyError(new Error('transaction failed: {"InstructionError":[4,{"Custom":6002}]}'), "pump")).toBe(true);
  });

  it("does not retry PumpSwap buys rejected for slippage", () => {
    expect(isNonRetryableBuyError(new Error('transaction failed: {"InstructionError":[7,{"Custom":6004}]}'), "pumpswap")).toBe(true);
  });

  it("allows retrying unrelated transient failures", () => {
    expect(isNonRetryableBuyError(new Error("confirmation timed out"), "pump")).toBe(false);
  });

  it("does not confuse venue-specific custom errors", () => {
    expect(isNonRetryableBuyError(new Error('{"Custom":6002}'), "pumpswap")).toBe(false);
    expect(isNonRetryableBuyError(new Error('{"Custom":6004}'), "pump")).toBe(false);
  });

  it("measures retry movement from the original signal", () => {
    expect(retryEntryDeviationPct(100, 110)).toBeCloseTo(10);
  });
});
