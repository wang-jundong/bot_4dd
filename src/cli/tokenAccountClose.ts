import { Connection, PublicKey, type TransactionInstruction } from "@solana/web3.js";

export const TOKEN_PROGRAM_ID = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
export const TOKEN_2022_PROGRAM_ID = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

const BURN = 8;
const CLOSE_ACCOUNT = 9;
const TOKEN_2022_TRANSFER_FEE = 26;
const HARVEST_WITHHELD_TO_MINT = 4;

export interface TokenAccountSnapshot {
  address: string;
  mint: string;
  amount: bigint;
  lamports: number;
  program: "token" | "token-2022";
  frozen: boolean;
  native: boolean;
  withheldAmount: bigint;
}

export type CloseStep =
  | { kind: "close"; account: TokenAccountSnapshot }
  | { kind: "burn-close"; account: TokenAccountSnapshot };

export interface ClosePlan {
  steps: CloseStep[];
  skipped: Array<{ account: TokenAccountSnapshot; reason: string }>;
  reclaimLamports: bigint;
}

export interface SellPlan {
  sells: TokenAccountSnapshot[];
  skipped: Array<{ account: TokenAccountSnapshot; reason: string }>;
}

/** Non-zero token balances. Wrapped SOL is left for the close-accounts command. */
export function planTokenSells(accounts: readonly TokenAccountSnapshot[]): SellPlan {
  const sells: TokenAccountSnapshot[] = [];
  const skipped: SellPlan["skipped"] = [];
  for (const account of accounts) {
    if (account.amount === 0n) continue;
    if (account.native || account.mint === WSOL_MINT) {
      skipped.push({ account, reason: "wrapped SOL" });
      continue;
    }
    if (account.frozen) {
      skipped.push({ account, reason: "frozen" });
      continue;
    }
    sells.push(account);
  }
  return { sells, skipped };
}

export async function loadTokenAccounts(connection: Connection, owner: PublicKey): Promise<TokenAccountSnapshot[]> {
  const [classic, token2022] = await Promise.all([
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }),
    connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })
  ]);
  return [
    ...classic.value.map(account => parseTokenAccount(account, "token")),
    ...token2022.value.map(account => parseTokenAccount(account, "token-2022"))
  ];
}

export function planTokenAccountCloses(accounts: readonly TokenAccountSnapshot[], burn: boolean): ClosePlan {
  const steps: CloseStep[] = [];
  const skipped: ClosePlan["skipped"] = [];
  for (const account of accounts) {
    if (account.frozen) {
      skipped.push({ account, reason: "frozen" });
      continue;
    }
    if (account.native || account.amount === 0n) {
      steps.push({ kind: "close", account });
      continue;
    }
    if (burn) {
      steps.push({ kind: "burn-close", account });
      continue;
    }
    skipped.push({ account, reason: "balance remaining" });
  }
  const reclaimLamports = steps.reduce((sum, step) => sum + BigInt(step.account.lamports), 0n);
  return { steps, skipped, reclaimLamports };
}

export function batchCloseSteps(steps: readonly CloseStep[], maxSteps = 4): CloseStep[][] {
  if (maxSteps < 1) throw new Error("maxSteps must be positive");
  const batches: CloseStep[][] = [];
  for (let index = 0; index < steps.length; index += maxSteps) batches.push(steps.slice(index, index + maxSteps));
  return batches;
}

export function closeInstructions(step: CloseStep, owner: PublicKey): TransactionInstruction[] {
  const programId = step.account.program === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const account = new PublicKey(step.account.address);
  const mint = new PublicKey(step.account.mint);
  const instructions: TransactionInstruction[] = [];
  if (step.account.withheldAmount > 0n) instructions.push(harvestWithheldToMint(mint, account, programId));
  if (step.kind === "burn-close") instructions.push(burn(account, mint, owner, step.account.amount, programId));
  instructions.push(closeAccount(account, owner, owner, programId));
  return instructions;
}

export function priorityFeeMicroLamports(priorityFeeLamports: number, computeUnitLimit: number): number {
  return Math.ceil(priorityFeeLamports * 1_000_000 / computeUnitLimit);
}

interface ParsedTokenInfo {
  mint?: string;
  state?: string;
  isNative?: boolean | number;
  tokenAmount?: { amount?: string };
  extensions?: Array<{ extension?: string; state?: { withheldAmount?: number | string } }>;
}

function parseTokenAccount(
  account: { pubkey: PublicKey; account: { lamports: number; data: unknown } },
  program: TokenAccountSnapshot["program"]
): TokenAccountSnapshot {
  const parsed = account.account.data as { parsed?: { info?: ParsedTokenInfo } };
  const info = parsed.parsed?.info;
  if (!info?.mint || !info.tokenAmount?.amount) throw new Error(`Unparsed token account ${account.pubkey.toBase58()}`);
  const withheld = info.extensions?.find(extension => extension.extension === "transferFeeAmount");
  const withheldRaw = withheld?.state?.withheldAmount;
  return {
    address: account.pubkey.toBase58(),
    mint: info.mint,
    amount: BigInt(info.tokenAmount.amount),
    lamports: account.account.lamports,
    program,
    frozen: info.state === "frozen",
    native: Boolean(info.isNative) || info.mint === WSOL_MINT,
    withheldAmount: withheldRaw ? BigInt(withheldRaw) : 0n
  };
}

function burn(account: PublicKey, mint: PublicKey, owner: PublicKey, amount: bigint, programId: PublicKey): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(BURN, 0);
  data.writeBigUInt64LE(amount, 1);
  return {
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data
  };
}

function closeAccount(account: PublicKey, destination: PublicKey, owner: PublicKey, programId: PublicKey): TransactionInstruction {
  return {
    programId,
    keys: [
      { pubkey: account, isSigner: false, isWritable: true },
      { pubkey: destination, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false }
    ],
    data: Buffer.from([CLOSE_ACCOUNT])
  };
}

function harvestWithheldToMint(mint: PublicKey, account: PublicKey, programId: PublicKey): TransactionInstruction {
  return {
    programId,
    keys: [
      { pubkey: mint, isSigner: false, isWritable: true },
      { pubkey: account, isSigner: false, isWritable: true }
    ],
    data: Buffer.from([TOKEN_2022_TRANSFER_FEE, HARVEST_WITHHELD_TO_MINT])
  };
}
