/**
 * strategy_v_001 — wall-clock rule_1 entry + mark/event exits, plus rule_2.
 *
 * Faithful port of scalpingbot Strategy. One instance per mint.
 * Live uses wall clock; backtest replaces `_nowMs` from event timestamps / timer ticks.
 */

import type { StrategyV001Config } from "../config/strategyV001.js";

export const STRATEGY_NAME = "strategy_v_001";

const PRICE_BUF_CAP = 256;

export const PHASE_UNBOUND = "unbound";
export const PHASE_WATCHING = "watching";
export const PHASE_HOLDING = "holding";
export const PHASE_DONE = "done";

export type StrategyDecision =
  | { kind: "none" }
  | { kind: "skip"; detail: string }
  | { kind: "fire_buy"; reason: string }
  | { kind: "fire_sell"; reason: string }
  | { kind: "fire_then_buy"; sellReason: string; buyReason: string };

export interface StrategyMarketEvent {
  signature: string;
  slot: number;
  timestampSec: number;
  timestampMs: number;
  side: "BUY" | "SELL";
  wallet: string;
  solAmount: number; // SOL float
  price: number; // SOL per token (same units as scalpingbot)
}

type TimedSample = { t: number; v: number };

export class StrategyV001Engine {
  private readonly cfg: StrategyV001Config;
  private readonly rule1SizeSol: number;
  private readonly _timerMs: number;

  // --- EngineState ---
  private phase: string = PHASE_UNBOUND;
  private px0 = 0.0;
  private t0 = 0;
  private _t0WallMs = 0;
  private _nowMs = 0;
  private sol0 = 0.0;
  private bound = false;
  private eligible = false;
  private entryDone = false;
  private aborted = false;
  private targetSoldBeforeBuy = false;
  private targetSecondBuyEarly = false;
  private gateBuySig = "";
  private _lastMarkPx = 0.0;
  private priceSamples: TimedSample[] = [];
  private marketBuyFlow: TimedSample[] = [];
  private scalpBuyFlow: TimedSample[] = [];
  private entryPrice = 0.0;
  private entryTs = 0;
  private peakPrice = 0.0;
  private fillsSlot = 0;
  private exitInFlight = false;
  private pendingRule1TargetBuyExitSol: number | null = null;
  private dumpArmMs: number | null = null;
  private targetWallet = "";
  private gateSlug = "";
  private gateNickname = "";
  private rule1WatchSkipDetail: string | null = null;
  private scalpMcOk = false;
  private scalpDone = false;
  private scalpEntryPending = false;
  private holdingScalp = false;
  private scalpHoldT0Ms: number | null = null;
  private rule1Fired = false;

  // bridge / diagnostics
  private _lastBuyReason = "";
  private _lastBuyDiag: Record<string, unknown> = {};
  private _lastSkip = "";
  private _lastSellReason = "";
  private _pendingThenBuy = false;

  constructor(cfg: StrategyV001Config) {
    this.cfg = cfg;
    this.rule1SizeSol = Number(cfg.rule_1_size_sol);
    this._timerMs = cfg.timer_ms > 0 ? Math.trunc(cfg.timer_ms) : 200;
  }

  get timerMs(): number {
    return this._timerMs;
  }

  get phaseName(): string {
    return this.phase;
  }

  get isDone(): boolean {
    return this.phase === PHASE_DONE;
  }

  get lastMarkPx(): number {
    return this._lastMarkPx;
  }

  get lastSkip(): string {
    return this._lastSkip;
  }

  get lastBuyReason(): string {
    return this._lastBuyReason || STRATEGY_NAME;
  }

  get lastSellReason(): string {
    return this._lastSellReason || "exit signal";
  }

  get lastBuyDiag(): Record<string, unknown> {
    return { ...this._lastBuyDiag };
  }

  buySizeSol(): number {
    if (this.scalpEntryPending) {
      return Number(this.cfg.rule_2_size_sol);
    }
    return this.rule1SizeSol;
  }

  /** Consumes the pending then-buy flag (same as Python). */
  pendingThenBuy(): boolean {
    const v = this._pendingThenBuy;
    this._pendingThenBuy = false;
    return v;
  }

  timerWantsTicks(): boolean {
    // Only tick when a wall-clock deadline is actually pending:
    //  - rule_1 still possible (rule_1_watch_s / rule_1_entry_max_s crossings), or
    //  - scalp hold open (rule_2_max_hold_s timer).
    // A soft-skip mint sitting in WATCHING for a scalp only reacts to events.
    const watchingLive =
      this.phase === PHASE_WATCHING && this.eligible && !this.entryDone;
    const scalpHolding = this.phase === PHASE_HOLDING && this.holdingScalp;
    return watchingLive || scalpHolding;
  }

