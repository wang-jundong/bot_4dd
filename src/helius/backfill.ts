import type { PoolTradeEvent } from "../events/types.js";
import type { PoolDescriptor } from "../venues/types.js";
export interface HeliusBackfill {
  fetchPoolTrades(pool: PoolDescriptor, fromMs: number, toMs: number): Promise<readonly PoolTradeEvent[]>;
}
/** Exact enhanced-transaction parsing is venue/schema dependent and injected here. */
export type HeliusTransactionNormalizer = (tx: unknown, pool: PoolDescriptor) => readonly PoolTradeEvent[];
