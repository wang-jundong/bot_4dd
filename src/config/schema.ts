import { z } from "zod";

const numeric = (min = -Number.MAX_VALUE) => z.coerce.number().finite().min(min);
const integer = (min = 0) => z.coerce.number().int().min(min);
const bool = z.enum(["true", "false"]).transform(v => v === "true");

export const envSchema = z.object({
  STRATEGY: z.literal("strategy_v_001").default("strategy_v_001"),
  EXECUTION_MODE: z.literal("live").default("live"),
  TARGET_WALLET: z.string().min(32),
  BLOCKED_MINTS: z.string().default(""),
  VIBE_GRPC_ENDPOINT: z.string().min(1),
  VIBE_GRPC_TOKEN: z.string().min(1),
  HELIUS_API_KEY: z.string().min(1),
  HELIUS_RPC_URL: z.string().url(),
  HELIUS_SENDER_URL: z.string().url(),
  HELIUS_SENDER_SWQOS_ONLY: bool.default("true"),
  /** Fernet key file path (same role as cryptotrading_prod SIG_KEYS[*].key_file). */
  WALLET_KEY_FILE: z.string().min(1).default("./secrets/solana.key"),
  /** Fernet ciphertext of XOR(private_key). Prefer this over plaintext. */
  TRADING_PRIVATE_KEY_ENCRYPTED: z.string().optional().default(""),
  /** Legacy plaintext base58 — only used if ENCRYPTED is empty (local/dev escape hatch). */
  TRADING_PRIVATE_KEY_BASE58: z.string().optional().default(""),
  BUY_AMOUNT_SOL: z.string().min(1),
  MAX_CONCURRENT_POSITIONS: integer(1).default(1),
  BUY_SLIPPAGE_BPS: integer(),
  SELL_SLIPPAGE_BPS: integer(),
  MAX_ENTRY_DEVIATION_PCT: numeric(0).default(10),
  MAX_ENTRY_MARKET_CAP_SOL: numeric(0.000001).default(120),
  PRIORITY_FEE_LAMPORTS: integer(1),
  HELIUS_TIP_LAMPORTS: integer(5000).default(5000),
  COMPUTE_UNIT_LIMIT: integer(1),
  EVENT_RETENTION_SEC: numeric(1).default(180),
  BLOCKHASH_REFRESH_MS: integer(1000).default(10000),
  LOG_LEVEL: z.string().default("info"),
  RECOVERY_PATH: z.string().default("./recovery/lifecycle.jsonl"),
  PNL_PATH: z.string().min(1).default("./logs/pnl.jsonl")
}).superRefine((v, ctx) => {
  if (!v.HELIUS_SENDER_SWQOS_ONLY && v.HELIUS_TIP_LAMPORTS < 1_000_000) {
    ctx.addIssue({ code: "custom", path: ["HELIUS_TIP_LAMPORTS"], message: "Sender Max requires at least 1000000 tip lamports" });
  }
  if (!v.TRADING_PRIVATE_KEY_ENCRYPTED.trim() && !v.TRADING_PRIVATE_KEY_BASE58.trim()) {
    ctx.addIssue({
      code: "custom",
      path: ["TRADING_PRIVATE_KEY_ENCRYPTED"],
      message: "set TRADING_PRIVATE_KEY_ENCRYPTED (+ WALLET_KEY_FILE) or legacy TRADING_PRIVATE_KEY_BASE58"
    });
  }
});