  bindGateBuy(args: {
    price: number;
    sol: number;
    tsSec: number;
    wallet: string;
    gateSig: string;
    nowMs: number;
  }): StrategyDecision {
    this._t0WallMs = Math.trunc(args.nowMs);
    this._nowMs = this._t0WallMs;
    return this.applyDecision(
      this.bindGateBuyCore(
        args.price,
        args.sol,
        Math.trunc(args.tsSec),
        args.wallet,
        "gate",
        "Gate",
        args.gateSig
      )
    );
  }

  onBuyFill(fillPrice: number, fillTsSec: number, fillSlot: number): void {
    this.entryPrice = fillPrice;
    this.peakPrice = fillPrice;
    this.entryTs = Math.trunc(fillTsSec);
    this.fillsSlot = Math.trunc(fillSlot);
    this.phase = PHASE_HOLDING;
    this.exitInFlight = false;
    if (this.scalpEntryPending) {
      this.holdingScalp = true;
      this.scalpHoldT0Ms = this._nowMs;
      this.scalpBuyFlow = [];
      this.scalpEntryPending = false;
    } else {
      this.holdingScalp = false;
      this.scalpHoldT0Ms = null;
    }
    this.marketBuyFlow = [];
    this.dumpArmMs = null;
    if (fillPrice > 0) {
      this.notePrice(fillPrice);
    }
  }

  onBuyFailed(): void {
    const wasScalp = this.scalpEntryPending || this.scalpDone;
    this.entryPrice = 0.0;
    this.exitInFlight = false;
    this.pendingRule1TargetBuyExitSol = null;
    this.dumpArmMs = null;
    this.scalpEntryPending = false;
    this.holdingScalp = false;
    this.scalpHoldT0Ms = null;
    this.scalpBuyFlow = [];
    if (wasScalp) {
      if (this.scalpMcOk) {
        this.scalpDone = false;
        this.phase = PHASE_WATCHING;
        return;
      }
      this.scalpDone = false;
      this.phase = PHASE_DONE;
      this.entryDone = true;
      return;
    }
    this.phase = PHASE_DONE;
    this.entryDone = true;
  }

  onSellFill(): void {
    this.entryPrice = 0.0;
    this.exitInFlight = false;
    this.pendingRule1TargetBuyExitSol = null;
    this.dumpArmMs = null;
    // Ordered main-SELL → scalp-BUY: keep scalp flags for the follow-up buy.
    if (this.scalpEntryPending) {
      this.holdingScalp = false;
      this.scalpHoldT0Ms = null;
      this.phase = PHASE_WATCHING;
      this.entryDone = true;
      return;
    }
    this.holdingScalp = false;
    this.scalpHoldT0Ms = null;
    this.scalpBuyFlow = [];
    if (this.scalpMcOk) {
      this.scalpDone = false;
      this.phase = PHASE_WATCHING;
      this.entryDone = true;
      return;
    }
    this.phase = PHASE_DONE;
    this.entryDone = true;
  }

  onEvent(event: StrategyMarketEvent, holding: boolean): StrategyDecision {
    this._nowMs = Math.trunc(event.timestampMs);
    return this.applyDecision(this.onEventCore(event, holding));
  }

  onTimer(markPx: number, nowMs: number): StrategyDecision {
    this._nowMs = Math.trunc(nowMs);
    return this.applyDecision(this.onTimerCore(markPx));
  }

  // ---- decision helpers ----

  private none(): StrategyDecision {
    return { kind: "none" };
  }

  private skip(detail: string): StrategyDecision {
    return { kind: "skip", detail };
  }

  private fireBuy(reason: string): StrategyDecision {
    return { kind: "fire_buy", reason };
  }

  private fireSell(reason: string): StrategyDecision {
    return { kind: "fire_sell", reason };
  }

  private fireThenBuy(sellReason: string, buyReason: string): StrategyDecision {
    return { kind: "fire_then_buy", sellReason, buyReason };
  }

