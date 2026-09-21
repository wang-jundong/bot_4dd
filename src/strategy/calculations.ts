import type { PoolTradeEvent } from "../events/types.js";
import { compareEvents } from "../events/types.js";

export interface ReentryThresholds {
  enabled: boolean; dumpWindowMs: number; minSellPressure: number; minSellLamports: bigint; sameSlotMinSellers: number;
  waitMs: number; triggerBuyLamports: bigint; confirmMs: number; minBuyPressure: number; maxBuyPressure: number; minDistinctBuyers: number;
  minRecoveryPct: number; noNewLowMs: number; maxTriggerReturnPct: number;
  takeProfitPct: number; stopLossPct: number; maxHoldMs: number;
}

export interface StrategyThresholds {
  minTargetSellLamports: bigint; minCurve: number; preSellWindowMs: number;
  minTrades: number; maxTrades: number; boundToTargetBuy: boolean;
  minBuyPressure: number; maxDrawdownPct: number; minReturnPct: number; maxReturnPct: number;
  profitLockEnabled: boolean; profitLockActivatePct: number; profitLockFloorPct: number;
  takeProfitPct: number; stopLossPct: number; maxHoldMs: number;
  reentry: ReentryThresholds;
}
export interface ReversalConfirmationStats {
  buyLamports: bigint; sellLamports: bigint; minPrice: number; latestPrice: number;
  startTimestampMs: number; deadlineTimestampMs: number;
}
export interface BundleDumpStats {
  eligible: boolean; buyLamports: bigint; sellLamports: bigint;
  sellPressure: number; maxSameSlotSellers: number;
}
export interface ReentryConfirmationStats {
  triggerPrice: number; deadlineMs: number; buyLamports: bigint; sellLamports: bigint;
  buyers: Set<string>; latestPrice: number; minPrice: number; lastNewLowMs: number;
}
export function qualifyTargetSell(events: readonly PoolTradeEvent[], targetBuyMs: number, sell: PoolTradeEvent, t: StrategyThresholds) {
  const start = t.boundToTargetBuy ? Math.max(sell.timestampMs - t.preSellWindowMs, targetBuyMs) : sell.timestampMs - t.preSellWindowMs;
  let count = 0;
  for (const e of events) if (e.timestampMs >= start && e.timestampMs < sell.timestampMs) count++;
  const checks = {
    curve: (sell.curveProgress ?? -1) >= t.minCurve,
    amount: sell.solAmount >= t.minTargetSellLamports,
    tradeCount: count >= t.minTrades && count <= t.maxTrades
  };
  return { pass: checks.curve && checks.amount && checks.tradeCount, count, start, checks };
}
export function entryDeviationPct(actualFillPrice: number, entrySignalPrice: number): number {
  return (actualFillPrice / entrySignalPrice - 1) * 100;
}
export function entryMarketCapSol(price: number): number { return price * 1_000_000; }
export function isEntryMarketCapAllowed(price: number, maxMarketCapSol: number): boolean {
  return entryMarketCapSol(price) < maxMarketCapSol;
}

export function createConfirmation(targetSell: PoolTradeEvent, delayMs: number): ReversalConfirmationStats {
  return { buyLamports: 0n, sellLamports: 0n, minPrice: targetSell.price, latestPrice: targetSell.price, startTimestampMs: targetSell.timestampMs, deadlineTimestampMs: targetSell.timestampMs + delayMs };
}
export function updateConfirmation(s: ReversalConfirmationStats, e: PoolTradeEvent): void {
  if (e.timestampMs <= s.startTimestampMs || e.timestampMs > s.deadlineTimestampMs) return;
  if (e.side === "buy") s.buyLamports += e.solAmount; else s.sellLamports += e.solAmount;
  if (e.price < s.minPrice) s.minPrice = e.price;
  s.latestPrice = e.price;
}
export function evaluateConfirmation(s: ReversalConfirmationStats, targetSellPrice: number, t: StrategyThresholds) {
  const total = s.buyLamports + s.sellLamports;
  const buyPressure = total === 0n ? 0 : Number(s.buyLamports * 1_000_000n / total) / 1_000_000;
  const drawdownPct = (s.minPrice / targetSellPrice - 1) * 100;
  const returnPct = (s.latestPrice / targetSellPrice - 1) * 100;
  const epsilon = 1e-10;
  return { pass: buyPressure + epsilon >= t.minBuyPressure && drawdownPct + epsilon >= -t.maxDrawdownPct && returnPct + epsilon >= t.minReturnPct && returnPct <= t.maxReturnPct + epsilon, buyPressure, drawdownPct, returnPct };
}

