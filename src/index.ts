import pino from "pino";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config/index.js";
import { BlockhashManager } from "./execution/blockhashManager.js";
import { ConfirmationTracker } from "./execution/confirmationTracker.js";
import { LiveStrategyExecution } from "./execution/liveExecution.js";
import { LossStreakPositionSizer } from "./execution/positionSizer.js";
import { YellowstoneVibeClient } from "./grpc/vibeClient.js";
import { HeliusSender } from "./helius/sender.js";
import { RecoveryJournal } from "./recovery/journal.js";
import { PnlJournal } from "./pnl/pnlJournal.js";
import { TradingRuntime } from "./runtime.js";
import { PumpBondingCurveAdapter, PumpSwapAdapter } from "./venues/pumpAdapters.js";
import { PumpTradeDecoder } from "./venues/tradeDecoder.js";

const config = loadConfig();
const logger = pino({
  level: config.LOG_LEVEL,
  base: undefined,
  transport: { target: "pino-pretty", options: { colorize: false, translateTime: "SYS:standard", singleLine: true, ignore: "pid,hostname" } }
});
const connection = new Connection(config.HELIUS_RPC_URL, { commitment: "processed", confirmTransactionInitialTimeout: 15_000 });
const blockhashes = new BlockhashManager(connection, config.BLOCKHASH_REFRESH_MS);
const sender = new HeliusSender(config.HELIUS_SENDER_URL, config.HELIUS_SENDER_SWQOS_ONLY, true);
const confirmations = new ConfirmationTracker(connection);
const journal = new RecoveryJournal(config.RECOVERY_PATH);
const pnlJournal = new PnlJournal(config.PNL_PATH);
const positionSizer = new LossStreakPositionSizer(config.buyAmountLamports, config.TSR_STREAK_SIZING_ENABLED, config.TSR_LOSS_STREAK_THRESHOLD, config.TSR_LOSS_STREAK_BUY_MULTIPLIER);
const vibe = new YellowstoneVibeClient({ endpoint: config.VIBE_GRPC_ENDPOINT, token: config.VIBE_GRPC_TOKEN }, error => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, "[02 STREAM] Vibe connection error");
});
const adapters = [
  new PumpBondingCurveAdapter(connection, config.COMPUTE_UNIT_LIMIT, config.PRIORITY_FEE_LAMPORTS, config.HELIUS_TIP_LAMPORTS),
  new PumpSwapAdapter(connection, config.COMPUTE_UNIT_LIMIT, config.PRIORITY_FEE_LAMPORTS, config.HELIUS_TIP_LAMPORTS)
];
const execution = new LiveStrategyExecution(connection, config.keypair, config.buyAmountLamports, config.BUY_SLIPPAGE_BPS, config.SELL_SLIPPAGE_BPS, config.MAX_ENTRY_DEVIATION_PCT, config.TSR_MAX_ENTRY_MARKET_CAP_SOL, blockhashes, sender, confirmations, journal, positionSizer, pnlJournal, logger);
const runtime = new TradingRuntime(config, connection, vibe, journal, new PumpTradeDecoder(connection), adapters, execution, positionSizer, logger);

logger.info({ targetWallet: config.TARGET_WALLET, executionMode: config.EXECUTION_MODE, buyAmountLamports: config.buyAmountLamports, streakSizingEnabled: config.TSR_STREAK_SIZING_ENABLED, lossStreakThreshold: config.TSR_LOSS_STREAK_THRESHOLD, lossStreakBuyMultiplier: config.TSR_LOSS_STREAK_BUY_MULTIPLIER, reentryMaxBuyPressure: config.TSR_REENTRY_MAX_BUY_PRESSURE, pnlPath: config.PNL_PATH, maxConcurrentPositions: config.MAX_CONCURRENT_POSITIONS, maxTotalExposureLamports: config.maxTotalExposureLamports, minTargetSellSol: config.TSR_MIN_TARGET_SELL_SOL, minTargetSellCurve: config.TSR_MIN_TARGET_SELL_CURVE, entryDelaySec: config.TSR_ENTRY_DELAY_SEC, minPostSellReturnPct: config.TSR_POST_SELL_MIN_RETURN_PCT, maxPostSellReturnPct: config.TSR_POST_SELL_MAX_RETURN_PCT, maxEntryMarketCapSol: config.TSR_MAX_ENTRY_MARKET_CAP_SOL, profitLockEnabled: config.TSR_PROFIT_LOCK_ENABLED, profitLockActivatePct: config.TSR_PROFIT_LOCK_ACTIVATE_PCT, profitLockFloorPct: config.TSR_PROFIT_LOCK_FLOOR_PCT, logLevel: config.LOG_LEVEL }, "[01 STARTUP] Configuration loaded");

blockhashes.start(error => logger.error({ err: error instanceof Error ? error.message : String(error) }, "[01 STARTUP] Blockhash refresh failed"));
await runtime.start();
logger.info({ wallet: config.keypair.publicKey.toBase58(), executionMode: config.EXECUTION_MODE, swqosOnly: config.HELIUS_SENDER_SWQOS_ONLY }, "[01 STARTUP] Bot ready; live subscriptions active");

let closing = false;
async function shutdown(): Promise<void> {
  if (closing) return;
  closing = true;
  blockhashes.stop();
  await runtime.close();
  await sender.close();
}
process.once("SIGINT", () => void shutdown().finally(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().finally(() => process.exit(0)));
