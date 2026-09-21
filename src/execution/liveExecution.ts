import type { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import type { Logger } from "pino";
import type { StrategyExecution } from "../strategy/targetSellReversal.js";
import { entryDeviationPct, entryMarketCapSol, isEntryMarketCapAllowed } from "../strategy/calculations.js";
import { TokenLifecycleState } from "../strategy/state.js";
import type { TokenState } from "../state/tokenState.js";
import type { BlockhashManager } from "./blockhashManager.js";
import { ConfirmationTimeoutError, type ConfirmationTracker } from "./confirmationTracker.js";
import type { HeliusSender, SenderTiming } from "../helius/sender.js";
import type { RecoveryJournal } from "../recovery/journal.js";
import { isNonRetryableBuyError, retryEntryDeviationPct } from "./buyRetryPolicy.js";
import type { LossStreakPositionSizer } from "./positionSizer.js";
import type { PnlJournal } from "../pnl/pnlJournal.js";

export class LiveStrategyExecution implements StrategyExecution {
  constructor(
    private readonly connection: Connection, private readonly wallet: Keypair,
    private readonly buyLamports: bigint, private readonly buySlippageBps: number, private readonly sellSlippageBps: number, private readonly maxEntryDeviationPct: number, private readonly maxEntryMarketCapSol: number,
    private readonly blockhashes: BlockhashManager, private readonly sender: HeliusSender,
    private readonly confirmations: ConfirmationTracker, private readonly journal: RecoveryJournal, private readonly positionSizer: LossStreakPositionSizer, private readonly pnlJournal: PnlJournal,
    private readonly logger: Logger
  ) {}

  recordProfitLockArmed(state: TokenState): void {
    this.#record(state, "profit_lock_armed", { profitLockArmed: true });
  }

  recordReentryEvent(state: TokenState, event: string, extra: object = {}): void {
    this.#record(state, event, extra);
  }

  recordEntryEvent(state: TokenState, event: string, extra: object = {}): void {
    this.#record(state, event, extra);
  }

  async sendBuy(state: TokenState, signalMonoMs: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (attempt > 1 && state.prices.currentMarkPrice) {
          const currentPrice = state.prices.currentMarkPrice;
          const marketCapSol = entryMarketCapSol(currentPrice);
          if (!isEntryMarketCapAllowed(currentPrice, this.maxEntryMarketCapSol)) {
            const error = new Error(`buy retry aborted: market cap ${marketCapSol.toFixed(4)} SOL is at or above ${this.maxEntryMarketCapSol} SOL`);
            this.logger.warn({ attempt, mint: state.descriptor.mint, currentPrice, marketCapSol, maxMarketCapSol: this.maxEntryMarketCapSol }, "[05 ENTRY] Buy retry blocked by market-cap limit");
            this.#fail(state, "buy_market_cap_rejected", error);
            return;
          }
        }
        if (attempt > 1 && state.prices.entrySignalPrice && state.prices.currentMarkPrice) {
          const retryDeviationPct = retryEntryDeviationPct(state.prices.entrySignalPrice, state.prices.currentMarkPrice);
          state.prices.expectedEntryPrice = state.prices.currentMarkPrice;
          if (retryDeviationPct > this.maxEntryDeviationPct) {
            const error = new Error(`buy retry aborted: latest price deviation ${retryDeviationPct.toFixed(4)}% exceeds ${this.maxEntryDeviationPct}%`);
            this.logger.warn({ attempt, mint: state.descriptor.mint, entrySignalPrice: state.prices.entrySignalPrice, latestPrice: state.prices.currentMarkPrice, retryDeviationPct, maxDeviationPct: this.maxEntryDeviationPct }, "[05 ENTRY] Buy retry blocked by entry deviation limit");
            this.#fail(state, "buy_retry_aborted", error);
            return;
          }
        }
        if (attempt > 1 || !state.preparedBuy) {
          state.preparedBuy = await state.adapter.buildBuy({ descriptor: state.descriptor, owner: this.wallet.publicKey, lamports: state.buyLamports ?? this.buyLamports, slippageBps: this.buySlippageBps });
        }
        const transaction = state.preparedBuy.compile((await this.blockhashes.get()).blockhash);
        transaction.sign([this.wallet]);
        const submitted = await this.#submit(transaction, signalMonoMs);
        state.buySignature = submitted.signature;
        this.#record(state, "buy_sent", { attempt, signature: submitted.signature, timing: submitted.timing });
        const fill = await this.#confirm(submitted.signature, state);
        if (!fill.success || fill.tokenAmount <= 0n) throw new Error("buy fill could not be determined");
        state.transition(TokenLifecycleState.BUY_SENT);
        state.actualTokenAmount = fill.tokenAmount;
        state.actualEntrySolAmount = fill.solAmount;
        state.prices.actualEntryFillPrice = fill.price;
        if (state.prices.entrySignalPrice) state.prices.actualEntryDeviationPct = entryDeviationPct(fill.price, state.prices.entrySignalPrice);
        state.entryProcessedMs = Date.now();
        state.transition(TokenLifecycleState.BUY_PROCESSED);
        state.transition(TokenLifecycleState.POSITION_ACTIVE_UNCONFIRMED);
        this.#record(state, "buy_processed", { fill });
        state.transition(TokenLifecycleState.BUY_CONFIRMED);
        state.transition(TokenLifecycleState.POSITION_ACTIVE_CONFIRMED);
        this.#record(state, "buy_confirmed");
        if ((state.prices.actualEntryDeviationPct ?? 0) > this.maxEntryDeviationPct && state.claimSellSend()) {
          this.logger.error({ mint: state.descriptor.mint, entrySignalPrice: state.prices.entrySignalPrice, actualEntryFillPrice: fill.price, deviationPct: state.prices.actualEntryDeviationPct, maxDeviationPct: this.maxEntryDeviationPct }, "[07 POSITION] Entry deviation limit exceeded; exiting position");
          await this.sendSell(state, "ENTRY_DEVIATION", performance.now());
        }
        return;
      } catch (error) {
        lastError = error;
        this.logger.warn({ attempt, err: error instanceof Error ? error.message : String(error), mint: state.descriptor.mint }, "[05 ENTRY] Buy attempt failed");
        if (isNonRetryableBuyError(error, state.descriptor.venue)) {
          this.logger.warn({ attempt, mint: state.descriptor.mint, venue: state.descriptor.venue }, "[05 ENTRY] Buy retry blocked after slippage failure");
          this.#fail(state, "buy_slippage_rejected", error);
          return;
        }
      }
    }
    this.#fail(state, "buy_failed", lastError);
  }

  async sendSell(state: TokenState, reason: string, signalMonoMs: number): Promise<void> {
    if (!state.actualTokenAmount) { this.#sellFailed(state, reason, new Error("position token amount is unknown")); return; }
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        state.preparedSell = await state.adapter.buildSell({ descriptor: state.descriptor, owner: this.wallet.publicKey, tokenAmount: state.actualTokenAmount, slippageBps: this.sellSlippageBps });
        if (state.lifecycle !== TokenLifecycleState.SELL_PREPARED) state.transition(TokenLifecycleState.SELL_PREPARED);
        const transaction = state.preparedSell.compile((await this.blockhashes.get()).blockhash);
        transaction.sign([this.wallet]);
        const submitted = await this.#submit(transaction, signalMonoMs);
        state.sellSignature = submitted.signature;
        this.#record(state, "sell_sent", { attempt, reason, signature: submitted.signature, timing: submitted.timing });
        const fill = await this.#confirm(submitted.signature, state);
        if (!fill.success) throw new Error("sell fill could not be determined");
        state.transition(TokenLifecycleState.SELL_SENT);
        state.prices.actualExitFillPrice = fill.price;
        this.#record(state, "position_closed", { reason, fill });
        this.positionSizer.recordClosedPosition(state.prices.actualEntryFillPrice, fill.price);
        this.logger.info({ mint: state.descriptor.mint, won: fill.price > (state.prices.actualEntryFillPrice ?? fill.price), lossStreak: this.positionSizer.lossStreak, reducedSizing: this.positionSizer.reduced, nextBuyLamports: this.positionSizer.currentBuyLamports() }, "[RISK] Closed position updated loss-streak sizing");
        const closedAtMs = Date.now();
        if (state.actualEntrySolAmount && state.prices.actualEntryFillPrice && state.entryProcessedMs) {
          try {
            await this.pnlJournal.record({ closedAtMs, descriptor: state.descriptor, isReentryPosition: state.isReentryPosition, buyLamports: state.actualEntrySolAmount, sellLamports: fill.solAmount, tokenAmount: fill.tokenAmount, entryPrice: state.prices.actualEntryFillPrice, exitPrice: fill.price, prices: state.prices, exitReason: reason, buySignature: state.buySignature, sellSignature: state.sellSignature, entryProcessedMs: state.entryProcessedMs, profitLockArmed: state.profitLockArmed, lossStreakAfterClose: this.positionSizer.lossStreak });
            this.logger.info({ mint: state.descriptor.mint, pnlLamports: fill.solAmount - state.actualEntrySolAmount }, "[PNL] Closed trade appended");
          } catch (error) {
            this.logger.error({ err: error instanceof Error ? error.message : String(error), mint: state.descriptor.mint }, "[PNL] Failed to append closed trade");
          }
        } else this.logger.error({ mint: state.descriptor.mint }, "[PNL] Exact PNL unavailable: confirmed BUY fill amount is missing");
        if (!state.isReentryPosition && state.reentryEligible) {
          state.beginReentryWait(Date.now(), fill.price, state.reentryWaitDurationMs);
          this.#record(state, "reentry_waiting", { reentryWaitDeadlineMs: state.reentryWaitDeadlineMs, postExitLowPrice: state.postExitLowPrice });
        } else state.transition(TokenLifecycleState.CLOSED);
        return;
      } catch (error) {
        lastError = error;
        state.preparedSell = undefined;
        this.logger.warn({ attempt, err: error instanceof Error ? error.message : String(error), mint: state.descriptor.mint }, "[08 EXIT] Sell attempt failed");
      }
    }
    this.#sellFailed(state, reason, lastError);
  }

  async #confirm(signature: string, state: TokenState) {
    for (let poll = 1; poll <= 3; poll++) {
      try { return await this.confirmations.waitProcessed(signature, state.adapter, this.wallet.publicKey, state.descriptor.mint); }
      catch (error) { if (!(error instanceof ConfirmationTimeoutError) || poll === 3) throw error; this.logger.warn({ poll, signature }, "[06 CONFIRM] Transaction pending; polling same signature"); }
    }
    throw new ConfirmationTimeoutError(`confirmation timed out for ${signature}`);
  }

  async #submit(transaction: VersionedTransaction, signalMonoMs: number): Promise<{ signature: string; timing: SenderTiming }> {
    const serialized = transaction.serialize();
    const base64 = Buffer.from(serialized).toString("base64");
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try { return await this.sender.send(base64, signalMonoMs); }
      catch (error) {
        lastError = error;
        this.logger.warn({ attempt, err: error instanceof Error ? error.message : String(error) }, "[06 CONFIRM] Helius submission attempt failed");
      }
    }
    const sendStartMonoMs = performance.now();
    try {
      const signature = await this.connection.sendRawTransaction(serialized, { skipPreflight: false, maxRetries: 2 });
      return { signature, timing: { signalMonoMs, sendStartMonoMs, responseMonoMs: performance.now() } };
    } catch (fallbackError) {
      throw new AggregateError([lastError, fallbackError], "Sender and RPC fallback both failed");
    }
  }

  #record(state: TokenState, event: string, extra: object = {}): void {
    const value = {
      event, descriptor: state.descriptor, lifecycle: state.lifecycle, actualTokenAmount: state.actualTokenAmount, actualEntrySolAmount: state.actualEntrySolAmount, buyLamports: state.buyLamports, buySignature: state.buySignature, sellSignature: state.sellSignature,
      prices: state.prices, entryProcessedMs: state.entryProcessedMs, profitLockArmed: state.profitLockArmed, isReentryPosition: state.isReentryPosition, reentryEligible: state.reentryEligible, reentryWaitDeadlineMs: state.reentryWaitDeadlineMs, postExitLowPrice: state.postExitLowPrice, ...extra
    };
    this.journal.record(value);
    const messages: Record<string, string> = {
      entry_market_cap_rejected: "[05 ENTRY] Normal buy rejected by market-cap limit",
      reentry_market_cap_rejected: "[05 ENTRY] Re-entry buy rejected by market-cap limit",
      buy_market_cap_rejected: "[05 ENTRY] Buy retry rejected by market-cap limit",
      buy_sent: "[05 ENTRY] Buy transaction submitted",
      buy_processed: "[06 CONFIRM] Buy processed; fill calculated",
      buy_confirmed: "[07 POSITION] Buy confirmed; position active",
      profit_lock_armed: "[07 POSITION] Profit lock armed",
      sell_sent: "[08 EXIT] Sell transaction submitted",
      position_closed: "[08 EXIT] Sell confirmed; position closed",
      reentry_dump_evaluated: "[REENTRY] Exit dump window evaluated",
      reentry_waiting: "[REENTRY] Original position closed; waiting for rebound",
      reentry_candidate_started: "[REENTRY] Trigger buy detected; confirming rebound",
      reentry_candidate_evaluated: "[REENTRY] Rebound candidate evaluated",
      reentry_wait_expired: "[REENTRY] Re-entry window expired"
    };
    this.logger.info(value, messages[event] ?? `[WORKFLOW] `);
  }

  #sellFailed(state: TokenState, reason: string, error: unknown): void {
    try { if (state.lifecycle === TokenLifecycleState.SELL_PREPARED) state.transition(TokenLifecycleState.POSITION_ACTIVE_CONFIRMED); } catch {}
    state.releaseSellSend();
    state.preparedSell = undefined;
    const err = error instanceof Error ? error.message : String(error);
    this.journal.record({ event: "sell_retry_exhausted", descriptor: state.descriptor, lifecycle: state.lifecycle, actualTokenAmount: state.actualTokenAmount, actualEntrySolAmount: state.actualEntrySolAmount, prices: state.prices, entryProcessedMs: state.entryProcessedMs, profitLockArmed: state.profitLockArmed, reason, error: err });
    this.logger.error({ err, reason, mint: state.descriptor.mint }, "[08 EXIT] Sell retries exhausted; position still monitored");
  }

  #fail(state: TokenState, event: string, error: unknown): void {
    try { state.transition(TokenLifecycleState.FAILED); } catch {}
    const err = error instanceof Error ? error.message : String(error);
    this.journal.record({ event, descriptor: state.descriptor, lifecycle: state.lifecycle, error: err });
    this.logger.error({ err, mint: state.descriptor.mint, pool: state.descriptor.pool }, `[ERROR] `);
  }
}
