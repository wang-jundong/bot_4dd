import { NATIVE_MINT } from "@solana/spl-token";
import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, type TransactionInstruction } from "@solana/web3.js";
import BN from "bn.js";
import {
  getSellSolAmountFromTokenAmount,
  OnlinePumpSdk,
  PUMP_SDK,
  canonicalPumpPoolPda,
  type BondingCurve,
  type FeeConfig,
  type Global
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import { loadConfig } from "../config/index.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  loadTokenAccounts,
  planTokenSells,
  priorityFeeMicroLamports,
  type TokenAccountSnapshot
} from "./tokenAccountClose.js";

const SELL_COMPUTE_UNITS = 400_000;

const help = process.argv.includes("--help") || process.argv.includes("-h");
if (help) {
  console.log(`Sell every pump token each strategy wallet still holds.

Usage:
  npm run sell-all
  npm run sell-all -- --dry-run
  npm run sell-all -- --mint <mint>

A bonding-curve coin sells on pump. A migrated coin sells on pumpswap.
Wrapped SOL is left alone. A mint with no pump curve is skipped.
Slippage comes from the shared sell slippage in src/config/trade.ts.
Wallets come from the strategies selected in src/config/trade.ts.`);
  process.exit(0);
}

const options = readOptions(process.argv.slice(2));
const config = loadConfig();
const connection = new Connection(config.HELIUS_RPC_URL, "confirmed");
const wallets = tradingWallets(config.strategyPlans);
const loaded = [];
for (const wallet of wallets) {
  const accounts = await loadTokenAccounts(connection, wallet.keypair.publicKey);
  const plan = planTokenSells(accounts);
  const sells = options.mints.size === 0 ? plan.sells : plan.sells.filter(account => options.mints.has(account.mint));
  loaded.push({ wallet, plan, sells });
}
const held = new Set(loaded.flatMap(item => item.sells.map(account => account.mint)));
const missing = [...options.mints].filter(mint => !held.has(mint));

console.log({
  wallets: wallets.map(wallet => ({ strategies: wallet.names, wallet: wallet.keypair.publicKey.toBase58() })),
  selling: loaded.reduce((sum, item) => sum + item.sells.length, 0),
  skipped: loaded.reduce((sum, item) => sum + item.plan.skipped.length, 0),
  slippageBps: config.sellSlippageBps,
  dryRun: options.dryRun
});
for (const item of loaded) {
  for (const skip of item.plan.skipped) {
    console.log(`skip ${skip.account.mint} wallet=${item.wallet.keypair.publicKey.toBase58()} amount=${skip.account.amount} reason=${skip.reason}`);
  }
}
for (const mint of missing) console.error(`skip ${mint} reason=not held`);

const curveSdk = new OnlinePumpSdk(connection);
const ammSdk = new OnlinePumpAmmSdk(connection);
const anySells = loaded.some(item => item.sells.length > 0);
const [global, feeConfig] = anySells ? await Promise.all([curveSdk.fetchGlobal(), curveSdk.fetchFeeConfig()]) : [undefined, undefined];
let failed = missing.length;
for (const item of loaded) {
  for (const account of item.sells) {
    try {
      const result = await sellAccount(connection, item.wallet.keypair, account, config.sellSlippageBps, config.PRIORITY_FEE_LAMPORTS, options.dryRun, curveSdk, ammSdk, global!, feeConfig ?? null);
      if (result.kind === "skip") {
        console.log(`skip ${account.mint} wallet=${item.wallet.keypair.publicKey.toBase58()} amount=${account.amount} reason=${result.reason}`);
        if (options.mints.has(account.mint)) failed += 1;
        continue;
      }
      if (result.signature) console.log({ ok: true, mint: account.mint, wallet: item.wallet.keypair.publicKey.toBase58(), signature: result.signature });
    } catch (error) {
      failed += 1;
      console.error({ ok: false, mint: account.mint, wallet: item.wallet.keypair.publicKey.toBase58(), error: error instanceof Error ? error.message : String(error) });
    }
  }
}
if (failed > 0) process.exitCode = 1;

