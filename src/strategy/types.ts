import type { PoolTradeEvent } from "../events/types.js";
import type { TokenState } from "../state/tokenState.js";

export interface StrategyExecution {
  sendBuy(state: TokenState, signalMonoMs: number): Promise<void>;
  sendSell(state: TokenState, reason: string, signalMonoMs: number): Promise<void>;
  recordEntryEvent(state: TokenState, event: string, extra?: object): void;
}

export interface Strategy {
  readonly timerMs: number;
  onEvent(state: TokenState, event: PoolTradeEvent): void;
  onClock(state: TokenState, nowMs?: number): void;
  onBuyFill?(state: TokenState, fill: { price: number; slot: number }): void;
  onBuyFailed?(state: TokenState): void;
  onSellFill?(state: TokenState): { thenBuy: boolean };
  onThenBuy?(state: TokenState): Promise<void> | void;
  restoreOpenPosition?(state: TokenState, fillPriceLive: number): void;
}

export class NoOpStrategy implements Strategy {
  readonly timerMs = 1_000;
  onEvent(): void {}
  onClock(): void {}
}
