export function isNonRetryableBuyError(error: unknown, venue: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (venue === "pump" && message.includes('"Custom":6002')) ||
    (venue === "pumpswap" && message.includes('"Custom":6004'));
}

export function retryEntryDeviationPct(entrySignalPrice: number, latestPrice: number): number {
  return (latestPrice / entrySignalPrice - 1) * 100;
}
