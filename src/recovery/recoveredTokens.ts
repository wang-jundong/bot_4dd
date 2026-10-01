/**
 * Split a wallet balance across strategy positions.
 * A recorded amount is capped by what is left after the other strategies' recorded bags.
 * An unknown amount receives only that leftover, and only when every other open bag on the mint is known.
 */
export function allocateRecoveredTokens(recorded: bigint, wallet: bigint, otherRecorded: bigint, otherUnknown: number): bigint {
  if (recorded < 0n || wallet <= 0n) return 0n;
  if (recorded === 0n && otherUnknown > 0) return 0n;
  const reserved = otherRecorded > 0n ? otherRecorded : 0n;
  const available = wallet > reserved ? wallet - reserved : 0n;
  if (recorded > 0n) return recorded < available ? recorded : available;
  return available;
}
