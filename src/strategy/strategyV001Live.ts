import type { Keypair } from "@solana/web3.js";
import type { Logger } from "pino";
import type { StrategyV001Config } from "../config/strategyV001.js";
import type { PoolTradeEvent } from "../events/types.js";
import type { TokenState } from "../state/tokenState.js";
import { TokenLifecycleState } from "./state.js";
import type { Strategy, StrategyExecution } from "./types.js";
import { StrategyV001Engine, type StrategyDecision, type StrategyMarketEvent } from "./strategyV001Engine.js";
import { lamportsToSol, slippagePctToBps, solToLamportsNumber, toStrategyPrice } from "./priceUnits.js";

export class StrategyV001Live implements Strategy {
  readonly #engines = new WeakMap<TokenState, StrategyV001Engine>();
  readonly #busy = new WeakSet<TokenState>();
  readonly timerMs: number;

  constructor(
    private readonly cfg: StrategyV001Config,
    private readonly execution: StrategyExecution,
    private readonly wallet: Keypair,
    private readonly targetWallet: string,
    private readonly defaultBuySlippageBps: number,
    private readonly defaultSellSlippageBps: number,
    private readonly canOpenPosition: (state: TokenState) => Promise<boolean>,
    private readonly logger: Logger
  ) {
    this.timerMs = cfg.timer_ms > 0 ? cfg.timer_ms : 200;
  }

  onEvent(state: TokenState, event: PoolTradeEvent): void {
    const engine = this.#engine(state);
    if (!engine) return;
    const market = toMarketEvent(event);
    const holding = isHolding(state);
    if (engine.phaseName === "unbound") {
      const bind = engine.bindGateBuy({
        price: market.price,
        sol: lamportsToSol(state.targetBuy.solAmount),
        tsSec: Math.floor(state.targetBuy.timestampMs / 1000),
        wallet: this.targetWallet,
        gateSig: state.targetBuy.signature,
        nowMs: state.targetBuy.timestampMs
      });
      this.#logDecision(state, bind, "gate");
      if (bind.kind === "skip" || engine.isDone) {
        this.#markClosed(state, bind.kind === "skip" ? bind.detail : "gate done");
        return;
      }
      // Gate buy itself should not drive entry; subsequent pool events / timers do.
      if (event.signature === state.targetBuy.signature && event.eventIndex === state.targetBuy.eventIndex) {
        return;
      }
    }
    const decision = engine.onEvent(market, holding);
    void this.#dispatch(state, engine, decision);
  }

  onClock(state: TokenState, nowMs = Date.now()): void {
    const engine = this.#engine(state);
    if (!engine || engine.isDone) {
      if (engine?.isDone && !isHolding(state)) this.#markClosed(state, "strategy done");
      return;
    }
    if (!engine.timerWantsTicks()) return;
    const mark = toStrategyPrice(state.prices.currentMarkPrice ?? 0) || engine.lastMarkPx;
    const decision = engine.onTimer(mark, nowMs);
    void this.#dispatch(state, engine, decision);
  }

  onBuyFill(state: TokenState, fill: { price: number; slot: number }): void {
    const engine = this.#engines.get(state);
    if (!engine) return;
    engine.onBuyFill(toStrategyPrice(fill.price), Math.floor(Date.now() / 1000), fill.slot);
  }

  onBuyFailed(state: TokenState): void {
    const engine = this.#engines.get(state);
    if (!engine) return;
    engine.onBuyFailed();
    state.resetBuySendClaim();
    if (engine.isDone) this.#markClosed(state, engine.lastSkip || "buy failed");
  }

  onSellFill(state: TokenState): { thenBuy: boolean } {
    const engine = this.#engines.get(state);
    if (!engine) return { thenBuy: false };
    engine.onSellFill();
    const thenBuy = engine.pendingThenBuy();
    if (!thenBuy && engine.isDone) this.#markClosed(state, "position closed");
    return { thenBuy };
  }

  /** Rehydrate an already-open recovered position into HOLDING. */
  restoreOpenPosition(state: TokenState, fillPriceLive: number): void {
    const engine = this.#engine(state);
    if (!engine) return;
    if (engine.phaseName === "unbound") {
      const midClip = (this.cfg.clip_lo + this.cfg.clip_hi) / 2;
      const sol = lamportsToSol(state.targetBuy.solAmount);
      engine.bindGateBuy({
        price: toStrategyPrice(state.targetBuy.price || fillPriceLive),
        sol: sol > 0 ? sol : midClip,
        tsSec: Math.floor((state.targetBuy.timestampMs || Date.now()) / 1000),
        wallet: this.targetWallet,
        gateSig: state.targetBuy.signature,
        nowMs: state.targetBuy.timestampMs || Date.now()
      });
    }
    engine.onBuyFill(toStrategyPrice(fillPriceLive), Math.floor(Date.now() / 1000), 0);
  }

  async onThenBuy(state: TokenState): Promise<void> {
    const engine = this.#engines.get(state);
    if (!engine) return;
    await this.#buy(state, engine, engine.lastBuyReason);
  }

