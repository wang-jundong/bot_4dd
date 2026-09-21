export const LAMPORTS_PER_SOL_BIGINT = 1_000_000_000n;

export function solToLamports(value: string): bigint {
  if (!/^\d+(\.\d{1,9})?$/.test(value)) throw new Error("SOL value must be a non-negative decimal with <=9 places");
  const [whole = "0", fraction = ""] = value.split(".");
  return BigInt(whole) * LAMPORTS_PER_SOL_BIGINT + BigInt(fraction.padEnd(9, "0"));
}
