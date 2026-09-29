import "dotenv/config";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { envSchema } from "./schema.js";
import { loadStrategyV001Config } from "./strategyV001.js";
import { solToLamports } from "../utils/bigint.js";
import { decryptTradingPrivateKey } from "../security/walletCrypto.js";

export type AppConfig = ReturnType<typeof loadConfig>;
export function authenticatedHeliusRpcUrl(rpcUrl: string, apiKey: string): string {
  const url = new URL(rpcUrl);
  if (url.hostname.endsWith("helius-rpc.com") && !url.searchParams.has("api-key")) url.searchParams.set("api-key", apiKey);
  return url.toString();
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
  const strategyV001 = loadStrategyV001Config();
  const buyAmountLamports = solToLamports(value.BUY_AMOUNT_SOL);
  if (buyAmountLamports <= 0n) throw new Error("BUY_AMOUNT_SOL must be positive");
  const privateKeyBase58 = loadTradingPrivateKeyBase58(value);
  const secret = bs58.decode(privateKeyBase58);
  if (secret.length !== 64) throw new Error("Trading private key must decode to 64 bytes");
  return Object.freeze({
    ...value,
    strategyV001,
    HELIUS_RPC_URL: authenticatedHeliusRpcUrl(value.HELIUS_RPC_URL, value.HELIUS_API_KEY),
    buyAmountLamports,
    keypair: Keypair.fromSecretKey(secret)
  });
}
