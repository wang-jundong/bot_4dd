import { compareEvents, eventKey, type PoolTradeEvent } from "../events/types.js";

export class EventBuffer {
  readonly #events: PoolTradeEvent[] = [];
  readonly #keys = new Set<string>();
  constructor(private readonly retentionMs: number) {}
  add(event: PoolTradeEvent): boolean {
    const key = eventKey(event);
    if (this.#keys.has(key)) return false;
    this.#keys.add(key);
    const last = this.#events.at(-1);
    if (!last || compareEvents(last, event) <= 0) this.#events.push(event);
    else {
      let lo = 0, hi = this.#events.length;
      while (lo < hi) { const mid = (lo + hi) >>> 1; if (compareEvents(this.#events[mid]!, event) <= 0) lo = mid + 1; else hi = mid; }
      this.#events.splice(lo, 0, event);
    }
    this.prune(event.timestampMs - this.retentionMs);
    return true;
  }
  prune(beforeMs: number): void {
    let count = 0;
    while (count < this.#events.length && this.#events[count]!.timestampMs < beforeMs) {
      this.#keys.delete(eventKey(this.#events[count]!)); count++;
    }
    if (count) this.#events.splice(0, count);
  }
  values(): readonly PoolTradeEvent[] { return this.#events; }
}
