import type { PoolTradeEvent } from "../events/types.js";
import { assertTransition, TokenLifecycleState } from "../strategy/state.js";
import type { PreparedTradeTransaction, PoolDescriptor, VenueAdapter } from "../venues/types.js";
import { EventBuffer } from "./eventBuffer.js";

export interface PositionPrices {
  entrySignalPrice?: number;
  expectedEntryPrice?: number;
  actualEntryFillPrice?: number;
  actualEntryDeviationPct?: number;
  currentMarkPrice?: number;
  exitSignalPrice?: number;
  expectedExitPrice?: number;
  actualExitFillPrice?: number;
}

export class TokenState {
  lifecycle = TokenLifecycleState.TARGET_BUY_DETECTED;
  readonly events: EventBuffer;
  preparedBuy?: PreparedTradeTransaction;
  preparedSell?: PreparedTradeTransaction;
  buySignature?: string;
  sellSignature?: string;
  actualTokenAmount?: bigint;
  actualEntrySolAmount?: bigint;
  buyLamports?: bigint;
  readonly prices: PositionPrices = {};
  buySendClaimed = false;
  sellSendClaimed = false;
  sellPrebuildClaimed = false;
  entryProcessedMs?: number;
  /** Optional per-trade slippage overrides (e.g. rule_2 scalp). */
  buySlippageBps?: number;
  sellSlippageBps?: number;
  targetObservedTokenAmount: bigint;
  readonly #targetTrades = new Set<string>();

  constructor(readonly descriptor: PoolDescriptor, readonly adapter: VenueAdapter, readonly targetBuy: PoolTradeEvent, retentionMs: number) {
    this.events = new EventBuffer(retentionMs);
    this.targetObservedTokenAmount = targetBuy.tokenAmount;
    this.#targetTrades.add(`${targetBuy.signature}:${targetBuy.eventIndex}`);
  }

  recordTargetTrade(event: PoolTradeEvent): boolean {
    if (event.trader !== this.targetBuy.trader) return false;
    const key = `${event.signature}:${event.eventIndex}`;
    if (this.#targetTrades.has(key)) return false;
    this.#targetTrades.add(key);
    if (event.side === "buy") this.targetObservedTokenAmount += event.tokenAmount;
    else this.targetObservedTokenAmount = event.tokenAmount >= this.targetObservedTokenAmount ? 0n : this.targetObservedTokenAmount - event.tokenAmount;
    return true;
  }

  transition(next: TokenLifecycleState): void {
    if (next === this.lifecycle) return;
    assertTransition(this.lifecycle, next);
    this.lifecycle = next;
  }

  restorePosition(tokenAmount: bigint, entryPrice: number, currentPrice: number, entryProcessedMs: number): void {
    this.actualTokenAmount = tokenAmount;
    this.prices.actualEntryFillPrice = entryPrice;
    this.prices.currentMarkPrice = currentPrice;
    this.entryProcessedMs = entryProcessedMs;
    this.lifecycle = TokenLifecycleState.POSITION_ACTIVE_CONFIRMED;
  }

  clearFilledPosition(): void {
    this.actualTokenAmount = undefined;
    this.actualEntrySolAmount = undefined;
    this.buyLamports = undefined;
    this.preparedBuy = undefined;
    this.preparedSell = undefined;
    this.buySignature = undefined;
    this.sellSignature = undefined;
    this.entryProcessedMs = undefined;
    this.buySlippageBps = undefined;
    this.sellSlippageBps = undefined;
    this.prices.entrySignalPrice = undefined;
    this.prices.expectedEntryPrice = undefined;
    this.prices.actualEntryFillPrice = undefined;
    this.prices.actualEntryDeviationPct = undefined;
    this.prices.exitSignalPrice = undefined;
    this.prices.expectedExitPrice = undefined;
    this.prices.actualExitFillPrice = undefined;
  }

  claimBuySend(): boolean {
    if (this.buySendClaimed) return false;
    this.buySendClaimed = true;
    return true;
  }

  resetBuySendClaim(): void {
    this.buySendClaimed = false;
  }

  claimSellSend(): boolean {
    if (this.sellSendClaimed) return false;
    this.sellSendClaimed = true;
    return true;
  }

  releaseSellSend(): void {
    this.sellSendClaimed = false;
  }

  resetSellSendClaim(): void {
    this.sellSendClaimed = false;
  }

  claimSellPrebuild(): boolean {
    if (this.sellPrebuildClaimed) return false;
    this.sellPrebuildClaimed = true;
    return true;
  }
}
