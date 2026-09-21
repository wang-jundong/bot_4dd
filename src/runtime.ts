import type { Logger } from "pino";
import { PublicKey, type Connection } from "@solana/web3.js";
import type { AppConfig } from "./config/index.js";
import { strategyThresholds } from "./config/strategy.js";
import type { Subscription, VibeClient } from "./grpc/vibeClient.js";
import { qualifyTargetSell } from "./strategy/calculations.js";
import { TargetSellReversal } from "./strategy/targetSellReversal.js";
import { canQualifyTargetSell, TokenLifecycleState } from "./strategy/state.js";
import { shouldTradeTargetBuy } from "./strategy/venuePolicy.js";
import { poolKey, TokenStateManager } from "./state/tokenStateManager.js";
import type { VenueAdapter } from "./venues/types.js";
import { PumpTradeDecoder } from "./venues/tradeDecoder.js";
import type { LiveStrategyExecution } from "./execution/liveExecution.js";
import type { RecoveryJournal } from "./recovery/journal.js";
import type { LossStreakPositionSizer } from "./execution/positionSizer.js";

export class TradingRuntime {
  readonly #states: TokenStateManager;
  readonly #strategy: TargetSellReversal;
  readonly #adapters: ReadonlyMap<string, VenueAdapter>;
  readonly #subscriptions = new Map<string, Subscription>();
  readonly #timers = new Set<NodeJS.Timeout>();
  #queue: Promise<void> = Promise.resolve();
  #positionTimer?: NodeJS.Timeout;
  #healthTimer?: NodeJS.Timeout;
  #receivedTransactions = 0;
  #decodedEvents = 0;

  constructor(
    private readonly config: AppConfig, private readonly connection: Connection, private readonly vibe: VibeClient, private readonly journal: RecoveryJournal,
    private readonly decoder: PumpTradeDecoder, adapters: readonly VenueAdapter[],
    execution: LiveStrategyExecution, private readonly positionSizer: LossStreakPositionSizer, private readonly logger: Logger
  ) {
    this.#states = new TokenStateManager(config.EVENT_RETENTION_SEC * 1000);
    this.#strategy = new TargetSellReversal(strategyThresholds(config), config.TSR_ENTRY_DELAY_SEC * 1000, config.keypair, () => positionSizer.currentBuyLamports(), config.BUY_SLIPPAGE_BPS, config.TSR_MAX_ENTRY_MARKET_CAP_SOL, execution, state => this.#canOpenPosition(state));
    this.#adapters = new Map(adapters.map(adapter => [adapter.name, adapter]));
  }

