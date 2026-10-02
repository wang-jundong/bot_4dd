import { Keypair, PublicKey, type VersionedTransactionResponse } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { ownerWalletSolAbsDelta } from "../src/venues/pumpAdapters.js";

const owner = Keypair.generate().publicKey;
const other = PublicKey.default;

function tx(pre: number, post: number, includeOwner = true): VersionedTransactionResponse {
  return {
    meta: { err: null, fee: 105_001, preBalances: [pre, 1], postBalances: [post, 1] },
    transaction: {
      message: {
        staticAccountKeys: includeOwner ? [owner, other] : [other, other]
      }
    }
  } as unknown as VersionedTransactionResponse;
}

describe("ownerWalletSolAbsDelta", () => {
  it("returns absolute SOL spent on a buy (fees and tips included)", () => {
    expect(ownerWalletSolAbsDelta(tx(5_000_000_000, 4_605_749_961), owner)).toBe(394_250_039n);
  });

  it("returns absolute SOL received on a sell", () => {
    expect(ownerWalletSolAbsDelta(tx(4_000_000_000, 4_267_441_401), owner)).toBe(267_441_401n);
  });

  it("returns undefined when the owner is missing from the message", () => {
    expect(ownerWalletSolAbsDelta(tx(1, 2, false), owner)).toBeUndefined();
  });
});