  #engine(state: TokenState): StrategyV001Engine | undefined {
    let engine = this.#engines.get(state);
    if (!engine) {
      engine = new StrategyV001Engine(this.cfg);
      this.#engines.set(state, engine);
    }
    return engine;
  }

  async #dispatch(state: TokenState, engine: StrategyV001Engine, decision: StrategyDecision): Promise<void> {
    this.#logDecision(state, decision, "signal");
    if (decision.kind === "none") return;
    if (decision.kind === "skip") {
      if (engine.isDone && !isHolding(state)) this.#markClosed(state, decision.detail);
      return;
    }
    if (this.#busy.has(state)) return;
    if (decision.kind === "fire_buy") {
      await this.#buy(state, engine, decision.reason);
      return;
    }
    if (decision.kind === "fire_sell") {
      await this.#sell(state, decision.reason);
      return;
    }
    if (decision.kind === "fire_then_buy") {
      await this.#sell(state, decision.sellReason);
    }
  }

  async #buy(state: TokenState, engine: StrategyV001Engine, reason: string): Promise<void> {
    if (this.#busy.has(state) || isHolding(state)) return;
    if (!state.claimBuySend()) return;
    this.#busy.add(state);
    try {
      if (!(await this.canOpenPosition(state))) {
        state.resetBuySendClaim();
        engine.onBuyFailed();
        this.execution.recordEntryEvent(state, "entry_blocked", { reason });
        return;
      }
      const sizeSol = engine.buySizeSol();
      state.buyLamports = solToLamportsNumber(sizeSol);
      state.prices.entrySignalPrice = state.prices.currentMarkPrice || state.targetBuy.price;
      const scalp = Boolean(engine.lastBuyDiag.scalp);
      if (scalp) {
        state.buySlippageBps = slippagePctToBps(this.cfg.rule_2_buy_slippage_pct);
        state.sellSlippageBps = slippagePctToBps(this.cfg.rule_2_sell_slippage_pct);
      } else {
        state.buySlippageBps = this.defaultBuySlippageBps;
        state.sellSlippageBps = this.defaultSellSlippageBps;
      }
      this.logger.info({ mint: state.descriptor.mint, reason, sizeSol, scalp, diag: engine.lastBuyDiag }, "[05 ENTRY] strategy_v_001 buy signal");
      state.preparedBuy = await state.adapter.buildBuy({
        descriptor: state.descriptor,
        owner: this.wallet.publicKey,
        lamports: state.buyLamports,
        slippageBps: state.buySlippageBps
      });
      state.transition(TokenLifecycleState.BUY_PREPARED);
      await this.execution.sendBuy(state, performance.now());
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error), mint: state.descriptor.mint }, "[05 ENTRY] strategy_v_001 buy failed");
      try { state.transition(TokenLifecycleState.FAILED); } catch { /* ignore */ }
      engine.onBuyFailed();
    } finally {
      this.#busy.delete(state);
    }
  }

  async #sell(state: TokenState, reason: string): Promise<void> {
    if (this.#busy.has(state) || !isHolding(state)) return;
    if (!state.claimSellSend()) return;
    this.#busy.add(state);
    try {
      this.logger.info({ mint: state.descriptor.mint, reason }, "[08 EXIT] strategy_v_001 sell signal");
      state.prices.exitSignalPrice = state.prices.currentMarkPrice;
      await this.execution.sendSell(state, reason, performance.now());
    } catch (error) {
      this.logger.error({ err: error instanceof Error ? error.message : String(error), mint: state.descriptor.mint }, "[08 EXIT] strategy_v_001 sell failed");
      state.releaseSellSend();
    } finally {
      this.#busy.delete(state);
    }
  }

  #markClosed(state: TokenState, reason: string): void {
    if (state.lifecycle === TokenLifecycleState.CLOSED || state.lifecycle === TokenLifecycleState.FAILED) return;
    if (isHolding(state) || state.lifecycle === TokenLifecycleState.BUY_PREPARED || state.lifecycle === TokenLifecycleState.BUY_SENT) return;
    try {
      state.transition(TokenLifecycleState.CLOSED);
      this.logger.info({ mint: state.descriptor.mint, reason }, "[CLEANUP] strategy_v_001 finished mint");
    } catch {
      /* ignore invalid transitions while in-flight */
    }
  }

  #logDecision(state: TokenState, decision: StrategyDecision, stage: string): void {
    if (decision.kind === "none") return;
    this.logger.info({ mint: state.descriptor.mint, stage, decision }, "[04 STRAT] strategy_v_001 decision");
  }
}

function isHolding(state: TokenState): boolean {
  return state.lifecycle === TokenLifecycleState.POSITION_ACTIVE_UNCONFIRMED
    || state.lifecycle === TokenLifecycleState.POSITION_ACTIVE_CONFIRMED
    || state.lifecycle === TokenLifecycleState.BUY_CONFIRMED
    || state.lifecycle === TokenLifecycleState.SELL_PREPARED
    || state.lifecycle === TokenLifecycleState.BUY_PROCESSED;
}

function toMarketEvent(event: PoolTradeEvent): StrategyMarketEvent {
  return {
    signature: event.signature,
    slot: event.slot,
    timestampSec: Math.floor(event.timestampMs / 1000),
    timestampMs: event.timestampMs,
    side: event.side === "buy" ? "BUY" : "SELL",
    wallet: event.trader,
    solAmount: lamportsToSol(event.solAmount),
    price: toStrategyPrice(event.price)
  };
}
