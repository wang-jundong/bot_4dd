export interface PoolTradeEvent {
  signature: string;
  slot: number;
  transactionIndex?: number;
  eventIndex: number;
  timestampMs: number;
  receivedMonoMs: number;
  mint: string;
  pool: string;
  programId: string;
  trader: string;
  side: "buy" | "sell";
  solAmount: bigint;
  tokenAmount: bigint;
  price: number;
  curveProgress?: number;
}

export const eventKey = (event: Pick<PoolTradeEvent, "signature" | "eventIndex">): string =>
  `${event.signature}:${event.eventIndex}`;

export const compareEvents = (a: PoolTradeEvent, b: PoolTradeEvent): number =>
  a.slot - b.slot ||
  (a.transactionIndex ?? Number.MAX_SAFE_INTEGER) - (b.transactionIndex ?? Number.MAX_SAFE_INTEGER) ||
  a.eventIndex - b.eventIndex ||
  a.receivedMonoMs - b.receivedMonoMs;