  private applyDecision(decision: StrategyDecision): StrategyDecision {
    if (decision.kind === "fire_buy") {
      this._lastBuyReason = decision.reason;
    } else if (decision.kind === "fire_sell") {
      this._lastSellReason = decision.reason;
    } else if (decision.kind === "fire_then_buy") {
      this._lastSellReason = decision.sellReason;
      this._lastBuyReason = decision.buyReason;
      this._pendingThenBuy = true;
    } else if (decision.kind === "skip") {
      this._lastSkip = decision.detail;
    }
    return decision;
  }

  // ---- bind ----

  private bindGateBuyCore(
    price: number,
    sol: number,
    ts: number,
    wallet: string,
    slug: string,
    nickname: string,
    gateSig: string
  ): StrategyDecision {
    if (this.bound) {
      return this.none();
    }
    const cfg = this.cfg;
    this.targetWallet = wallet;
    this.gateSlug = slug;
    this.gateNickname = nickname;
    this.px0 = price;
    this.t0 = Math.trunc(ts);
    this.sol0 = sol;
    this.bound = true;
    this.targetSecondBuyEarly = false;
    this.gateBuySig = gateSig;
    this.priceSamples = [];
    this.marketBuyFlow = [];
    this.scalpBuyFlow = [];
    this._lastMarkPx = price > 0 ? price : 0.0;
    if (price > 0) {
      this.notePrice(price);
    }

    const mcap = price > 0 ? price * 1_000_000_000.0 : 0.0;
    const clipOk = price > 0 && cfg.clip_lo <= sol && sol <= cfg.clip_hi;
    const mcOk = cfg.max_mc_sol <= 0.0 || mcap <= cfg.max_mc_sol;
    const minMcOk = cfg.min_mc_sol <= 0.0 || mcap >= cfg.min_mc_sol;
    const scalpOk = cfg.rule_2_enabled;
    this.scalpMcOk = minMcOk && mcOk;

    if (!mcOk) {
      this._lastSkip = `${nickname} first-buy mcap ${mcap.toFixed(2)} SOL > max ${cfg.max_mc_sol} — skip mint`;
      this.eligible = false;
      this.entryDone = true;
      this.phase = PHASE_DONE;
      return this.skip(this._lastSkip);
    }
    if (!minMcOk) {
      this._lastSkip = `min_mc — mcap ${mcap.toFixed(1)} SOL < min ${cfg.min_mc_sol} SOL — avoid buy`;
      this.eligible = false;
      this.entryDone = true;
      this.phase = PHASE_DONE;
      return this.skip(this._lastSkip);
    }
    if (!clipOk) {
      const detail = `${nickname.toLowerCase()} first-buy ${sol.toFixed(3)} SOL outside clip [${cfg.clip_lo},${cfg.clip_hi}] — skip mint`;
      this._lastSkip = detail;
      if (scalpOk) {
        // Soft: no rule_1, still listen for gate big-sell rule_2.
        this.eligible = false;
        this.entryDone = true;
        this.phase = PHASE_WATCHING;
        this.rule1WatchSkipDetail = detail;
        return this.none();
      }
      this.eligible = false;
      this.entryDone = true;
      this.phase = PHASE_DONE;
      return this.skip(detail);
    }

    if (!cfg.rule_1_enabled) {
      const detail = "rule_1_disabled — skip rule_1 entry";
      this._lastSkip = detail;
      if (scalpOk) {
        this.eligible = false;
        this.entryDone = true;
        this.phase = PHASE_WATCHING;
        this.rule1WatchSkipDetail = detail;
        return this.none();
      }
      this.eligible = false;
      this.entryDone = true;
      this.phase = PHASE_DONE;
      return this.skip(detail);
    }

    this.eligible = true;
    this.phase = PHASE_WATCHING;
    return this.none();
  }

  // ---- price samples / momentum ----

  private notePrice(px: number): void {
    if (px <= 0) {
      return;
    }
    this._lastMarkPx = px;
    const now = this._nowMs;
    this.priceSamples.push({ t: now, v: px });
    while (this.priceSamples.length > PRICE_BUF_CAP) {
      this.priceSamples.shift();
    }
    while (
      this.priceSamples.length > 0 &&
      now - this.priceSamples[0]!.t > 30_000
    ) {
      this.priceSamples.shift();
    }
  }

  private priceLookback(lookbackS: number): number | null {
    if (lookbackS === 0 || this.priceSamples.length === 0) {
      return null;
    }
    const target = this._nowMs - lookbackS * 1000;
    let best: { age: number; px: number } | null = null; // smallest age wins
    for (const { t, v: px } of this.priceSamples) {
      if (t <= target) {
        const age = target - t;
        if (best === null || age <= best.age) {
          best = { age, px };
        }
      }
    }
    if (best !== null) {
      return best.px;
    }
    return this.priceSamples[0]!.v;
  }

