import type { JournalRecord } from "../recovery/journal.js";

const SCALE = 1_000_000n;

export class LossStreakPositionSizer {
  #lossStreak = 0;
  readonly #multiplierScaled: bigint;

  constructor(
    private readonly defaultBuyLamports: bigint,
    private readonly enabled: boolean,
    private readonly lossStreakThreshold: number,
    multiplier: number
  ) {
    this.#multiplierScaled = BigInt(Math.round(multiplier * Number(SCALE)));
  }

  get lossStreak(): number { return this.#lossStreak; }
  get reduced(): boolean { return this.enabled && this.#lossStreak >= this.lossStreakThreshold; }

  currentBuyLamports(): bigint {
    if (!this.reduced) return this.defaultBuyLamports;
    const reduced = this.defaultBuyLamports * this.#multiplierScaled / SCALE;
    return reduced > 0n ? reduced : 1n;
  }

  recordClosedPosition(entryPrice: number | undefined, exitPrice: number | undefined): void {
    if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || !entryPrice || !exitPrice) return;
    if (exitPrice > entryPrice) this.#lossStreak = 0;
    else if (exitPrice < entryPrice) this.#lossStreak++;
  }

  restore(records: readonly JournalRecord[]): void {
    this.#lossStreak = 0;
    for (const record of records) {
      if (record.event !== "position_closed") continue;
      this.recordClosedPosition(record.prices?.actualEntryFillPrice, record.prices?.actualExitFillPrice ?? record.fill?.price);
    }
  }
}
