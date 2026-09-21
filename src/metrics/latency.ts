export class LatencyMetrics {
  readonly #marks = new Map<string, number>();
  mark(key: string, monoMs = performance.now()): void { this.#marks.set(key, monoMs); }
  duration(from: string, to: string): number | undefined { const a = this.#marks.get(from), b = this.#marks.get(to); return a === undefined || b === undefined ? undefined : b - a; }
  snapshot(): ReadonlyMap<string, number> { return this.#marks; }
}
