export function entryMarketCapSol(price: number): number {
  return price * 1_000_000;
}

export function isEntryMarketCapAllowed(price: number, maxMarketCapSol: number): boolean {
  return entryMarketCapSol(price) < maxMarketCapSol;
}
