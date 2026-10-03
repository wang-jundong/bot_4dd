import { ComputeBudgetProgram, Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { loadConfig } from "../config/index.js";
import {
  batchCloseSteps,
  closeInstructions,
  loadTokenAccounts,
  planTokenAccountCloses,
  priorityFeeMicroLamports,
  type CloseStep,
  type TokenAccountSnapshot
} from "./tokenAccountClose.js";

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`Close token accounts owned by each strategy wallet and return their rent.

Usage:
  npm run close-accounts
  npm run close-accounts -- --dry-run
  npm run close-accounts -- --burn

Empty accounts are closed. Wrapped SOL is unwrapped back to the wallet.
Accounts that still hold tokens are skipped unless --burn is set.
--burn destroys the remaining token balance, then closes the account.
Wallets come from the strategies selected in src/config/trade.ts.`);
  process.exit(0);
}

const unknown = [...args].filter(arg => arg !== "--burn" && arg !== "--dry-run");
if (unknown.length > 0) {
  console.error(`Unknown argument: ${unknown.join(", ")}`);
  process.exitCode = 1;
} else {
  const burn = args.has("--burn");
  const dryRun = args.has("--dry-run");
  const config = loadConfig();
  const connection = new Connection(config.HELIUS_RPC_URL, "confirmed");
  let failed = 0;
  for (const wallet of tradingWallets(config.strategyPlans)) {
    const owner = wallet.keypair.publicKey;
    const accounts = await loadTokenAccounts(connection, owner);
    const plan = planTokenAccountCloses(accounts, burn);
    console.log({
      strategies: wallet.names,
      wallet: owner.toBase58(),
      tokenAccounts: accounts.length,
      closing: plan.steps.length,
      skipped: plan.skipped.length,
      reclaimSol: formatSol(plan.reclaimLamports),
      burn,
      dryRun
    });
    for (const step of plan.steps) console.log(describeStep(step));
    for (const skip of plan.skipped) {
      console.log(`skip ${skip.account.address} mint=${skip.account.mint} amount=${skip.account.amount} reason=${skip.reason}`);
    }
    if (!dryRun && plan.steps.length > 0) {
      for (const batch of batchCloseSteps(plan.steps)) {
        try {
          const signature = await sendBatch(connection, wallet.keypair, batch, config.COMPUTE_UNIT_LIMIT, config.PRIORITY_FEE_LAMPORTS);
          console.log({ ok: true, signature, accounts: batch.map(step => step.account.address) });
        } catch (error) {
          failed += 1;
          console.error({ ok: false, accounts: batch.map(step => step.account.address), error: error instanceof Error ? error.message : String(error) });
        }
      }
    }
  }
  if (failed > 0) process.exitCode = 1;
}

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

async function sendBatch(
  connection: Connection,
  owner: { publicKey: PublicKey; secretKey: Uint8Array },
  batch: readonly CloseStep[],
  computeUnitLimit: number,
  priorityFeeLamports: number
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  const units = Math.max(computeUnitLimit, 60_000 * batch.length);
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFeeMicroLamports(priorityFeeLamports, units) }),
    ...batch.flatMap(step => closeInstructions(step, owner.publicKey))
  ];
  const transaction = new VersionedTransaction(new TransactionMessage({
    payerKey: owner.publicKey,
    recentBlockhash: blockhash,
    instructions
  }).compileToV0Message());
  transaction.sign([owner]);
  const signature = await connection.sendTransaction(transaction, { skipPreflight: false, maxRetries: 3 });
  const confirmation = await connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed");
  if (confirmation.value.err) throw new Error(`Transaction ${signature} failed: ${JSON.stringify(confirmation.value.err)}`);
  return signature;
}

function describeStep(step: CloseStep): string {
  const { account } = step;
  const action = step.kind === "burn-close" ? "burn+close" : account.native && account.amount > 0n ? "unwrap" : "close";
  return `${action} ${account.address} mint=${account.mint} amount=${account.amount} rentSol=${formatSol(BigInt(account.lamports))}`;
}

function formatSol(lamports: bigint): string {
  const negative = lamports < 0n;
  const absolute = negative ? -lamports : lamports;
  const fraction = (absolute % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  const text = fraction ? `${absolute / 1_000_000_000n}.${fraction}` : `${absolute / 1_000_000_000n}`;
  return negative ? `-${text}` : text;
}
