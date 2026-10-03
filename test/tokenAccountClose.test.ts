import { describe, expect, it } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  WSOL_MINT,
  batchCloseSteps,
  closeInstructions,
  planTokenAccountCloses,
  planTokenSells,
  type TokenAccountSnapshot
} from "../src/cli/tokenAccountClose.js";

const account = (overrides: Partial<TokenAccountSnapshot> = {}): TokenAccountSnapshot => ({
  address: Keypair.generate().publicKey.toBase58(),
  mint: Keypair.generate().publicKey.toBase58(),
  amount: 0n,
  lamports: 2_039_280,
  program: "token",
  frozen: false,
  native: false,
  withheldAmount: 0n,
  ...overrides
});

describe("token sell plan", () => {
  it("sells token balances and leaves wrapped SOL", () => {
    const holding = account({ amount: 10n });
    const wrapped = account({ mint: WSOL_MINT, amount: 50_000_000n, native: true });
    const empty = account();
    const frozen = account({ amount: 5n, frozen: true });
    const plan = planTokenSells([holding, wrapped, empty, frozen]);
    expect(plan.sells.map(item => item.address)).toEqual([holding.address]);
    expect(plan.skipped.map(skip => skip.reason)).toEqual(["wrapped SOL", "frozen"]);
  });
});

describe("token account close plan", () => {
  it("closes empty accounts and unwraps wrapped SOL", () => {
    const empty = account();
    const wrapped = account({ mint: WSOL_MINT, amount: 50_000_000n, native: true, lamports: 52_039_280 });
    const holding = account({ amount: 10n });
    const frozen = account({ frozen: true });
    const plan = planTokenAccountCloses([empty, wrapped, holding, frozen], false);
    expect(plan.steps.map(step => step.kind)).toEqual(["close", "close"]);
    expect(plan.steps.map(step => step.account.address)).toEqual([empty.address, wrapped.address]);
    expect(plan.skipped.map(skip => skip.reason)).toEqual(["balance remaining", "frozen"]);
    expect(plan.reclaimLamports).toBe(BigInt(empty.lamports + wrapped.lamports));
  });

  it("burns a remaining balance only when requested", () => {
    const holding = account({ amount: 10n, program: "token-2022" });
    const plan = planTokenAccountCloses([holding], true);
    expect(plan.steps).toEqual([{ kind: "burn-close", account: holding }]);
    expect(plan.skipped).toEqual([]);
  });

  it("packs close steps into fixed-size batches", () => {
    const steps = [account(), account(), account()].map(row => ({ kind: "close" as const, account: row }));
    expect(batchCloseSteps(steps, 2)).toEqual([steps.slice(0, 2), steps.slice(2)]);
  });

  it("builds burn, harvest, and close instructions", () => {
    const owner = Keypair.generate().publicKey;
    const row = account({ amount: 7n, program: "token-2022", withheldAmount: 3n });
    const instructions = closeInstructions({ kind: "burn-close", account: row }, owner);
    expect(instructions.map(instruction => instruction.programId.toBase58())).toEqual([
      TOKEN_2022_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58(),
      TOKEN_2022_PROGRAM_ID.toBase58()
    ]);
    expect(instructions[0]?.data).toEqual(Buffer.from([26, 4]));
    expect(instructions[1]?.data.readUInt8(0)).toBe(8);
    expect(instructions[1]?.data.readBigUInt64LE(1)).toBe(7n);
    expect(instructions[2]?.data).toEqual(Buffer.from([9]));
    expect(instructions[2]?.keys[1]?.pubkey).toEqual(owner);
    expect(instructions[2]?.programId).toEqual(TOKEN_2022_PROGRAM_ID);
    expect(TOKEN_PROGRAM_ID).toBeInstanceOf(PublicKey);
  });
});