  async start(): Promise<void> {
    this.positionSizer.restore(await this.journal.read());
    this.logger.info({ lossStreak: this.positionSizer.lossStreak, reducedSizing: this.positionSizer.reduced, nextBuyLamports: this.positionSizer.currentBuyLamports() }, "[RISK] Loss-streak sizing restored");
    this.logger.info("[02 STREAM] Connecting to Vibe gRPC");
    await this.vibe.connect();
    this.logger.info("[02 STREAM] Vibe client initialized");
    await this.#recoverPositions();
    this.logger.info({ targetWallet: this.config.TARGET_WALLET }, "[02 STREAM] Opening target-wallet subscription");
    const wallet = await this.vibe.subscribeWallet(this.config.TARGET_WALLET, tx => this.#enqueue(tx));
    this.#subscriptions.set("wallet", wallet);
    this.logger.info({ targetWallet: this.config.TARGET_WALLET }, "[02 STREAM] Target-wallet subscription active");
    this.#positionTimer = setInterval(() => {
      this.#queue = this.#queue.then(async () => {
        for (const state of [...this.#states.values()]) {
          if (state.lifecycle === TokenLifecycleState.CLOSED) {
            await this.#stopTrackingPool(state, "position closed");
            continue;
          }
          this.#strategy.onClock(state);
        }
      }).catch(error => this.logger.error({ err: error instanceof Error ? error.message : String(error) }, "[ERROR] Position maintenance failed"));
    }, 1_000);
    this.#healthTimer = setInterval(() => {
      const states = [...this.#states.values()];
      this.logger.info({
        receivedTransactions: this.#receivedTransactions,
        decodedEvents: this.#decodedEvents,
        subscriptions: this.#subscriptions.size,
        trackedTokens: states.length,
        lifecycles: states.reduce<Record<string, number>>((counts, state) => { counts[state.lifecycle] = (counts[state.lifecycle] ?? 0) + 1; return counts; }, {})
      }, "[HEALTH] Bot is running");
    }, 30_000);
    this.logger.info({ targetWallet: this.config.TARGET_WALLET }, "[01 STARTUP] Trading runtime started");
  }

  #enqueue(tx: Parameters<PumpTradeDecoder["decode"]>[0]): void {
    this.#receivedTransactions++;
    this.logger.debug({ signature: tx.signature, slot: tx.slot, accountCount: tx.accountKeys.length, programCount: tx.programIds.length }, "[02 STREAM] Transaction received");
    this.#queue = this.#queue.then(() => this.#handle(tx)).catch(error => {
      this.logger.error({ err: error instanceof Error ? error.message : String(error), signature: tx.signature }, "[ERROR] Transaction processing failed");
    });
  }

  async #handle(tx: Parameters<PumpTradeDecoder["decode"]>[0]): Promise<void> {
    const decoded = await this.decoder.decode(tx);
    this.#decodedEvents += decoded.length;
    this.logger.debug({ signature: tx.signature, decodedEvents: decoded.length }, decoded.length ? "[03 DETECT] Pump trade decoded" : "[03 DETECT] Ignored non-Pump transaction");
    for (const parsed of decoded) {
      const { descriptor, event } = parsed;
      this.logger.debug({ signature: event.signature, mint: event.mint, pool: event.pool, venue: descriptor.venue, trader: event.trader, side: event.side, solAmount: event.solAmount, tokenAmount: event.tokenAmount, price: event.price, curveProgress: event.curveProgress }, "[03 DETECT] Trade details");
      const adapter = this.#adapters.get(descriptor.venue);
      if (!adapter) continue;
      let state = this.#states.get(descriptor);
      if (!state && event.trader === this.config.TARGET_WALLET && event.side === "buy") {
        if (!shouldTradeTargetBuy(descriptor.venue)) {
          this.logger.info({ mint: descriptor.mint, pool: descriptor.pool, venue: descriptor.venue, signature: event.signature }, "[03 DETECT] Target bought token on excluded venue; trade ignored");
          continue;
        }
        state = this.#states.create(descriptor, adapter, event);
        state.transition(TokenLifecycleState.TRACKING_POOL);
        await this.#subscribePool(descriptor);
        this.logger.info({ mint: descriptor.mint, pool: descriptor.pool, venue: descriptor.venue, signature: event.signature }, "[03 DETECT] Target bought token; now tracking pool");
        continue;
      }
      if (!state) continue;
      if (event.trader === this.config.TARGET_WALLET && event.side === "sell") {
        if (!state.recordTargetTrade(event)) continue;
        if (!canQualifyTargetSell(state.lifecycle)) {
          this.#strategy.onEvent(state, event);
          continue;
        }
        if (!(await this.#canOpenPosition(state))) {
          if (state.targetObservedTokenAmount === 0n) await this.#stopTrackingPool(state, "target fully exited after blocked sell");
          continue;
        }
        const qualification = qualifyTargetSell(state.events.values(), state.targetBuy.timestampMs, event, strategyThresholds(this.config));
        const qualified = this.#strategy.onTargetSell(state, event);
        this.logger.debug({ mint: descriptor.mint, pool: descriptor.pool, signature: event.signature, solAmount: event.solAmount, curveProgress: event.curveProgress, preSellTrades: qualification.count, requiredCurve: this.config.TSR_MIN_TARGET_SELL_CURVE, requiredSolAmount: strategyThresholds(this.config).minTargetSellLamports, requiredTradeRange: [this.config.TSR_MIN_PRE_SELL_TRADES, this.config.TSR_MAX_PRE_SELL_TRADES], checks: qualification.checks, qualified }, qualified ? "[04 QUALIFY] Target sell passed entry rules" : "[04 QUALIFY] Target sell rejected by entry rules");
        if (qualified) {
          this.logger.info({ mint: descriptor.mint, pool: descriptor.pool, signature: event.signature }, "[04 QUALIFY] Starting reversal confirmation window");
          const timer = setTimeout(() => {
            this.#timers.delete(timer);
            this.#queue = this.#queue.then(async () => {
              const sent = this.#strategy.onDeadline(state!);
              this.logger.info({ mint: descriptor.mint, pool: descriptor.pool, sent }, "[05 ENTRY] Reversal window evaluated");
              if (!sent && state!.targetObservedTokenAmount === 0n) await this.#stopTrackingPool(state!, "target fully exited after failed reversal confirmation");
            }).catch(error => this.logger.error({ err: error instanceof Error ? error.message : String(error), mint: descriptor.mint }, "[ERROR] Reversal deadline processing failed"));
          }, this.config.TSR_ENTRY_DELAY_SEC * 1000);
          this.#timers.add(timer);
        } else if (state.targetObservedTokenAmount === 0n) await this.#stopTrackingPool(state, "target fully exited after rejected sell");
      } else {
        if (event.trader === this.config.TARGET_WALLET && event.side === "buy") state.recordTargetTrade(event);
        this.#strategy.onEvent(state, event);
      }
    }
  }

  async #recoverPositions(): Promise<void> {
    const latest = new Map<string, import("./recovery/journal.js").JournalRecord>();
    const lastBuyFillLamports = new Map<string, string>();
    const lastBuySignature = new Map<string, string>();
    for (const record of await this.journal.read()) {
      if (!record.descriptor) continue;
      const key = poolKey(record.descriptor);
      latest.set(key, record);
      if (record.event === "position_closed") {
        lastBuyFillLamports.delete(key);
        lastBuySignature.delete(key);
      } else {
        if (record.event === "buy_processed" && record.fill?.solAmount) lastBuyFillLamports.set(key, record.fill.solAmount);
        if (record.event === "buy_sent" && record.signature) lastBuySignature.set(key, record.signature);
      }
    }
    for (const record of latest.values()) {
      const descriptor = record.descriptor;
      if (!descriptor || record.lifecycle === TokenLifecycleState.CLOSED || record.lifecycle === TokenLifecycleState.FAILED) continue;
      const adapter = this.#adapters.get(descriptor.venue);
      if (!adapter) continue;
      if (record.lifecycle === TokenLifecycleState.REENTRY_WAITING) {
        const deadlineMs = record.reentryWaitDeadlineMs ?? 0;
        const lowPrice = record.postExitLowPrice ?? record.prices?.currentMarkPrice ?? 0;
        if (deadlineMs <= Date.now() || lowPrice <= 0) continue;
        const seedEvent = { signature: "reentry-recovered", slot: 0, eventIndex: 0, timestampMs: Date.now(), receivedMonoMs: performance.now(), mint: descriptor.mint, pool: descriptor.pool, programId: descriptor.programId, trader: this.config.TARGET_WALLET, side: "buy" as const, solAmount: 0n, tokenAmount: 0n, price: lowPrice, curveProgress: descriptor.venue === "pumpswap" ? 1 : undefined };
        const state = this.#states.create(descriptor, adapter, seedEvent);
        state.restoreReentryWaiting(deadlineMs, lowPrice);
        await this.#subscribePool(descriptor);
        this.logger.warn({ mint: descriptor.mint, pool: descriptor.pool, deadlineMs }, "[REENTRY] Recovered re-entry waiting window");
        continue;
      }
      let recordedAmount = record.actualTokenAmount ? BigInt(record.actualTokenAmount) : 0n;
      let entryPrice = record.prices?.actualEntryFillPrice ?? 0;
      if (recordedAmount === 0n && record.signature) {
        const tx = await this.connection.getTransaction(record.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
        if (tx && !tx.meta?.err) { const fill = adapter.parseFill(tx, this.config.keypair.publicKey, descriptor.mint); recordedAmount = fill.tokenAmount; entryPrice = fill.price; }
      }
      const accounts = await this.connection.getParsedTokenAccountsByOwner(this.config.keypair.publicKey, { mint: new PublicKey(descriptor.mint) }, "confirmed");
      const walletAmount = accounts.value.reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount as string), 0n);
      const tokenAmount = recordedAmount === 0n ? walletAmount : recordedAmount < walletAmount ? recordedAmount : walletAmount;
      if (tokenAmount <= 0n || entryPrice <= 0) continue;
      const now = Date.now();
      const seedEvent = { signature: record.signature ?? "recovered", slot: 0, eventIndex: 0, timestampMs: record.entryProcessedMs ?? now, receivedMonoMs: performance.now(), mint: descriptor.mint, pool: descriptor.pool, programId: descriptor.programId, trader: this.config.TARGET_WALLET, side: "buy" as const, solAmount: 0n, tokenAmount, price: entryPrice, curveProgress: descriptor.venue === "pumpswap" ? 1 : undefined };
      const state = this.#states.create(descriptor, adapter, seedEvent);
      state.restorePosition(tokenAmount, entryPrice, record.prices?.currentMarkPrice ?? entryPrice, record.entryProcessedMs ?? now, record.profitLockArmed ?? false, record.isReentryPosition ?? false);
      state.buyLamports = record.buyLamports ? BigInt(record.buyLamports) : this.config.buyAmountLamports;
      const key = poolKey(descriptor);
      const recoveredEntrySolAmount = record.actualEntrySolAmount ?? lastBuyFillLamports.get(key);
      state.actualEntrySolAmount = recoveredEntrySolAmount ? BigInt(recoveredEntrySolAmount) : undefined;
      state.buySignature = record.buySignature ?? lastBuySignature.get(key) ?? record.signature;
      await this.#subscribePool(descriptor);
      this.logger.warn({ mint: descriptor.mint, pool: descriptor.pool, tokenAmount }, "[07 POSITION] Recovered existing position");
    }
  }

  async #canOpenPosition(candidate: import("./state/tokenState.js").TokenState): Promise<boolean> {
    const blocked = new Set(this.config.BLOCKED_MINTS.split(",").map(value => value.trim()).filter(Boolean));
    if (blocked.has(candidate.descriptor.mint)) { this.logger.warn({ mint: candidate.descriptor.mint }, "[05 ENTRY] Buy blocked: mint denylist"); return false; }
    const mintAccount = await this.connection.getParsedAccountInfo(new PublicKey(candidate.descriptor.mint), "confirmed");
    const parsed = mintAccount.value?.data as { parsed?: { info?: { freezeAuthority?: string | null; extensions?: Array<{ extension: string; state?: string }> } } } | undefined;
    const info = parsed?.parsed?.info;
    if (info?.freezeAuthority) { this.logger.warn({ mint: candidate.descriptor.mint }, "[05 ENTRY] Buy blocked: freeze authority"); return false; }
    const dangerous = new Set(["nonTransferable", "transferHook", "permanentDelegate"]);
    const riskyExtension = info?.extensions?.find(extension => dangerous.has(extension.extension) || (extension.extension === "defaultAccountState" && extension.state === "frozen"));
    if (riskyExtension) { this.logger.warn({ mint: candidate.descriptor.mint, extension: riskyExtension.extension }, "[05 ENTRY] Buy blocked: risky token extension"); return false; }
    let riskCount = 0;
    for (const state of this.#states.values()) {
      if (state === candidate) continue;
      if (state.lifecycle !== TokenLifecycleState.TRACKING_POOL && state.lifecycle !== TokenLifecycleState.REENTRY_WAITING && state.lifecycle !== TokenLifecycleState.CLOSED && state.lifecycle !== TokenLifecycleState.FAILED) riskCount++;
    }
    if (riskCount >= this.config.MAX_CONCURRENT_POSITIONS) { this.logger.warn({ riskCount }, "[05 ENTRY] Buy blocked: position limit"); return false; }
    const candidateBuyLamports = candidate.buyLamports ?? this.positionSizer.currentBuyLamports();
    let activeExposure = 0n;
    for (const state of this.#states.values()) {
      if (state === candidate) continue;
      if (state.lifecycle !== TokenLifecycleState.TRACKING_POOL && state.lifecycle !== TokenLifecycleState.REENTRY_WAITING && state.lifecycle !== TokenLifecycleState.CLOSED && state.lifecycle !== TokenLifecycleState.FAILED) activeExposure += state.buyLamports ?? this.config.buyAmountLamports;
    }
    const projectedExposure = activeExposure + candidateBuyLamports;
    if (projectedExposure > this.config.maxTotalExposureLamports) { this.logger.warn({ projectedExposure }, "[05 ENTRY] Buy blocked: exposure limit"); return false; }
    const balance = BigInt(await this.connection.getBalance(this.config.keypair.publicKey, "processed"));
    if (balance - candidateBuyLamports < this.config.minWalletLamports) { this.logger.warn({ balance, candidateBuyLamports }, "[05 ENTRY] Buy blocked: wallet reserve"); return false; }
    return true;
  }

  async #subscribePool(descriptor: Parameters<VibeClient["subscribePool"]>[0]): Promise<void> {
    const key = `${descriptor.programId}:${descriptor.pool}`;
    if (this.#subscriptions.has(key)) return;
    this.logger.info({ mint: descriptor.mint, pool: descriptor.pool, venue: descriptor.venue }, "[02 STREAM] Opening pool subscription");
    const subscription = await this.vibe.subscribePool(descriptor, tx => this.#enqueue(tx));
    this.#subscriptions.set(key, subscription);
    this.logger.info({ mint: descriptor.mint, pool: descriptor.pool, subscriptions: this.#subscriptions.size }, "[02 STREAM] Pool subscription active");
  }

  async #stopTrackingPool(state: import("./state/tokenState.js").TokenState, reason: string): Promise<void> {
    const key = poolKey(state.descriptor);
    const subscription = this.#subscriptions.get(key);
    if (subscription) {
      await subscription.close();
      this.#subscriptions.delete(key);
    }
    this.#states.delete(state.descriptor);
    this.logger.info({ mint: state.descriptor.mint, pool: state.descriptor.pool, subscriptions: this.#subscriptions.size, reason }, "[CLEANUP] Stopped tracking pool");
  }

  async close(): Promise<void> {
    this.logger.info({ subscriptions: this.#subscriptions.size, receivedTransactions: this.#receivedTransactions, decodedEvents: this.#decodedEvents }, "[SHUTDOWN] Trading runtime stopping");
    if (this.#positionTimer) clearInterval(this.#positionTimer);
    if (this.#healthTimer) clearInterval(this.#healthTimer);
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    await Promise.allSettled([...this.#subscriptions.values()].map(subscription => subscription.close()));
    this.#subscriptions.clear();
    await this.vibe.close();
  }
}
