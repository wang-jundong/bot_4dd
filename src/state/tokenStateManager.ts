import type { PoolDescriptor, VenueAdapter } from "../venues/types.js";
import type { PoolTradeEvent } from "../events/types.js";
import { TokenState } from "./tokenState.js";
export const poolKey = (p: Pick<PoolDescriptor, "programId" | "pool">): string => `${p.programId}:${p.pool}`;
export class TokenStateManager {
  readonly #states = new Map<string, TokenState>();
  constructor(private readonly retentionMs: number) {}
  create(descriptor: PoolDescriptor, adapter: VenueAdapter, buy: PoolTradeEvent): TokenState {
    const key = poolKey(descriptor); const existing = this.#states.get(key); if (existing) return existing;
    const state = new TokenState(descriptor, adapter, buy, this.retentionMs); this.#states.set(key, state); return state;
  }
  get(descriptor: Pick<PoolDescriptor, "programId" | "pool">): TokenState | undefined { return this.#states.get(poolKey(descriptor)); }
  delete(descriptor: Pick<PoolDescriptor, "programId" | "pool">): boolean { return this.#states.delete(poolKey(descriptor)); }
  values(): IterableIterator<TokenState> { return this.#states.values(); }
}