  private momentum(lookbackS: number, nowPx: number): number | null {
    if (nowPx <= 0) {
      return null;
    }
    const prev = this.priceLookback(lookbackS);
    if (prev === null || prev <= 0) {
      return null;
    }
    return nowPx / prev - 1.0;
  }

  private noteMarketBuyFlow(sol: number, windowS: number): number {
    if (sol > 0) {
      this.marketBuyFlow.push({ t: this._nowMs, v: sol });
      while (this.marketBuyFlow.length > PRICE_BUF_CAP) {
        this.marketBuyFlow.shift();
      }
    }
    return this.cumMarketBuy(windowS);
  }

  private cumMarketBuy(windowS: number): number {
    const win = (windowS > 0 ? windowS : 1) * 1000;
    const now = this._nowMs;
    while (
      this.marketBuyFlow.length > 0 &&
      now - this.marketBuyFlow[0]!.t > win
    ) {
      this.marketBuyFlow.shift();
    }
    let sum = 0;
    for (const { v } of this.marketBuyFlow) {
      sum += v;
    }
    return sum;
  }

  private noteScalpBuyFlow(sol: number, windowS: number): number {
    if (sol > 0) {
      this.scalpBuyFlow.push({ t: this._nowMs, v: sol });
      while (this.scalpBuyFlow.length > PRICE_BUF_CAP) {
        this.scalpBuyFlow.shift();
      }
    }
    return this.cumScalpBuy(windowS);
  }

  private cumScalpBuy(windowS: number): number {
    const win = (windowS > 0 ? windowS : 1) * 1000;
    const now = this._nowMs;
    while (
      this.scalpBuyFlow.length > 0 &&
      now - this.scalpBuyFlow[0]!.t > win
    ) {
      this.scalpBuyFlow.shift();
    }
    let sum = 0;
    for (const { v } of this.scalpBuyFlow) {
      sum += v;
    }
    return sum;
  }

  private wallAgeS(): number {
    return Math.max(0, this._nowMs - this._t0WallMs) / 1000.0;
  }

  // ---- scalp gating ----

  private scalpListening(): boolean {
    const cfg = this.cfg;
    return (
      cfg.rule_2_enabled &&
      this.bound &&
      this.scalpMcOk &&
      !this.scalpDone &&
      !this.scalpEntryPending &&
      this.entryPrice <= 0 &&
      !this.holdingScalp &&
      this.phase !== PHASE_HOLDING
    );
  }

  private scalpEntryReady(): boolean {
    const cfg = this.cfg;
    return (
      cfg.rule_2_enabled &&
      this.bound &&
      this.scalpMcOk &&
      !this.scalpDone &&
      !this.scalpEntryPending &&
      !this.holdingScalp
    );
  }

  // ---- notes ----

  private noteTargetSell(event: StrategyMarketEvent): void {
    if (!this.cfg.rule_1_skip_target_sold_before_buy) {
      return;
    }
    if (
      event.side === "SELL" &&
      this.targetWallet &&
      event.wallet === this.targetWallet
    ) {
      this.targetSoldBeforeBuy = true;
    }
  }

  private noteTargetSecondBuy(event: StrategyMarketEvent): void {
    if (
      !this.cfg.rule_1_skip_any_target_second_buy ||
      this.entryDone ||
      this.aborted
    ) {
      return;
    }
    if (
      event.side !== "BUY" ||
      !this.targetWallet ||
      event.wallet !== this.targetWallet
    ) {
      return;
    }
    if (this.gateBuySig && event.signature === this.gateBuySig) {
      return;
    }
    this.targetSecondBuyEarly = true;
  }

  private notePendingTargetBuyExit(event: StrategyMarketEvent): void {
    const cfg = this.cfg;
    if (cfg.rule_1_target_buy_exit_sol <= 0) {
      return;
    }
    if (event.side !== "BUY") {
      return;
    }
    if (!this.targetWallet || event.wallet !== this.targetWallet) {
      return;
    }
    if (this.gateBuySig && event.signature === this.gateBuySig) {
      return;
    }
    if (event.solAmount <= cfg.rule_1_target_buy_exit_sol) {
      return;
    }
    const prev = this.pendingRule1TargetBuyExitSol ?? 0.0;
    if (event.solAmount >= prev) {
      this.pendingRule1TargetBuyExitSol = event.solAmount;
    }
  }

