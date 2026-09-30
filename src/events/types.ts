/** Post-trade bonding curve from a pump trade event. Enough to quote a buy or sell without another RPC. */
export interface PumpCurveSnapshot {
  virtualQuoteReserves: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint;
  creator: string;
  mayhemMode: boolean;
  quoteMint?: string;
  /** Protocol fee from the trade that produced this snapshot, in basis points. */
  protocolFeeBps: bigint;
  /** Creator fee from that same trade, in basis points. */
  creatorFeeBps: bigint;
  /** Fee account used on that trade. */
  feeRecipient?: string;
  /** Sell must include the user volume account when the coin pays cashback. */
  cashback: boolean;
}

/** Post-trade PumpSwap pool from a buy or sell event. Enough to swap without fetching the pool. */
export interface PumpSwapSnapshot {
  pool: string;
  baseMint: string;
  quoteMint: string;
  poolBaseTokenAccount: string;
  poolQuoteTokenAccount: string;
  baseTokenProgram: string;
  quoteTokenProgram: string;
  baseReserve: bigint;
  quoteReserve: bigint;
  /** Signed reserve offset from the event. */
  virtualQuoteReserves: string;
  lpFeeBps: bigint;
  protocolFeeBps: bigint;
  coinCreatorFeeBps: bigint;
  coinCreator: string;
  protocolFeeRecipient: string;
  buybackFeeRecipient: string;
  cashback: boolean;
}

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
  curve?: PumpCurveSnapshot;
  swap?: PumpSwapSnapshot;
}

export const eventKey = (event: Pick<PoolTradeEvent, "signature" | "eventIndex">): string =>
  `${event.signature}:${event.eventIndex}`;

export const compareEvents = (a: PoolTradeEvent, b: PoolTradeEvent): number =>
  a.slot - b.slot ||
  (a.transactionIndex ?? Number.MAX_SAFE_INTEGER) - (b.transactionIndex ?? Number.MAX_SAFE_INTEGER) ||
  a.eventIndex - b.eventIndex ||
  a.receivedMonoMs - b.receivedMonoMs;
