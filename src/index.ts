import pino from "pino";
import { Connection } from "@solana/web3.js";
import { loadConfig } from "./config/index.js";
import { BlockhashManager } from "./execution/blockhashManager.js";
import { ConfirmationTracker } from "./execution/confirmationTracker.js";
import { LiveStrategyExecution } from "./execution/liveExecution.js";
import { YellowstoneVibeClient } from "./grpc/vibeClient.js";
import { HeliusSender } from "./helius/sender.js";
import { RecoveryJournal } from "./recovery/journal.js";
import { PnlJournal } from "./pnl/pnlJournal.js";
import { TradingRuntime } from "./runtime.js";
import { StrategyV001Live } from "./strategy/strategyV001Live.js";
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
const vibe = new YellowstoneVibeClient({ endpoint: config.VIBE_GRPC_ENDPOINT, token: config.VIBE_GRPC_TOKEN }, error => {
  logger.error({ err: error instanceof Error ? error.message : String(error) }, "[02 STREAM] Vibe connection error");
});
const adapters = [
  new PumpBondingCurveAdapter(connection, config.COMPUTE_UNIT_LIMIT, config.PRIORITY_FEE_LAMPORTS, config.HELIUS_TIP_LAMPORTS),
  new PumpSwapAdapter(connection, config.COMPUTE_UNIT_LIMIT, config.PRIORITY_FEE_LAMPORTS, config.HELIUS_TIP_LAMPORTS)
];
const execution = new LiveStrategyExecution(
  connection,
  config.keypair,
  config.buyAmountLamports,
  config.BUY_SLIPPAGE_BPS,
  config.SELL_SLIPPAGE_BPS,
  config.MAX_ENTRY_DEVIATION_PCT,
  config.MAX_ENTRY_MARKET_CAP_SOL,
  blockhashes,
  sender,
  confirmations,
  journal,
  pnlJournal,
  logger
);

let runtime!: TradingRuntime;
const strategy = new StrategyV001Live(
  config.strategyV001,
  execution,
  config.keypair,
  config.TARGET_WALLET,
  config.BUY_SLIPPAGE_BPS,
  config.SELL_SLIPPAGE_BPS,
  state => runtime.canOpenPosition(state),
  logger
);
runtime = new TradingRuntime(config, connection, vibe, journal, new PumpTradeDecoder(connection), adapters, execution, logger, strategy);

logger.info({
  strategy: config.STRATEGY,
  targetWallet: config.TARGET_WALLET,
  executionMode: config.EXECUTION_MODE,
  buyAmountLamports: config.buyAmountLamports,
  rule1SizeSol: config.strategyV001.rule_1_size_sol,
  rule2Enabled: config.strategyV001.rule_2_enabled,
  clip: [config.strategyV001.clip_lo, config.strategyV001.clip_hi],
  mc: [config.strategyV001.min_mc_sol, config.strategyV001.max_mc_sol],
  timerMs: config.strategyV001.timer_ms,
  pnlPath: config.PNL_PATH,
  maxConcurrentPositions: config.MAX_CONCURRENT_POSITIONS,
  maxEntryMarketCapSol: config.MAX_ENTRY_MARKET_CAP_SOL,
  logLevel: config.LOG_LEVEL
}, "[01 STARTUP] Configuration loaded");

blockhashes.start(error => logger.error({ err: error instanceof Error ? error.message : String(error) }, "[01 STARTUP] Blockhash refresh failed"));
await runtime.start();
logger.info({ wallet: config.keypair.publicKey.toBase58(), strategy: config.STRATEGY, swqosOnly: config.HELIUS_SENDER_SWQOS_ONLY }, "[01 STARTUP] Bot ready; strategy_v_001 active");

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