  private abortSecondBuy(
    _event: StrategyMarketEvent | null
  ): StrategyDecision | null {
    if (!this.targetSecondBuyEarly) {
      return null;
    }
    if (this.scalpListening()) {
      this.entryDone = true;
      return null;
    }
    const dt = Math.trunc(this.wallAgeS());
    this.aborted = true;
    this.entryDone = true;
    this.phase = PHASE_DONE;
    return this.skip(
      `second_buy_any — target 2nd BUY at dt=${dt}s (any size/time)`
    );
  }

  private abortSoldBefore(): StrategyDecision | null {
    if (
      !(
        this.cfg.rule_1_skip_target_sold_before_buy &&
        this.targetSoldBeforeBuy
      )
    ) {
      return null;
    }
    if (this.scalpListening()) {
      this.entryDone = true;
      return null;
    }
    this.aborted = true;
    this.entryDone = true;
    this.phase = PHASE_DONE;
    return this.skip("sold_before — target sold before our buy");
  }

  // ---- scalp arm ----

  private armRule2(event: StrategyMarketEvent): StrategyDecision | null {
    const cfg = this.cfg;
    if (!this.scalpEntryReady()) {
      return null;
    }
    if (event.side !== "SELL") {
      return null;
    }
    if (!this.targetWallet || event.wallet !== this.targetWallet) {
      return null;
    }
    if (cfg.rule_2_min_sol > 0 && event.solAmount < cfg.rule_2_min_sol) {
      return null;
    }
    const px = event.price > 0 ? event.price : this._lastMarkPx;
    if (px <= 0 || this.px0 <= 0) {
      return null;
    }
    const profit = px / this.px0 - 1.0;
    if (cfg.rule_2_min_profit > 0 && profit < cfg.rule_2_min_profit) {
      return null;
    }
    const mcap = px * 1_000_000_000.0;
    if (cfg.min_mc_sol > 0 && mcap < cfg.min_mc_sol) {
      return null;
    }
    if (cfg.max_mc_sol > 0 && mcap > cfg.max_mc_sol) {
      return null;
    }

    this.scalpDone = true;
    this.scalpEntryPending = true;
    this.aborted = false;
    const holdS = cfg.rule_2_max_hold_s;
    const diag =
      `rule_2 gate_sell=${event.solAmount.toFixed(3)} SOL profit=${profit.toFixed(3)} ` +
      `(>= ${cfg.rule_2_min_profit.toFixed(3)}) mcap=${mcap.toFixed(1)} ` +
      `size=${cfg.rule_2_size_sol.toFixed(3)} max_hold=${holdS}s slot=${event.slot}`;
    this._lastBuyDiag = {
      scalp: true,
      gate_sell_sol: event.solAmount,
      profit: round(profit, 4),
      mcap: round(mcap, 3),
      size_sol: cfg.rule_2_size_sol,
      max_hold_s: holdS,
      slot: event.slot
    };
    return this.fireBuy(`rule_2 | ${diag}`);
  }

  private tryRule2(event: StrategyMarketEvent): StrategyDecision | null {
    if (!this.scalpListening()) {
      return null;
    }
    return this.armRule2(event);
  }

  // ---- entry ----

