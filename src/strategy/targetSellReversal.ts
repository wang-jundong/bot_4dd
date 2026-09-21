import type { Keypair } from "@solana/web3.js";
import type { PoolTradeEvent } from "../events/types.js";
import { createConfirmation, createReentryConfirmation, entryMarketCapSol, evaluateBundleDump, evaluateConfirmation, evaluateReentryConfirmation, exitReason, isEntryMarketCapAllowed, qualifyTargetSell, shouldArmProfitLock, updateConfirmation, updateReentryConfirmation, type StrategyThresholds } from "./calculations.js";
import { TokenLifecycleState } from "./state.js";
import type { TokenState } from "../state/tokenState.js";

export interface StrategyExecution {
  sendBuy(state: TokenState, signalMonoMs: number): Promise<void>;
  sendSell(state: TokenState, reason: string, signalMonoMs: number): Promise<void>;
  recordProfitLockArmed(state: TokenState): void;
  recordReentryEvent(state: TokenState, event: string, extra?: object): void;
  recordEntryEvent(state: TokenState, event: string, extra?: object): void;
}
export class TargetSellReversal {
  constructor(private readonly thresholds: StrategyThresholds, private readonly delayMs: number, private readonly wallet: Keypair, private readonly getBuyLamports: () => bigint, private readonly buySlippageBps: number, private readonly maxEntryMarketCapSol: number, private readonly execution: StrategyExecution, private readonly canReenter: (state: TokenState) => Promise<boolean> = async () => true) {}
  onEvent(state: TokenState, event: PoolTradeEvent): void {
    if (!state.events.add(event)) return;
    state.prices.currentMarkPrice = event.price;
    if (state.lifecycle === TokenLifecycleState.REENTRY_WAITING) { this.#onReentryEvent(state, event); return; }
    if (state.confirmation) updateConfirmation(state.confirmation, event);
    if ((state.lifecycle === TokenLifecycleState.POSITION_ACTIVE_UNCONFIRMED || state.lifecycle === TokenLifecycleState.POSITION_ACTIVE_CONFIRMED || state.lifecycle === TokenLifecycleState.SELL_PREPARED) && state.prices.actualEntryFillPrice && state.entryProcessedMs) {
      const reason = this.#exitReason(state, event.price, event.timestampMs);
      if (reason && state.claimSellSend()) { this.#freezeReentryEligibility(state, event); state.prices.exitSignalPrice = event.price; void this.execution.sendSell(state, reason, performance.now()); }
    }
  }
  onClock(state: TokenState, nowMs = Date.now()): void {
    if (state.lifecycle === TokenLifecycleState.REENTRY_WAITING) { this.#onReentryClock(state, nowMs); return; }
    if ((state.lifecycle !== TokenLifecycleState.POSITION_ACTIVE_UNCONFIRMED && state.lifecycle !== TokenLifecycleState.POSITION_ACTIVE_CONFIRMED) || !state.prices.actualEntryFillPrice || !state.prices.currentMarkPrice || !state.entryProcessedMs) return;
    const reason = this.#exitReason(state, state.prices.currentMarkPrice, nowMs);
    if (reason && state.claimSellSend()) { state.reentryEligible = false; state.prices.exitSignalPrice = state.prices.currentMarkPrice; void this.execution.sendSell(state, reason, performance.now()); }
  }
  onTargetSell(state: TokenState, sell: PoolTradeEvent): boolean {
    if (state.lifecycle !== TokenLifecycleState.TRACKING_POOL || !state.events.add(sell)) return false;
    const q = qualifyTargetSell(state.events.values(), state.targetBuy.timestampMs, sell, this.thresholds);
    if (!q.pass) return false;
    state.targetSell = sell; state.prices.targetSellPrice = sell.price; state.transition(TokenLifecycleState.TARGET_SELL_DETECTED);
    state.confirmation = createConfirmation(sell, this.delayMs); state.transition(TokenLifecycleState.CONFIRMING_REVERSAL);
    return true;
  }
  onDeadlineEvent(state: TokenState, event: PoolTradeEvent): boolean {
    if (!state.confirmation || event.timestampMs < state.confirmation.deadlineTimestampMs) return false;
    return this.onDeadline(state, event.price);
  }
  onDeadline(state: TokenState, signalPrice = state.confirmation?.latestPrice): boolean {
    if (!state.confirmation || signalPrice === undefined) return false;
    if (state.lifecycle !== TokenLifecycleState.CONFIRMING_REVERSAL && state.lifecycle !== TokenLifecycleState.BUY_PREPARED) return false;
    const result = evaluateConfirmation(state.confirmation, state.prices.targetSellPrice!, this.thresholds);
    state.prices.confirmationFinalPrice = state.confirmation.latestPrice; state.prices.entrySignalPrice = signalPrice;
    if (!result.pass) { state.transition(TokenLifecycleState.TRACKING_POOL); return false; }
    const marketCapSol = entryMarketCapSol(signalPrice);
    if (!isEntryMarketCapAllowed(signalPrice, this.maxEntryMarketCapSol)) {
      this.execution.recordEntryEvent(state, "entry_market_cap_rejected", { positionType: "normal", currentPrice: signalPrice, marketCapSol, maxMarketCapSol: this.maxEntryMarketCapSol });
      state.transition(TokenLifecycleState.TRACKING_POOL);
      return false;
    }
    if (!state.claimBuySend()) return false;
    state.buyLamports = this.getBuyLamports();
    void state.adapter.buildBuy({ descriptor: state.descriptor, owner: this.wallet.publicKey, lamports: state.buyLamports, slippageBps: this.buySlippageBps })
      .then(tx => { state.preparedBuy = tx; state.transition(TokenLifecycleState.BUY_PREPARED); return this.execution.sendBuy(state, performance.now()); })
      .catch(() => state.transition(TokenLifecycleState.FAILED));
    return true;
  }
  #freezeReentryEligibility(state: TokenState, signal: PoolTradeEvent): void {
    if (state.isReentryPosition || state.reentryUsed) { state.reentryEligible = false; return; }
    state.bundleDump = evaluateBundleDump(state.events.values(), signal, this.thresholds.reentry);
    state.reentryEligible = state.bundleDump.eligible; state.reentryWaitDurationMs = this.thresholds.reentry.waitMs;
    this.execution.recordReentryEvent(state, "reentry_dump_evaluated", state.bundleDump);
  }
  #onReentryEvent(state: TokenState, event: PoolTradeEvent): void {
    if (state.postExitLowPrice === undefined || event.price < state.postExitLowPrice) state.postExitLowPrice = event.price;
    if (state.reentryConfirmation) {
      updateReentryConfirmation(state.reentryConfirmation, event);
      return;
    }
    if (event.side === "buy" && event.trader !== this.wallet.publicKey.toBase58() && event.solAmount > this.thresholds.reentry.triggerBuyLamports) {
      state.reentryConfirmation = createReentryConfirmation(event, this.thresholds.reentry.confirmMs);
      this.execution.recordReentryEvent(state, "reentry_candidate_started", { signature: event.signature, triggerSolLamports: event.solAmount, triggerPrice: event.price });
    }
  }
  #onReentryClock(state: TokenState, nowMs: number): void {
    if ((state.reentryWaitDeadlineMs ?? 0) <= nowMs) {
      state.transition(TokenLifecycleState.CLOSED);
      this.execution.recordReentryEvent(state, "reentry_wait_expired");
      return;
    }
    const confirmation = state.reentryConfirmation;
    if (!confirmation || confirmation.deadlineMs > nowMs || state.reentryEvaluationPending) return;
    state.reentryConfirmation = undefined;
    const result = evaluateReentryConfirmation(confirmation, state.postExitLowPrice ?? confirmation.minPrice, nowMs, this.thresholds.reentry);
    this.execution.recordReentryEvent(state, "reentry_candidate_evaluated", result);
    if (!result.pass) return;
    state.reentryEvaluationPending = true;
    void this.canReenter(state).then(async allowed => {
      state.reentryEvaluationPending = false;
      if (!allowed || state.lifecycle !== TokenLifecycleState.REENTRY_WAITING) return;
      state.prices.currentMarkPrice = confirmation.latestPrice;
      const marketCapSol = entryMarketCapSol(confirmation.latestPrice);
      if (!isEntryMarketCapAllowed(confirmation.latestPrice, this.maxEntryMarketCapSol)) {
        this.execution.recordEntryEvent(state, "reentry_market_cap_rejected", { positionType: "reentry", currentPrice: confirmation.latestPrice, marketCapSol, maxMarketCapSol: this.maxEntryMarketCapSol });
        return;
      }
      if (!state.claimBuySend()) return;
      state.isReentryPosition = true;
      state.prices.entrySignalPrice = confirmation.latestPrice;
      try {
        state.buyLamports = this.getBuyLamports();
        state.preparedBuy = await state.adapter.buildBuy({ descriptor: state.descriptor, owner: this.wallet.publicKey, lamports: state.buyLamports, slippageBps: this.buySlippageBps });
        state.transition(TokenLifecycleState.BUY_PREPARED);
        await this.execution.sendBuy(state, performance.now());
      } catch {
        state.transition(TokenLifecycleState.FAILED);
      }
    }).catch(() => { state.reentryEvaluationPending = false; });
  }
  #exitReason(state: TokenState, mark: number, nowMs: number) {
    const entry = state.prices.actualEntryFillPrice!;
    const thresholds = state.isReentryPosition ? { ...this.thresholds, profitLockEnabled: false, takeProfitPct: this.thresholds.reentry.takeProfitPct, stopLossPct: this.thresholds.reentry.stopLossPct, maxHoldMs: this.thresholds.reentry.maxHoldMs } : this.thresholds;
    if (!state.profitLockArmed && shouldArmProfitLock(mark, entry, thresholds)) {
      state.profitLockArmed = true;
      this.execution.recordProfitLockArmed(state);
    }
    return exitReason(mark, entry, nowMs, state.entryProcessedMs!, thresholds, state.profitLockArmed);
  }
}
