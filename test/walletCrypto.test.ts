import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  decryptTradingPrivateKey,
  encryptTradingPrivateKey,
  fernetDecrypt,
  fernetEncrypt,
  writeFernetKeyFile,
  xorDecrypt,
  xorEncrypt
} from "../src/security/walletCrypto.js";

describe("walletCrypto (cryptotrading_prod style)", () => {
  it("round-trips XOR obfuscation", () => {
    const plain = bs58.encode(Keypair.generate().secretKey);
    expect(xorDecrypt(xorEncrypt(plain))).toBe(plain);
  });

  it("round-trips Fernet encrypt/decrypt", () => {
    const key = writeFernetKeyFile(join(tmpdir(), `fernet-${Date.now()}.key`));
    const token = fernetEncrypt(key, "hello-sig");
    expect(fernetDecrypt(key, token)).toBe("hello-sig");
  });

  it("encrypts and decrypts a Solana private key via key file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "wallet-crypto-"));
    try {
      const keyFile = join(directory, "solana.key");
      const plain = bs58.encode(Keypair.generate().secretKey);
      const encrypted = encryptTradingPrivateKey(plain, keyFile);
      expect(encrypted.startsWith("gAAAA")).toBe(true);
      expect(decryptTradingPrivateKey(encrypted, keyFile)).toBe(plain);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
