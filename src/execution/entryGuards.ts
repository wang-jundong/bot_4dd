export function entryDeviationPct(actualFillPrice: number, entrySignalPrice: number): number {
  return (actualFillPrice / entrySignalPrice - 1) * 100;
}

export function entryMarketCapSol(price: number): number {
  return price * 1_000_000;
}

export function isEntryMarketCapAllowed(price: number, maxMarketCapSol: number): boolean {
  return entryMarketCapSol(price) < maxMarketCapSol;
}
