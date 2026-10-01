import "dotenv/config";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { envSchema } from "./schema.js";
import { ACTIVE_STRATEGY, selectedStrategyNames, type StrategyName, TRADE } from "./trade.js";
import { loadStrategyV011Config } from "./strategyV011.js";
import { loadStrategyV022Config } from "./strategyV022.js";
import { solToLamports } from "../utils/bigint.js";
import { decryptTradingPrivateKey } from "../security/walletCrypto.js";

export type AppConfig = ReturnType<typeof loadConfig>;
export function authenticatedHeliusRpcUrl(rpcUrl: string, apiKey: string): string {
  const url = new URL(rpcUrl);
  if (url.hostname.endsWith("helius-rpc.com") && !url.searchParams.has("api-key")) url.searchParams.set("api-key", apiKey);
  return url.toString();
}

function strategyPlan(
  name: StrategyName,
  strategyV011: ReturnType<typeof loadStrategyV011Config>,
  strategyV022: ReturnType<typeof loadStrategyV022Config>
) {
  const sizeSol = name === "strategy_v_022"
    ? strategyV022.size_sol
    : strategyV011.rule_1_enabled ? strategyV011.rule_1_size_sol : strategyV011.rule_2_size_sol;
  const maxEntryMarketCapSol = name === "strategy_v_022" ? strategyV022.max_mc_sol : strategyV011.max_mc_sol;
  const buyAmountLamports = solToLamports(sizeSol.toFixed(9));
  if (buyAmountLamports <= 0n) throw new Error(`${name} size must be positive`);
  if (maxEntryMarketCapSol <= 0) throw new Error(`${name} max market cap must be positive`);
  return { name, buyAmountLamports, maxEntryMarketCapSol };
}

function loadTradingPrivateKeyBase58(env: {
  TRADING_PRIVATE_KEY_ENCRYPTED: string;
  TRADING_PRIVATE_KEY_BASE58: string;
  WALLET_KEY_FILE: string;
}): string {
  const encrypted = env.TRADING_PRIVATE_KEY_ENCRYPTED.trim();
  if (encrypted) {
    return decryptTradingPrivateKey(encrypted, env.WALLET_KEY_FILE).trim();
  }
  const plain = env.TRADING_PRIVATE_KEY_BASE58.trim();
  if (plain) return plain;
  throw new Error("No trading private key configured");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = envSchema.parse(env);
  const strategyV011 = loadStrategyV011Config();
  const strategyV022 = loadStrategyV022Config();
  const strategy = ACTIVE_STRATEGY;
  const strategyPlans = selectedStrategyNames().map(name => strategyPlan(name, strategyV011, strategyV022));
  const privateKeyBase58 = loadTradingPrivateKeyBase58(value);
  const secret = bs58.decode(privateKeyBase58);
  if (secret.length !== 64) throw new Error("Trading private key must decode to 64 bytes");
  return Object.freeze({
    ...value,
    strategy,
    strategyPlans,
    strategyV011,
    strategyV022,
    buySlippageBps: TRADE.buySlippageBps,
    sellSlippageBps: TRADE.sellSlippageBps,
    maxEntryDeviationPct: TRADE.maxEntryDeviationPct,
    HELIUS_RPC_URL: authenticatedHeliusRpcUrl(value.HELIUS_RPC_URL, value.HELIUS_API_KEY),
    keypair: Keypair.fromSecretKey(secret)
  });
}