  private tryEntry(px: number, slot: number): StrategyDecision {
    const cfg = this.cfg;
    if (!cfg.rule_1_enabled) {
      return this.none();
    }
    if (this.scalpEntryPending) {
      return this.none();
    }
    if (this.entryDone || this.aborted || this.phase === PHASE_DONE) {
      return this.skip("mint already attempted (entry_done) — no re-entry");
    }
    if (!this.eligible || this.phase !== PHASE_WATCHING) {
      return this.skip("mint not eligible after gate bind");
    }
    let d = this.abortSecondBuy(null);
    if (d !== null) {
      return d;
    }
    d = this.abortSoldBefore();
    if (d !== null) {
      return d;
    }
    if (px <= 0) {
      return this.none();
    }

    const ageS = this.wallAgeS();
    // NaN-safe: x == x is false for NaN (matches Python)
    const watch =
      cfg.rule_1_watch_s > 0 && cfg.rule_1_watch_s === cfg.rule_1_watch_s
        ? cfg.rule_1_watch_s
        : 0.0;
    const maxAge = cfg.rule_1_entry_max_s;

    if (ageS < watch) {
      return this.none();
    }
    if (ageS > maxAge) {
      this.entryDone = true;
      if (this.scalpListening()) {
        return this.none();
      }
      this.aborted = true;
      this.phase = PHASE_DONE;
      return this.skip(
        `entry_expired — wall age=${ageS.toFixed(1)}s > max ${maxAge}s — abort`
      );
    }

    const endRet = this.px0 > 0 ? px / this.px0 - 1.0 : 0.0;
    if (cfg.rule_1_watch_max_end > 0 && endRet >= cfg.rule_1_watch_max_end) {
      return this.none();
    }

    const lookback =
      cfg.rule_1_skip_entry_mom_s !== 0 ? cfg.rule_1_skip_entry_mom_s : 1;
    let mom = this.momentum(lookback, px);
    if (mom === null) {
      mom = 0.0;
    }
    if (cfg.rule_1_skip_entry_mom_ge > 0 && mom >= cfg.rule_1_skip_entry_mom_ge) {
      this.entryDone = true;
      if (this.scalpListening()) {
        return this.none();
      }
      this.aborted = true;
      this.phase = PHASE_DONE;
      return this.skip(
        `entry_mom — ${lookback}s mom=${mom.toFixed(3)} >= ${cfg.rule_1_skip_entry_mom_ge.toFixed(3)} — permanent skip`
      );
    }

    this.entryDone = true;
    this.rule1Fired = true;
    const mcap = px * 1_000_000_000.0;
    const diag =
      `rule_1 wall=${ageS.toFixed(2)}s end_ret=${endRet.toFixed(3)} ` +
      `mom_${lookback}s=${mom.toFixed(3)} mcap=${mcap.toFixed(1)} slot=${slot}`;
    this._lastBuyDiag = {
      scalp: false,
      wall_s: round(ageS, 3),
      end_ret: round(endRet, 4),
      mom: round(mom, 4),
      mcap: round(mcap, 3),
      slot
    };
    return this.fireBuy(`rule_1 | ${diag}`);
  }

  // ---- holds ----

  private onHoldMark(px: number): StrategyDecision {
    const cfg = this.cfg;
    if (this.exitInFlight) {
      return this.none();
    }
    if (px <= 0) {
      return this.none();
    }
    if (px > this.peakPrice) {
      this.peakPrice = px;
    }

    if (this.holdingScalp) {
      return this.onScalpHoldMark(px);
    }

    if (this.pendingRule1TargetBuyExitSol !== null) {
      const sol = this.pendingRule1TargetBuyExitSol;
      this.pendingRule1TargetBuyExitSol = null;
      if (cfg.rule_1_target_buy_exit_sol > 0 && sol > cfg.rule_1_target_buy_exit_sol) {
        this.exitInFlight = true;
        return this.fireSell(
          `target_buy_exit — ${sol.toFixed(3)} SOL his buy >${cfg.rule_1_target_buy_exit_sol.toFixed(3)} (in-flight) | held=0s`
        );
      }
    }

    if (cfg.rule_1_mark_tp > 0 && this.px0 > 0) {
      const gateRet = px / this.px0 - 1.0;
      if (gateRet >= cfg.rule_1_mark_tp) {
        this.exitInFlight = true;
        return this.fireSell(
          `rule_1_mark_tp | gate_ret=${gateRet.toFixed(3)} >= ${cfg.rule_1_mark_tp.toFixed(3)} (vs gate buy)`
        );
      }
    }

    if (cfg.rule_1_dump_stop > 0 && this.entryPrice > 0) {
      const ret = px / this.entryPrice - 1.0;
      const graceS =
        cfg.rule_1_dump_grace_s > 0 ? cfg.rule_1_dump_grace_s : 0.0;
      if (ret <= -cfg.rule_1_dump_stop) {
        if (graceS <= 0) {
          this.dumpArmMs = null;
          this.exitInFlight = true;
          return this.fireSell(
            `rule_1_dump_stop | ret=${ret.toFixed(3)} stop=${cfg.rule_1_dump_stop.toFixed(3)} (vs fill)`
          );
        }
        if (this.dumpArmMs === null) {
          this.dumpArmMs = this._nowMs;
        }
        const heldArm = (this._nowMs - this.dumpArmMs) / 1000.0;
        if (heldArm >= graceS) {
          this.dumpArmMs = null;
          this.exitInFlight = true;
          return this.fireSell(
            `rule_1_dump_stop | ret=${ret.toFixed(3)} stop=${cfg.rule_1_dump_stop.toFixed(3)} ` +
              `grace=${heldArm.toFixed(2)}s (vs fill)`
          );
        }
      } else {
        this.dumpArmMs = null;
      }
    }
    return this.none();
  }