export function positionPnlPct(mark: number, entry: number): number { return (mark / entry - 1) * 100; }
export function evaluateBundleDump(events: readonly PoolTradeEvent[], signal: PoolTradeEvent, t: ReentryThresholds): BundleDumpStats {
  const startMs = signal.timestampMs - t.dumpWindowMs;
  let buyLamports = 0n;
  let sellLamports = 0n;
  const sellersBySlot = new Map<number, Set<string>>();
  for (const event of events) {
    if (event.timestampMs < startMs || compareEvents(event, signal) >= 0) continue;
    if (event.side === "buy") buyLamports += event.solAmount;
    else {
      sellLamports += event.solAmount;
      if (event.slot < signal.slot) {
        const sellers = sellersBySlot.get(event.slot) ?? new Set<string>();
        sellers.add(event.trader);
        sellersBySlot.set(event.slot, sellers);
      }
    }
  }
  const total = buyLamports + sellLamports;
  const sellPressure = total === 0n ? 0 : Number(sellLamports * 1_000_000n / total) / 1_000_000;
  const maxSameSlotSellers = Math.max(0, ...[...sellersBySlot.values()].map((sellers) => sellers.size));
  return { eligible: t.enabled && sellPressure > t.minSellPressure && sellLamports > t.minSellLamports && maxSameSlotSellers >= t.sameSlotMinSellers, buyLamports, sellLamports, sellPressure, maxSameSlotSellers };
}
export function createReentryConfirmation(trigger: PoolTradeEvent, confirmMs: number): ReentryConfirmationStats {
  return { triggerPrice: trigger.price, deadlineMs: trigger.timestampMs + confirmMs, buyLamports: trigger.solAmount, sellLamports: 0n, buyers: new Set([trigger.trader]), latestPrice: trigger.price, minPrice: trigger.price, lastNewLowMs: trigger.timestampMs };
}
export function updateReentryConfirmation(s: ReentryConfirmationStats, event: PoolTradeEvent): void {
  if (event.timestampMs > s.deadlineMs) return;
  if (event.side === "buy") { s.buyLamports += event.solAmount; s.buyers.add(event.trader); }
  else s.sellLamports += event.solAmount;
  if (event.price < s.minPrice) { s.minPrice = event.price; s.lastNewLowMs = event.timestampMs; }
  s.latestPrice = event.price;
}
export function evaluateReentryConfirmation(s: ReentryConfirmationStats, postExitLowPrice: number, nowMs: number, t: ReentryThresholds) {
  const total = s.buyLamports + s.sellLamports;
  const buyPressure = total === 0n ? 0 : Number(s.buyLamports * 1_000_000n / total) / 1_000_000;
  const recoveryPct = (s.latestPrice / postExitLowPrice - 1) * 100;
  const triggerReturnPct = (s.latestPrice / s.triggerPrice - 1) * 100;
  const stableMs = nowMs - s.lastNewLowMs;
  const epsilon = 1e-10;
  return { pass: buyPressure + epsilon >= t.minBuyPressure && buyPressure <= t.maxBuyPressure + epsilon && s.buyers.size >= t.minDistinctBuyers && recoveryPct + epsilon >= t.minRecoveryPct && stableMs >= t.noNewLowMs && triggerReturnPct <= t.maxTriggerReturnPct + epsilon, buyPressure, distinctBuyers: s.buyers.size, recoveryPct, stableMs, triggerReturnPct };
}
export function shouldArmProfitLock(mark: number, entry: number, t: StrategyThresholds): boolean {
  return t.profitLockEnabled && positionPnlPct(mark, entry) >= t.profitLockActivatePct;
}
export function exitReason(mark: number, entry: number, nowMs: number, entryMs: number, t: StrategyThresholds, profitLockArmed = false): "TSR_PROFIT_LOCK" | "TSR_TP" | "TSR_STOP" | "TSR_MAX_HOLD" | undefined {
  const pnl = positionPnlPct(mark, entry);
  if (t.profitLockEnabled && profitLockArmed && pnl <= t.profitLockFloorPct) return "TSR_PROFIT_LOCK";
  if (pnl >= t.takeProfitPct) return "TSR_TP";
  if (pnl <= t.stopLossPct) return "TSR_STOP";
  if (nowMs - entryMs >= t.maxHoldMs) return "TSR_MAX_HOLD";
}
