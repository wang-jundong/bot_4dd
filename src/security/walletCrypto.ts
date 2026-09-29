import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";

/** Same XOR pad as cryptotrading_prod `encrypt_util._XOR_KEY`. */
const XOR_KEY = Buffer.from("Djajsl09!2");

function xorBytes(data: Buffer, key: Buffer): Buffer {
  if (key.length === 0) throw new Error("XOR key is empty");
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i]! ^ key[i % key.length]!;
  return out;
}

/** XOR-obfuscate a private key; returns standard base64 (matches prod `xor_encrypt`). */
export function xorEncrypt(privateKey: string): string {
  return xorBytes(Buffer.from(privateKey.trim(), "utf8"), XOR_KEY).toString("base64");
}

/** Reverse of `xorEncrypt` (matches prod `xor_decrypt`). */
export function xorDecrypt(encrypted: string): string {
  return xorBytes(Buffer.from(encrypted.trim(), "base64"), XOR_KEY).toString("utf8");
}

function toUrlSafe(b64: string): string {
  return b64.replace(/\+/g, "-").replace(/\//g, "_");
}

function fromUrlSafe(b64: string): Buffer {
  const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(padded, "base64");
}

/** Generate a Fernet key (url-safe base64 of 32 bytes), same as Python `Fernet.generate_key()`. */
export function generateFernetKey(): Buffer {
  return Buffer.from(toUrlSafe(randomBytes(32).toString("base64")), "utf8");
}

function splitFernetKey(keyMaterial: Buffer): { signingKey: Buffer; encryptionKey: Buffer } {
  const raw = keyMaterial.length === 32 ? keyMaterial : fromUrlSafe(keyMaterial.toString("utf8"));
  if (raw.length !== 32) throw new Error("Fernet key must decode to 32 bytes");
  return { signingKey: raw.subarray(0, 16), encryptionKey: raw.subarray(16, 32) };
}

function readKeyFile(path: string): Buffer {
  if (!existsSync(path)) throw new FileNotFoundError(`Missing wallet key file: ${path}`);
  return readFileSync(path);
}

export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

/** Write a new Fernet key file (creates parent dirs). */
export function writeFernetKeyFile(path: string, key = generateFernetKey()): Buffer {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

/** Fernet-encrypt a UTF-8 string (Python `Fernet.encrypt` compatible). */
export function fernetEncrypt(keyMaterial: Buffer, message: string): string {
  const { signingKey, encryptionKey } = splitFernetKey(keyMaterial);
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", encryptionKey, iv);
  const ciphertext = Buffer.concat([cipher.update(message, "utf8"), cipher.final()]);
  const timestamp = Buffer.alloc(8);
  timestamp.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)));
  const version = Buffer.from([0x80]);
  const basic = Buffer.concat([version, timestamp, iv, ciphertext]);
  const hmac = createHmac("sha256", signingKey).update(basic).digest();
  return toUrlSafe(Buffer.concat([basic, hmac]).toString("base64"));
}

/** Fernet-decrypt a token (Python `Fernet.decrypt` compatible). */
export function fernetDecrypt(keyMaterial: Buffer, token: string): string {
  const { signingKey, encryptionKey } = splitFernetKey(keyMaterial);
  const data = fromUrlSafe(token.trim());
  if (data.length < 1 + 8 + 16 + 32) throw new Error("Invalid Fernet token");
  if (data[0] !== 0x80) throw new Error("Invalid Fernet token version");
  const basic = data.subarray(0, data.length - 32);
  const mac = data.subarray(data.length - 32);
  const expected = createHmac("sha256", signingKey).update(basic).digest();
  if (!timingSafeEqual(mac, expected)) throw new Error("Failed to decrypt sig (wrong key file?)");
  const iv = basic.subarray(9, 25);
  const ciphertext = basic.subarray(25);
  const decipher = createDecipheriv("aes-128-cbc", encryptionKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

/**
 * Encrypt a base58 Solana private key the same way as cryptotrading_prod:
 * plain → XOR → Fernet(key_file).
 */
export function encryptTradingPrivateKey(plainBase58: string, keyFilePath: string): string {
  const key = existsSync(keyFilePath) ? readKeyFile(keyFilePath) : writeFernetKeyFile(keyFilePath);
  return fernetEncrypt(key, xorEncrypt(plainBase58));
}

/**
 * Decrypt trading private key: Fernet(key_file) → XOR → base58 secret.
 */
export function decryptTradingPrivateKey(encrypted: string, keyFilePath: string): string {
  const plainXor = fernetDecrypt(readKeyFile(keyFilePath), encrypted);
  return xorDecrypt(plainXor);
}
