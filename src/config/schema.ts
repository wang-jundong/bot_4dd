import { z } from "zod";

const numeric = (min = -Number.MAX_VALUE) => z.coerce.number().finite().min(min);
const integer = (min = 0) => z.coerce.number().int().min(min);
const bool = z.enum(["true", "false"]).transform(v => v === "true");

export const envSchema = z.object({
  STRATEGY: z.literal("target_sell_reversal").default("target_sell_reversal"),
  EXECUTION_MODE: z.literal("live").default("live"),
  TARGET_WALLET: z.string().min(32), BLOCKED_MINTS: z.string().default(""),
  VIBE_GRPC_ENDPOINT: z.string().min(1), VIBE_GRPC_TOKEN: z.string().min(1),
  HELIUS_API_KEY: z.string().min(1), HELIUS_RPC_URL: z.string().url(), HELIUS_SENDER_URL: z.string().url(),
  HELIUS_SENDER_SWQOS_ONLY: bool.default("true"), TRADING_PRIVATE_KEY_BASE58: z.string().min(1),
  BUY_AMOUNT_SOL: z.string().min(1), MIN_WALLET_SOL: numeric(0).default(0.05), MAX_CONCURRENT_POSITIONS: integer(1).default(1), MAX_TOTAL_EXPOSURE_SOL: numeric(0).default(0.05), BUY_SLIPPAGE_BPS: integer(), SELL_SLIPPAGE_BPS: integer(), MAX_ENTRY_DEVIATION_PCT: numeric(0).default(10), TSR_MAX_ENTRY_MARKET_CAP_SOL: numeric(0.000001).default(100),
  TSR_STREAK_SIZING_ENABLED: bool.default("false"), TSR_LOSS_STREAK_THRESHOLD: integer(1).default(2), TSR_LOSS_STREAK_BUY_MULTIPLIER: numeric(0.000001).max(1).default(0.5),
  PRIORITY_FEE_LAMPORTS: integer(1), HELIUS_TIP_LAMPORTS: integer(5000).default(5000), COMPUTE_UNIT_LIMIT: integer(1),
  TSR_ENTRY_MODE: z.literal("delayed_after_sell").default("delayed_after_sell"),
  TSR_MIN_TARGET_SELL_SOL: numeric(0.000000001).default(0.01), TSR_MIN_TARGET_SELL_CURVE: numeric(0).max(1).default(0.6),
  TSR_PRE_SELL_WINDOW_SEC: numeric(0).default(60), TSR_MIN_PRE_SELL_TRADES: integer().default(11),
  TSR_MAX_PRE_SELL_TRADES: integer().default(60), TSR_ENTRY_DELAY_SEC: numeric(0).default(2),
  TSR_BOUND_WINDOW_TO_TARGET_BUY: bool.default("true"), TSR_POST_SELL_MIN_BUY_PRESSURE: numeric(0).max(1).default(0.45),
  TSR_POST_SELL_MAX_DRAWDOWN_PCT: numeric(0).default(5), TSR_POST_SELL_MIN_RETURN_PCT: numeric().default(-5), TSR_POST_SELL_MAX_RETURN_PCT: numeric().default(10),
  TSR_PROFIT_LOCK_ENABLED: bool.default("true"), TSR_PROFIT_LOCK_ACTIVATE_PCT: numeric().default(30), TSR_PROFIT_LOCK_FLOOR_PCT: numeric().default(20),
  TSR_TAKE_PROFIT_PCT: numeric().default(50), TSR_STOP_LOSS_PCT: numeric().default(-30),
  TSR_MAX_HOLD_SEC: numeric(0).default(3600), TSR_SELL_MODE: z.literal("price").default("price"),
  TSR_REENTRY_ENABLED: bool.default("false"), TSR_REENTRY_DUMP_WINDOW_SEC: numeric(0).default(2),
  TSR_REENTRY_MIN_SELL_PRESSURE: numeric(0).max(1).default(0.85), TSR_REENTRY_MIN_SELL_SOL: numeric(0).default(3),
  TSR_REENTRY_SAME_SLOT_MIN_SELLERS: integer(1).default(3), TSR_REENTRY_WAIT_SEC: numeric(0).default(60),
  TSR_REENTRY_TRIGGER_BUY_SOL: numeric(0).default(0.1), TSR_REENTRY_CONFIRM_SEC: numeric(0).default(2),
  TSR_REENTRY_MIN_BUY_PRESSURE: numeric(0).max(1).default(0.6), TSR_REENTRY_MAX_BUY_PRESSURE: numeric(0).max(1).default(0.9), TSR_REENTRY_MIN_DISTINCT_BUYERS: integer(1).default(3),
  TSR_REENTRY_MIN_RECOVERY_PCT: numeric(0).default(10), TSR_REENTRY_NO_NEW_LOW_SEC: numeric(0).default(1),
  TSR_REENTRY_MAX_TRIGGER_RETURN_PCT: numeric(0).default(20), TSR_REENTRY_TAKE_PROFIT_PCT: numeric().default(60),
  TSR_REENTRY_STOP_LOSS_PCT: numeric().default(-20), TSR_REENTRY_MAX_HOLD_SEC: numeric(0).default(3600),
  EVENT_RETENTION_SEC: numeric(1).default(180), BLOCKHASH_REFRESH_MS: integer(1000).default(10000),
  LOG_LEVEL: z.string().default("info"), RECOVERY_PATH: z.string().default("./recovery/lifecycle.jsonl"), PNL_PATH: z.string().min(1).default("./logs/pnl.jsonl")
}).superRefine((v, ctx) => {
  if (v.TSR_MIN_PRE_SELL_TRADES > v.TSR_MAX_PRE_SELL_TRADES) ctx.addIssue({ code: "custom", message: "min trades exceeds max trades" });
  if (v.TSR_POST_SELL_MIN_RETURN_PCT > v.TSR_POST_SELL_MAX_RETURN_PCT) ctx.addIssue({ code: "custom", path: ["TSR_POST_SELL_MAX_RETURN_PCT"], message: "maximum post-sell return must be at least the minimum post-sell return" });
  if (v.TSR_REENTRY_MIN_BUY_PRESSURE > v.TSR_REENTRY_MAX_BUY_PRESSURE) ctx.addIssue({ code: "custom", path: ["TSR_REENTRY_MAX_BUY_PRESSURE"], message: "maximum re-entry buy pressure must be at least the minimum re-entry buy pressure" });
  if (v.TSR_PROFIT_LOCK_ENABLED && v.TSR_PROFIT_LOCK_FLOOR_PCT >= v.TSR_PROFIT_LOCK_ACTIVATE_PCT) ctx.addIssue({ code: "custom", path: ["TSR_PROFIT_LOCK_FLOOR_PCT"], message: "profit-lock floor must be below activation threshold when profit lock is enabled" });
  if (!v.HELIUS_SENDER_SWQOS_ONLY && v.HELIUS_TIP_LAMPORTS < 1_000_000) ctx.addIssue({ code: "custom", path: ["HELIUS_TIP_LAMPORTS"], message: "Sender Max requires at least 1000000 tip lamports" });
});
