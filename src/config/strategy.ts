import type { AppConfig } from "./index.js";
import type { StrategyThresholds } from "../strategy/calculations.js";
import { solToLamports } from "../utils/bigint.js";
export const strategyThresholds = (c: AppConfig): StrategyThresholds => ({
  minTargetSellLamports: solToLamports(String(c.TSR_MIN_TARGET_SELL_SOL)), minCurve: c.TSR_MIN_TARGET_SELL_CURVE,
  preSellWindowMs: c.TSR_PRE_SELL_WINDOW_SEC * 1000, minTrades: c.TSR_MIN_PRE_SELL_TRADES,
  maxTrades: c.TSR_MAX_PRE_SELL_TRADES, boundToTargetBuy: c.TSR_BOUND_WINDOW_TO_TARGET_BUY,
  minBuyPressure: c.TSR_POST_SELL_MIN_BUY_PRESSURE, maxDrawdownPct: c.TSR_POST_SELL_MAX_DRAWDOWN_PCT,
  minReturnPct: c.TSR_POST_SELL_MIN_RETURN_PCT, maxReturnPct: c.TSR_POST_SELL_MAX_RETURN_PCT,
  profitLockEnabled: c.TSR_PROFIT_LOCK_ENABLED, profitLockActivatePct: c.TSR_PROFIT_LOCK_ACTIVATE_PCT,
  profitLockFloorPct: c.TSR_PROFIT_LOCK_FLOOR_PCT, takeProfitPct: c.TSR_TAKE_PROFIT_PCT,
  stopLossPct: c.TSR_STOP_LOSS_PCT, maxHoldMs: c.TSR_MAX_HOLD_SEC * 1000,
  reentry: {
    enabled: c.TSR_REENTRY_ENABLED, dumpWindowMs: c.TSR_REENTRY_DUMP_WINDOW_SEC * 1000,
    minSellPressure: c.TSR_REENTRY_MIN_SELL_PRESSURE, minSellLamports: solToLamports(String(c.TSR_REENTRY_MIN_SELL_SOL)),
    sameSlotMinSellers: c.TSR_REENTRY_SAME_SLOT_MIN_SELLERS, waitMs: c.TSR_REENTRY_WAIT_SEC * 1000,
    triggerBuyLamports: solToLamports(String(c.TSR_REENTRY_TRIGGER_BUY_SOL)), confirmMs: c.TSR_REENTRY_CONFIRM_SEC * 1000,
    minBuyPressure: c.TSR_REENTRY_MIN_BUY_PRESSURE, maxBuyPressure: c.TSR_REENTRY_MAX_BUY_PRESSURE, minDistinctBuyers: c.TSR_REENTRY_MIN_DISTINCT_BUYERS,
    minRecoveryPct: c.TSR_REENTRY_MIN_RECOVERY_PCT, noNewLowMs: c.TSR_REENTRY_NO_NEW_LOW_SEC * 1000,
    maxTriggerReturnPct: c.TSR_REENTRY_MAX_TRIGGER_RETURN_PCT, takeProfitPct: c.TSR_REENTRY_TAKE_PROFIT_PCT,
    stopLossPct: c.TSR_REENTRY_STOP_LOSS_PCT, maxHoldMs: c.TSR_REENTRY_MAX_HOLD_SEC * 1000
  }
});
