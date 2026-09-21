export enum TokenLifecycleState {
  TARGET_BUY_DETECTED = "TARGET_BUY_DETECTED", TRACKING_POOL = "TRACKING_POOL",
  TARGET_SELL_DETECTED = "TARGET_SELL_DETECTED", CONFIRMING_REVERSAL = "CONFIRMING_REVERSAL",
  BUY_PREPARED = "BUY_PREPARED", BUY_SENT = "BUY_SENT", BUY_PROCESSED = "BUY_PROCESSED",
  POSITION_ACTIVE_UNCONFIRMED = "POSITION_ACTIVE_UNCONFIRMED", BUY_CONFIRMED = "BUY_CONFIRMED",
  POSITION_ACTIVE_CONFIRMED = "POSITION_ACTIVE_CONFIRMED", SELL_PREPARED = "SELL_PREPARED",
  SELL_SENT = "SELL_SENT", REENTRY_WAITING = "REENTRY_WAITING", CLOSED = "CLOSED", FAILED = "FAILED"
}
export function canQualifyTargetSell(state: TokenLifecycleState): boolean {
  return state === TokenLifecycleState.TRACKING_POOL;
}
const allowed: Record<TokenLifecycleState, ReadonlySet<TokenLifecycleState>> = {
  TARGET_BUY_DETECTED: new Set([TokenLifecycleState.TRACKING_POOL, TokenLifecycleState.FAILED]),
  TRACKING_POOL: new Set([TokenLifecycleState.TARGET_SELL_DETECTED, TokenLifecycleState.FAILED]),
  TARGET_SELL_DETECTED: new Set([TokenLifecycleState.CONFIRMING_REVERSAL, TokenLifecycleState.TRACKING_POOL, TokenLifecycleState.FAILED]),
  CONFIRMING_REVERSAL: new Set([TokenLifecycleState.BUY_PREPARED, TokenLifecycleState.TRACKING_POOL, TokenLifecycleState.FAILED]),
  BUY_PREPARED: new Set([TokenLifecycleState.BUY_SENT, TokenLifecycleState.TRACKING_POOL, TokenLifecycleState.FAILED]),
  BUY_SENT: new Set([TokenLifecycleState.BUY_PROCESSED, TokenLifecycleState.FAILED]),
  BUY_PROCESSED: new Set([TokenLifecycleState.POSITION_ACTIVE_UNCONFIRMED, TokenLifecycleState.FAILED]),
  POSITION_ACTIVE_UNCONFIRMED: new Set([TokenLifecycleState.BUY_CONFIRMED, TokenLifecycleState.SELL_PREPARED, TokenLifecycleState.FAILED]),
  BUY_CONFIRMED: new Set([TokenLifecycleState.POSITION_ACTIVE_CONFIRMED, TokenLifecycleState.FAILED]),
  POSITION_ACTIVE_CONFIRMED: new Set([TokenLifecycleState.SELL_PREPARED, TokenLifecycleState.SELL_SENT, TokenLifecycleState.FAILED]),
  SELL_PREPARED: new Set([TokenLifecycleState.BUY_CONFIRMED, TokenLifecycleState.POSITION_ACTIVE_CONFIRMED, TokenLifecycleState.SELL_SENT, TokenLifecycleState.FAILED]),
  SELL_SENT: new Set([TokenLifecycleState.REENTRY_WAITING, TokenLifecycleState.CLOSED, TokenLifecycleState.FAILED]),
  REENTRY_WAITING: new Set([TokenLifecycleState.BUY_PREPARED, TokenLifecycleState.CLOSED, TokenLifecycleState.FAILED]),
  CLOSED: new Set(), FAILED: new Set()
};
export function assertTransition(from: TokenLifecycleState, to: TokenLifecycleState): void {
  if (!allowed[from].has(to)) throw new Error(`invalid lifecycle transition ${from} -> ${to}`);
}
