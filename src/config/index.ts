import "dotenv/config";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { envSchema } from "./schema.js";
import { solToLamports } from "../utils/bigint.js";

export type AppConfig = ReturnType<typeof loadConfig>;
export function authenticatedHeliusRpcUrl(rpcUrl: string, apiKey: string): string {
  const url = new URL(rpcUrl);
  if (url.hostname.endsWith("helius-rpc.com") && !url.searchParams.has("api-key")) url.searchParams.set("api-key", apiKey);
  return url.toString();
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const value = envSchema.parse(env);
  const buyAmountLamports = solToLamports(value.BUY_AMOUNT_SOL);
  const minWalletLamports = solToLamports(String(value.MIN_WALLET_SOL));
  const maxTotalExposureLamports = solToLamports(String(value.MAX_TOTAL_EXPOSURE_SOL));
  if (buyAmountLamports <= 0n) throw new Error("BUY_AMOUNT_SOL must be positive");
  if (maxTotalExposureLamports < buyAmountLamports) throw new Error("MAX_TOTAL_EXPOSURE_SOL must cover at least one BUY_AMOUNT_SOL");
  const secret = bs58.decode(value.TRADING_PRIVATE_KEY_BASE58);
  if (secret.length !== 64) throw new Error("TRADING_PRIVATE_KEY_BASE58 must decode to 64 bytes");
  return Object.freeze({
    ...value,
    HELIUS_RPC_URL: authenticatedHeliusRpcUrl(value.HELIUS_RPC_URL, value.HELIUS_API_KEY),
    buyAmountLamports, minWalletLamports, maxTotalExposureLamports,
    keypair: Keypair.fromSecretKey(secret)
  });
}