function tradingWallets(plans: readonly { name: string; keypair: Keypair }[]): Array<{ names: string[]; keypair: Keypair }> {
  const wallets: Array<{ names: string[]; keypair: Keypair }> = [];
  for (const plan of plans) {
    const address = plan.keypair.publicKey.toBase58();
    const existing = wallets.find(wallet => wallet.keypair.publicKey.toBase58() === address);
    if (existing) existing.names.push(plan.name);
    else wallets.push({ names: [plan.name], keypair: plan.keypair });
  }
  return wallets;
}

function readOptions(argv: readonly string[]): { dryRun: boolean; mints: Set<string> } {
  try {
    return readArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function readArgs(argv: readonly string[]): { dryRun: boolean; mints: Set<string> } {
  const mints = new Set<string>();
  let dryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg === "--mint") {
      const value = argv[index + 1];
      if (!value) throw new Error("--mint needs a mint address");
      mints.add(new PublicKey(value).toBase58());
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { dryRun, mints };
}

async function sellAccount(
  connection: Connection,
  owner: { publicKey: PublicKey; secretKey: Uint8Array },
  account: TokenAccountSnapshot,
  slippageBps: number,
  priorityFeeLamports: number,
  dryRun: boolean,
  curveSdk: OnlinePumpSdk,
  ammSdk: OnlinePumpAmmSdk,
  global: Global,
  feeConfig: FeeConfig | null
): Promise<{ kind: "sent"; signature?: string } | { kind: "skip"; reason: string }> {
  const mint = new PublicKey(account.mint);
  const tokenProgram = account.program === "token-2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  let curve: BondingCurve;
  try {
    curve = await curveSdk.fetchBondingCurve(mint);
  } catch {
    return { kind: "skip", reason: "no pump bonding curve" };
  }
  if (!isSolQuote(curve.quoteMint)) return { kind: "skip", reason: `quote mint ${curve.quoteMint.toBase58()} is not SOL` };
  const amount = new BN(account.amount.toString());
  const instructions = curve.complete
    ? await ammSell(ammSdk, owner.publicKey, mint, amount, slippageBps)
    : await curveSell(owner.publicKey, mint, tokenProgram, amount, curve, global, feeConfig, slippageBps);
  const venue = curve.complete ? "pumpswap" : "pump";
  console.log(`sell ${account.mint} wallet=${owner.publicKey.toBase58()} amount=${account.amount} venue=${venue}${dryRun ? " dry-run" : ""}`);
  if (dryRun) return { kind: "sent" };
  return { kind: "sent", signature: await sendSell(connection, owner, instructions, priorityFeeLamports) };
}

async function curveSell(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgram: PublicKey,
  amount: BN,
  curve: BondingCurve,
  global: Global,
  feeConfig: FeeConfig | null,
  slippageBps: number
) {
  const solOut = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: curve.tokenTotalSupply,
    bondingCurve: curve,
    amount
  });
  const slippage = slippageBps / 100;
  const minSol = solOut.sub(solOut.muln(Math.floor(slippage * 10)).divn(1_000));
  return [
    await PUMP_SDK.getSellInstructionRaw({
      user: owner,
      mint,
      creator: curve.creator,
      amount,
      solAmount: minSol.isNeg() ? new BN(0) : minSol,
      tokenProgram,
      cashback: curve.isCashbackCoin
    } as Parameters<typeof PUMP_SDK.getSellInstructionRaw>[0])
  ];
}

async function ammSell(ammSdk: OnlinePumpAmmSdk, owner: PublicKey, mint: PublicKey, amount: BN, slippageBps: number) {
  const pool = canonicalPumpPoolPda(mint);
  const state = await ammSdk.swapSolanaState(pool, owner);
  return PUMP_AMM_SDK.sellBaseInput(state, amount, slippageBps / 100);
}

function isSolQuote(quote: PublicKey | undefined): boolean {
  return quote === undefined || quote.equals(NATIVE_MINT) || quote.equals(PublicKey.default);
}

async function sendSell(
  connection: Connection,
  owner: { publicKey: PublicKey; secretKey: Uint8Array },
  sellInstructions: readonly TransactionInstruction[],
  priorityFeeLamports: number
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: owner.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: SELL_COMPUTE_UNITS }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports(priorityFeeLamports, SELL_COMPUTE_UNITS) }),
      ...sellInstructions
    ]
  }).compileToV0Message());
  transaction.sign([owner]);
  const signature = await connection.sendTransaction(transaction, { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}
