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
  /** `rearm` keeps the mint in the pool tape after a failed buy. strategy_v_011 omits it and the mint fails. */
  onBuyFailed?(state: TokenState): void | { rearm?: boolean };
  /** `thenBuy` is strategy_v_011's scalp re-entry. `rearm` keeps strategy_v_022 watching for the next target buy. */
  onSellFill?(state: TokenState): { thenBuy?: boolean; rearm?: boolean };
  /** Sell attempts are exhausted and the position is still open. strategy_v_011 uses this to arm another exit. */
  onSellFailed?(state: TokenState): void;
  onThenBuy?(state: TokenState): Promise<void> | void;
  restoreOpenPosition?(state: TokenState, fillPriceLive: number): void;
  /** `needed` is false once this mint only cares about the target wallet. */
  setPoolTape?(listener: (state: TokenState, needed: boolean, fromSlot?: number) => void): void;
}

export class NoOpStrategy implements Strategy {
  readonly timerMs = 1_000;
  onEvent(): void {}
  onClock(): void {}
}