  private onScalpHoldMark(px: number): StrategyDecision {
    const cfg = this.cfg;
    if (this.exitInFlight || !this.holdingScalp) {
      return this.none();
    }
    const heldMs = this._nowMs - (this.scalpHoldT0Ms ?? this._nowMs);
    const maxHoldMs = cfg.rule_2_max_hold_s * 1000;
    const cum = this.cumScalpBuy(cfg.rule_2_cum_window_s);

    if (cfg.rule_2_max_hold_s > 0 && heldMs >= maxHoldMs) {
      this.exitInFlight = true;
      const ret =
        this.entryPrice > 0 && px > 0 ? px / this.entryPrice - 1.0 : 0.0;
      return this.fireSell(
        `scalp_time | held=${(heldMs / 1000.0).toFixed(3)}s >= ${cfg.rule_2_max_hold_s}s ` +
          `cum=${cum.toFixed(3)} ret=${ret.toFixed(3)}`
      );
    }

    if (px <= 0 || this.entryPrice <= 0) {
      return this.none();
    }
    const ret = px / this.entryPrice - 1.0;

    if (cfg.rule_2_tp > 0 && ret >= cfg.rule_2_tp) {
      this.exitInFlight = true;
      return this.fireSell(
        `scalp_tp | ret=${ret.toFixed(3)} >= ${cfg.rule_2_tp.toFixed(3)} cum=${cum.toFixed(3)} ` +
          `held=${(heldMs / 1000.0).toFixed(3)}s`
      );
    }
    if (cfg.rule_2_sl > 0 && ret <= -cfg.rule_2_sl) {
      this.exitInFlight = true;
      return this.fireSell(
        `scalp_sl | ret=${ret.toFixed(3)} <= -${cfg.rule_2_sl.toFixed(3)} cum=${cum.toFixed(3)} ` +
          `held=${(heldMs / 1000.0).toFixed(3)}s`
      );
    }
    return this.none();
  }

  private onHoldEvent(event: StrategyMarketEvent): StrategyDecision {
    const cfg = this.cfg;
    if (this.exitInFlight) {
      return this.none();
    }
    const px = event.price;
    if (px > 0) {
      this.notePrice(px);
    }

    if (this.holdingScalp) {
      return this.onScalpHoldEvent(event);
    }

    // Gate sell any amount — optionally pair with ordered scalp BUY.
    if (
      cfg.rule_1_target_sell_exit &&
      event.side === "SELL" &&
      this.targetWallet &&
      event.wallet === this.targetWallet
    ) {
      const ret =
        this.entryPrice > 0 && px > 0 ? px / this.entryPrice - 1.0 : 0.0;
      const sellReason = `target_sell — gate sold ${event.solAmount.toFixed(3)} SOL | ret=${ret.toFixed(3)}`;
      const buy = this.armRule2(event);
      if (buy !== null && buy.kind === "fire_buy") {
        this.exitInFlight = true;
        return this.fireThenBuy(sellReason, buy.reason);
      }
      this.exitInFlight = true;
      return this.fireSell(sellReason);
    }

    // Gate BUY strictly > threshold.
    if (
      cfg.rule_1_target_buy_exit_sol > 0 &&
      event.side === "BUY" &&
      this.targetWallet &&
      event.wallet === this.targetWallet &&
      event.solAmount > cfg.rule_1_target_buy_exit_sol
    ) {
      this.exitInFlight = true;
      return this.fireSell(
        `target_buy_exit — ${event.solAmount.toFixed(3)} SOL his buy >${cfg.rule_1_target_buy_exit_sol.toFixed(3)}`
      );
    }

    // Market BUY: single > threshold OR window cum > threshold.
    if (
      cfg.rule_1_market_buy_exit_sol > 0 &&
      event.side === "BUY" &&
      event.solAmount > 0
    ) {
      const win =
        cfg.rule_1_market_buy_cum_window_s !== 0
          ? cfg.rule_1_market_buy_cum_window_s
          : 1;
      const cum = this.noteMarketBuyFlow(event.solAmount, win);
      const singleHit = event.solAmount > cfg.rule_1_market_buy_exit_sol;
      const cumHit = cum > cfg.rule_1_market_buy_exit_sol;
      if (singleHit || cumHit) {
        this.exitInFlight = true;
        let reason: string;
        if (singleHit && !cumHit) {
          reason = `market_buy_exit — ${event.solAmount.toFixed(3)} SOL buy >${cfg.rule_1_market_buy_exit_sol.toFixed(3)}`;
        } else if (cumHit && !singleHit) {
          reason =
            `market_buy_exit — ${win}s cum=${cum.toFixed(3)} SOL >${cfg.rule_1_market_buy_exit_sol.toFixed(3)} ` +
            `(last=${event.solAmount.toFixed(3)})`;
        } else {
          reason =
            `market_buy_exit — ${event.solAmount.toFixed(3)} SOL buy / ${win}s ` +
            `cum=${cum.toFixed(3)} >${cfg.rule_1_market_buy_exit_sol.toFixed(3)}`;
        }
        return this.fireSell(reason);
      }
    }

    return this.onHoldMark(px > 0 ? px : this._lastMarkPx);
  }

