/** Live bot prices are lamports/raw-token. Scalpingbot strategy_v_001 uses SOL/token (6dp). */
export const LIVE_PRICE_TO_STRATEGY = 1e-3;
const LAMPORTS_PER_SOL = 1_000_000_000;

export function toStrategyPrice(livePrice: number): number {
  return livePrice > 0 ? livePrice * LIVE_PRICE_TO_STRATEGY : 0;
}

export function lamportsToSol(lamports: bigint): number {
  return Number(lamports) / LAMPORTS_PER_SOL;
}

export function solToLamportsNumber(sol: number): bigint {
  if (!Number.isFinite(sol) || sol <= 0) return 0n;
  return BigInt(Math.round(sol * LAMPORTS_PER_SOL));
}

export function slippagePctToBps(pct: number): number {
  return Math.max(0, Math.round(pct * 100));
}
