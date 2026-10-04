import { describe, expect, it } from "vitest";
import { Connection, Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { PUMP_PROGRAM_ID } from "@pump-fun/pump-sdk";
import { PumpBondingCurveAdapter } from "../src/venues/pumpAdapters.js";
import type { PumpCurveSnapshot } from "../src/events/types.js";

const BUY_EXACT_SOL_IN = [56, 252, 116, 8, 158, 223, 205, 95];

describe("pump bonding-curve buy", () => {
  it("spends the exact SOL through buy_exact_sol_in", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "processed");
    const adapter = new PumpBondingCurveAdapter(connection, 100_000, 1, 1);
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const lamports = 400_000_000n;
    const curve: PumpCurveSnapshot = {
      virtualQuoteReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      creator: Keypair.generate().publicKey.toBase58(),
      mayhemMode: false,
      protocolFeeBps: 95n,
      creatorFeeBps: 30n,
      feeRecipient: Keypair.generate().publicKey.toBase58(),
      cashback: false
    };
    adapter.noteCurve(mint.toBase58(), curve);
    const prepared = await adapter.buildBuy({
      descriptor: {
        mint: mint.toBase58(),
        pool: mint.toBase58(),
        programId: PUMP_PROGRAM_ID.toBase58(),
        venue: "pump",
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        relevantAccounts: []
      },
      owner,
      lamports,
      slippageBps: 1200
    });
    const buy = prepared.instructions.at(-1);
    expect(buy?.programId.equals(PUMP_PROGRAM_ID)).toBe(true);
    const data = Buffer.from(buy!.data);
    expect([...data.subarray(0, 8)]).toEqual(BUY_EXACT_SOL_IN);
    expect(data.readBigUInt64LE(8)).toBe(lamports);
    expect(data.readBigUInt64LE(16)).toBeGreaterThan(0n);
  });

  it("keeps the last real fee recipient when a trade event decodes the system program", async () => {
    const connection = new Connection("http://127.0.0.1:8899", "processed");
    const adapter = new PumpBondingCurveAdapter(connection, 100_000, 1, 1);
    const mint = Keypair.generate().publicKey;
    const owner = Keypair.generate().publicKey;
    const good = Keypair.generate().publicKey.toBase58();
    const curve: PumpCurveSnapshot = {
      virtualQuoteReserves: 30_000_000_000n,
      virtualTokenReserves: 1_073_000_000_000_000n,
      realTokenReserves: 793_100_000_000_000n,
      creator: Keypair.generate().publicKey.toBase58(),
      mayhemMode: false,
      protocolFeeBps: 95n,
      creatorFeeBps: 30n,
      feeRecipient: good,
      cashback: false
    };
    const descriptor = {
      mint: mint.toBase58(),
      pool: mint.toBase58(),
      programId: PUMP_PROGRAM_ID.toBase58(),
      venue: "pump" as const,
      tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      relevantAccounts: []
    };
    adapter.noteCurve(mint.toBase58(), curve);
    adapter.noteCurve(mint.toBase58(), { ...curve, feeRecipient: SystemProgram.programId.toBase58() });
    const prepared = await adapter.buildSell({ descriptor, owner, tokenAmount: 1_000_000_000n, slippageBps: 5000 });
    expect(prepared.instructions[0]?.keys[1]?.pubkey.toBase58()).toBe(good);
  });
});