  private onScalpHoldEvent(event: StrategyMarketEvent): StrategyDecision {
    const cfg = this.cfg;
    if (this.exitInFlight || !this.holdingScalp) {
      return this.none();
    }
    const px = event.price > 0 ? event.price : this._lastMarkPx;
    const isTarget =
      Boolean(this.targetWallet) && event.wallet === this.targetWallet;

    if (!isTarget && event.side === "BUY" && event.solAmount > 0) {
      const win =
        cfg.rule_2_cum_window_s !== 0 ? cfg.rule_2_cum_window_s : 5;
      const cum = this.noteScalpBuyFlow(event.solAmount, win);
      if (cfg.rule_2_big_buy_sol > 0 && event.solAmount >= cfg.rule_2_big_buy_sol) {
        this.exitInFlight = true;
        return this.fireSell(
          `scalp_big_buy | ${event.solAmount.toFixed(3)} SOL buy >= ${cfg.rule_2_big_buy_sol.toFixed(3)} cum=${cum.toFixed(3)}`
        );
      }
      if (cfg.rule_2_cum_buy_sol > 0 && cum >= cfg.rule_2_cum_buy_sol) {
        this.exitInFlight = true;
        return this.fireSell(
          `scalp_cum_buy | ${win}s cum=${cum.toFixed(3)} >= ${cfg.rule_2_cum_buy_sol.toFixed(3)} (last=${event.solAmount.toFixed(3)})`
        );
      }
    }

    return this.onScalpHoldMark(px);
  }

  // ---- timer ----

  private onTimerCore(markPx: number): StrategyDecision {
    if (!this.bound) {
      return this.none();
    }
    if (markPx > 0) {
      this.notePrice(markPx);
    }
    const px = markPx > 0 ? markPx : this._lastMarkPx;

    if (
      this.phase === PHASE_HOLDING ||
      (this.entryPrice > 0 && !this.entryDone)
    ) {
      if (this.phase === PHASE_HOLDING) {
        return this.onHoldMark(px);
      }
    }

    if (this.phase === PHASE_WATCHING) {
      if (this.entryDone && this.entryPrice <= 0) {
        return this.none();
      }
      return this.tryEntry(px, 0);
    }
    return this.none();
  }

  // ---- event dispatch ----

  private onEventCore(
    event: StrategyMarketEvent,
    holding: boolean
  ): StrategyDecision {
    if (!this.bound) {
      return this.none();
    }

    if (holding || this.phase === PHASE_HOLDING) {
      return this.onHoldEvent(event);
    }

    this.noteTargetSell(event);
    this.noteTargetSecondBuy(event);
    if (event.price > 0) {
      this.notePrice(event.price);
    }

    const rule2 = this.tryRule2(event);
    if (rule2 !== null) {
      return rule2;
    }

    if (this.entryDone && !this.aborted && this.entryPrice <= 0) {
      this.notePendingTargetBuyExit(event);
      return this.none();
    }

    if (this.phase === PHASE_WATCHING) {
      let d = this.abortSecondBuy(event);
      if (d !== null) {
        return d;
      }
      d = this.abortSoldBefore();
      if (d !== null) {
        return d;
      }
      const px = event.price > 0 ? event.price : this._lastMarkPx;
      d = this.tryEntry(px, event.slot);
      if (d.kind === "fire_buy") {
        this.notePendingTargetBuyExit(event);
      }
      return d;
    }

    return this.none();
  }
}

/** Python `round(x, ndigits)` — banker's rounding via Number.toFixed then Number. */
function round(x: number, ndigits: number): number {
  const f = 10 ** ndigits;
  return Math.round(x * f + Number.EPSILON) / f;
}
