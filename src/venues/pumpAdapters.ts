import BN from "bn.js";
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type TransactionInstruction, type VersionedTransactionResponse
} from "@solana/web3.js";
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  bondingCurveV2Pda, creatorVaultPda,
  getPumpAmmProgram, getPumpProgram,
  PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK
} from "@pump-fun/pump-sdk";
import { PUMP_AMM_SDK, type SwapSolanaState } from "@pump-fun/pump-swap-sdk";
import type { PumpCurveSnapshot, PumpSwapSnapshot } from "../events/types.js";
import type {
  BuildBuyArgs, BuildSellArgs, FillResult, ParsedTargetTransaction, ParsedTrade,
  PreparedTradeTransaction, VenueAdapter
} from "./types.js";

/** Tokens out for `buy_exact_sol_in`: fees come out of `spendableSolIn`, then the curve quote. */
function quoteBuyTokens(solAmount: BN, curve: PumpCurveSnapshot): BN {
  if (solAmount.isZero()) return new BN(0);
  const virtualToken = new BN(curve.virtualTokenReserves.toString());
  if (virtualToken.isZero()) return new BN(0);
  const creatorFeeBps = curve.creator === PublicKey.default.toBase58() ? 0n : curve.creatorFeeBps;
  const totalFeeBps = new BN((curve.protocolFeeBps + creatorFeeBps).toString());
  let netSol = solAmount.muln(10_000).div(totalFeeBps.addn(10_000));
  const fees = ceilFee(netSol, curve.protocolFeeBps).add(creatorFeeBps === 0n ? new BN(0) : ceilFee(netSol, creatorFeeBps));
  const over = netSol.add(fees).sub(solAmount);
  if (over.gtn(0)) netSol = netSol.sub(over);
  if (netSol.lten(1)) return new BN(0);
  const net = netSol.subn(1);
  const tokens = net.mul(virtualToken).div(new BN(curve.virtualQuoteReserves.toString()).add(net));
  const realToken = new BN(curve.realTokenReserves.toString());
  return tokens.lt(realToken) ? tokens : realToken;
}

function minTokensOut(quoted: BN, slippageBps: number): BN {
  const slippage = slippageBps / 100;
  const haircut = quoted.muln(Math.floor(slippage * 10)).divn(1_000);
  const min = quoted.sub(haircut);
  return min.isNeg() ? new BN(0) : min;
}

function quoteSellSol(tokenAmount: BN, curve: PumpCurveSnapshot): BN {
  if (tokenAmount.isZero()) return new BN(0);
  const virtualToken = new BN(curve.virtualTokenReserves.toString());
  if (virtualToken.isZero()) return new BN(0);
  const solCost = tokenAmount.mul(new BN(curve.virtualQuoteReserves.toString())).div(virtualToken.add(tokenAmount));
  const creatorFee = curve.creator === PublicKey.default.toBase58() ? 0n : curve.creatorFeeBps;
  const net = solCost.sub(ceilFee(solCost, curve.protocolFeeBps)).sub(ceilFee(solCost, creatorFee));
  return net.isNeg() ? new BN(0) : net;
}

function ceilFee(amount: BN, feeBps: bigint): BN {
  if (feeBps <= 0n) return new BN(0);
  const bps = new BN(feeBps.toString());
  return amount.mul(bps).addn(9_999).div(new BN(10_000));
}

const HELIUS_TIP_ACCOUNTS = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta"
].map(address => new PublicKey(address));

class SdkPreparedTransaction implements PreparedTradeTransaction {
  readonly signers: readonly PublicKey[] = [];
  constructor(
    readonly instructions: readonly TransactionInstruction[], private readonly payer: PublicKey,
    private readonly computeUnitLimit: number, private readonly priorityFeeLamports: number, private readonly tipLamports: number
  ) {}
  compile(blockhash: string): VersionedTransaction {
    const microLamports = Math.ceil(this.priorityFeeLamports * 1_000_000 / this.computeUnitLimit);
    const instructions = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: this.computeUnitLimit }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports }),
      SystemProgram.transfer({ fromPubkey: this.payer, toPubkey: HELIUS_TIP_ACCOUNTS[Math.floor(Math.random() * HELIUS_TIP_ACCOUNTS.length)]!, lamports: this.tipLamports }),
      ...this.instructions
    ];
    return new VersionedTransaction(new TransactionMessage({ payerKey: this.payer, recentBlockhash: blockhash, instructions }).compileToV0Message());
  }
}

/** Absolute SOL spent/received by `owner` from confirmed tx meta (fees + tips included). No RPC. */
export function ownerWalletSolAbsDelta(tx: VersionedTransactionResponse, owner: PublicKey): bigint | undefined {
  if (!tx.meta) return undefined;
  const ownerIndex = tx.transaction.message.staticAccountKeys.findIndex(key => key.equals(owner));
  if (ownerIndex < 0) return undefined;
  const solDelta = BigInt(tx.meta.postBalances[ownerIndex] ?? 0) - BigInt(tx.meta.preBalances[ownerIndex] ?? 0);
  return solDelta < 0n ? -solDelta : solDelta;
}

abstract class PumpAdapterBase implements VenueAdapter {
  abstract readonly name: string;
  abstract readonly programId: PublicKey;
  constructor(protected readonly connection: Connection, private readonly computeUnitLimit: number, private readonly priorityFeeLamports: number, private readonly tipLamports: number) {}
  canHandle(tx: ParsedTargetTransaction): boolean { return tx.programIds.includes(this.programId.toBase58()); }
  parseTargetTrade(_tx: ParsedTargetTransaction): ParsedTrade | undefined { return undefined; }
  protected prepared(instructions: readonly TransactionInstruction[], owner: PublicKey): PreparedTradeTransaction {
    return new SdkPreparedTransaction(instructions, owner, this.computeUnitLimit, this.priorityFeeLamports, this.tipLamports);
  }
  parseFill(tx: unknown, owner: PublicKey, mint: string): FillResult {
    const parsed = tx as VersionedTransactionResponse;
    if (!parsed.meta || parsed.meta.err) return { tokenAmount: 0n, solAmount: 0n, price: 0, success: false };
    const preToken = parsed.meta.preTokenBalances?.filter(balance => balance.owner === owner.toBase58() && balance.mint === mint)
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n) ?? 0n;
    const postToken = parsed.meta.postTokenBalances?.filter(balance => balance.owner === owner.toBase58() && balance.mint === mint)
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n) ?? 0n;
    const tokenAmount = postToken >= preToken ? postToken - preToken : preToken - postToken;
    const solAmount = ownerWalletSolAbsDelta(parsed, owner) ?? 0n;
    return { tokenAmount, solAmount, price: tokenAmount === 0n ? 0 : Number(solAmount) / Number(tokenAmount), success: tokenAmount > 0n };
  }
  abstract buildBuy(args: BuildBuyArgs): Promise<PreparedTradeTransaction>;
  abstract buildSell(args: BuildSellArgs): Promise<PreparedTradeTransaction>;
}

export class PumpBondingCurveAdapter extends PumpAdapterBase {
  readonly name = "pump";
  readonly #program: ReturnType<typeof getPumpProgram>;
  readonly programId = PUMP_PROGRAM_ID;
  readonly #curves = new Map<string, PumpCurveSnapshot>();
  constructor(connection: Connection, computeUnitLimit: number, priorityFeeLamports: number, tipLamports: number) {
    super(connection, computeUnitLimit, priorityFeeLamports, tipLamports);
    this.#program = getPumpProgram(connection);
  }
  noteCurve(mint: string, curve: PumpCurveSnapshot): void {
    this.#curves.set(mint, curve);
  }
  parseFill(tx: unknown, owner: PublicKey, mint: string): FillResult {
    const parsed = tx as VersionedTransactionResponse;
    for (const log of parsed.meta?.logMessages ?? []) {
      if (!log.startsWith("Program data: ")) continue;
      const event = this.#program.coder.events.decode(log.slice("Program data: ".length));
      if (event?.name !== "tradeEvent") continue;
      const data = event.data as {
        mint: PublicKey; user: PublicKey; tokenAmount: BN; solAmount: BN;
        virtualTokenReserves?: BN; virtualQuoteReserves?: BN; virtualSolReserves?: BN; realTokenReserves?: BN;
        creator?: PublicKey; mayhemMode?: boolean; quoteMint?: PublicKey;
        feeBasisPoints?: BN; creatorFeeBasisPoints?: BN; feeRecipient?: PublicKey; cashbackFeeBasisPoints?: BN;
      };
      if (data.mint.toBase58() !== mint || !data.user.equals(owner)) continue;
      this.#noteTrade(data);
      const tokenAmount = BigInt(data.tokenAmount.toString(10));
      const eventSol = BigInt(data.solAmount.toString(10));
      // Journal / position SOL uses wallet delta so PnL matches cash (fees + tips). Price stays curve fill.
      const solAmount = ownerWalletSolAbsDelta(parsed, owner) ?? eventSol;
      return { tokenAmount, solAmount, price: tokenAmount === 0n ? 0 : Number(eventSol) / Number(tokenAmount), success: tokenAmount > 0n };
    }
    return super.parseFill(tx, owner, mint);
  }
  #noteTrade(data: {
    mint: PublicKey; virtualTokenReserves?: BN; virtualQuoteReserves?: BN; virtualSolReserves?: BN; realTokenReserves?: BN;
    creator?: PublicKey; mayhemMode?: boolean; quoteMint?: PublicKey;
    feeBasisPoints?: BN; creatorFeeBasisPoints?: BN; feeRecipient?: PublicKey; cashbackFeeBasisPoints?: BN;
  }): void {
    const quote = data.virtualQuoteReserves ?? data.virtualSolReserves;
    if (!quote || !data.virtualTokenReserves || !data.realTokenReserves || !data.creator) return;
    const mint = data.mint.toBase58();
    const previous = this.#curves.get(mint);
    const bn = (value: BN): bigint => BigInt(value.toString(10));
    this.noteCurve(mint, {
      virtualQuoteReserves: bn(quote),
      virtualTokenReserves: bn(data.virtualTokenReserves),
      realTokenReserves: bn(data.realTokenReserves),
      creator: data.creator.toBase58(),
      mayhemMode: data.mayhemMode === true,
      quoteMint: data.quoteMint?.toBase58() ?? previous?.quoteMint,
      protocolFeeBps: data.feeBasisPoints ? bn(data.feeBasisPoints) : previous?.protocolFeeBps ?? 0n,
      creatorFeeBps: data.creatorFeeBasisPoints ? bn(data.creatorFeeBasisPoints) : previous?.creatorFeeBps ?? 0n,
      feeRecipient: data.feeRecipient?.toBase58() ?? previous?.feeRecipient,
      cashback: data.cashbackFeeBasisPoints ? !data.cashbackFeeBasisPoints.isZero() : previous?.cashback ?? false
    });
  }
  async buildBuy({ descriptor, owner, lamports, slippageBps }: BuildBuyArgs): Promise<PreparedTradeTransaction> {
    const curve = this.#curves.get(descriptor.mint);
    if (!curve) throw new Error(`no streamed curve for ${descriptor.mint}`);
    const mint = new PublicKey(descriptor.mint);
    if (!descriptor.tokenProgram) throw new Error(`token program missing for ${descriptor.mint}`);
    const tokenProgram = new PublicKey(descriptor.tokenProgram);
    const spendable = new BN(lamports.toString());
    const associatedUser = getAssociatedTokenAddressSync(mint, owner, true, tokenProgram);
    const buy = await this.#program.methods
      .buyExactSolIn(spendable, minTokensOut(quoteBuyTokens(spendable, curve), slippageBps), { 0: true })
      .accountsPartial({
        feeRecipient: curve.feeRecipient ? new PublicKey(curve.feeRecipient) : feeRecipient(),
        mint,
        associatedUser,
        user: owner,
        creatorVault: creatorVaultPda(new PublicKey(curve.creator)),
        tokenProgram
      })
      .remainingAccounts([
        { pubkey: bondingCurveV2Pda(mint), isWritable: false, isSigner: false },
        { pubkey: buybackFeeRecipient(), isWritable: true, isSigner: false }
      ])
      .instruction();
    const instructions = [
      createAssociatedTokenAccountIdempotentInstruction(owner, associatedUser, owner, mint, tokenProgram),
      buy
    ];
    return this.prepared(instructions, owner);
  }
  async buildSell({ descriptor, owner, tokenAmount, slippageBps }: BuildSellArgs): Promise<PreparedTradeTransaction> {
    const curve = this.#curves.get(descriptor.mint);
    if (!curve) throw new Error(`no streamed curve for ${descriptor.mint}`);
    const mint = new PublicKey(descriptor.mint);
    if (!descriptor.tokenProgram) throw new Error(`token program missing for ${descriptor.mint}`);
    const tokenProgram = new PublicKey(descriptor.tokenProgram);
    const amount = new BN(tokenAmount.toString());
    const solOut = quoteSellSol(amount, curve);
    const slippage = slippageBps / 100;
    const minSol = solOut.sub(solOut.muln(Math.floor(slippage * 10)).divn(1_000));
    const instructions = [
      await PUMP_SDK.getSellInstructionRaw({
        user: owner,
        mint,
        creator: new PublicKey(curve.creator),
        amount,
        solAmount: minSol.isNeg() ? new BN(0) : minSol,
        tokenProgram,
        cashback: curve.cashback,
        ...(curve.feeRecipient ? { feeRecipient: new PublicKey(curve.feeRecipient) } : {})
      } as Parameters<typeof PUMP_SDK.getSellInstructionRaw>[0])
    ];
    return this.prepared(instructions, owner);
  }
}

export class PumpSwapAdapter extends PumpAdapterBase {
  readonly name = "pumpswap";
  readonly #program: ReturnType<typeof getPumpAmmProgram>;
  readonly programId = PUMP_AMM_PROGRAM_ID;
  readonly #pools = new Map<string, PumpSwapSnapshot>();
  constructor(connection: Connection, computeUnitLimit: number, priorityFeeLamports: number, tipLamports: number) {
    super(connection, computeUnitLimit, priorityFeeLamports, tipLamports);
    this.#program = getPumpAmmProgram(connection);
  }
  noteSwap(mint: string, swap: PumpSwapSnapshot): void {
    this.#pools.set(mint, swap);
  }
  parseFill(tx: unknown, owner: PublicKey, mint: string): FillResult {
    const parsed = tx as VersionedTransactionResponse;
    for (const log of parsed.meta?.logMessages ?? []) {
      if (!log.startsWith("Program data: ")) continue;
      const event = this.#program.coder.events.decode(log.slice("Program data: ".length));
      if (event?.name !== "buyEvent" && event?.name !== "sellEvent") continue;
      const data = event.data as {
        user: PublicKey; pool?: PublicKey;
        baseAmountOut?: BN; baseAmountIn?: BN; quoteAmountIn?: BN; quoteAmountOut?: BN;
        poolBaseTokenReserves?: BN; poolQuoteTokenReserves?: BN; virtualQuoteReserves?: BN;
      };
      if (!data.user.equals(owner)) continue;
      const base = data.baseAmountOut ?? data.baseAmountIn;
      const quote = data.quoteAmountIn ?? data.quoteAmountOut;
      if (!base || !quote) continue;
      this.#noteTrade(mint, data);
      const tokenAmount = BigInt(base.toString(10));
      const eventSol = BigInt(quote.toString(10));
      // Journal / position SOL uses wallet delta so PnL matches cash (fees + tips). Price stays pool fill.
      const solAmount = ownerWalletSolAbsDelta(parsed, owner) ?? eventSol;
      return { tokenAmount, solAmount, price: tokenAmount === 0n ? 0 : Number(eventSol) / Number(tokenAmount), success: tokenAmount > 0n };
    }
    return super.parseFill(tx, owner, mint);
  }
  #noteTrade(mint: string, data: { pool?: PublicKey; poolBaseTokenReserves?: BN; poolQuoteTokenReserves?: BN; virtualQuoteReserves?: BN }): void {
    const existing = this.#pools.get(mint);
    if (!existing || !data.poolBaseTokenReserves || !data.poolQuoteTokenReserves) return;
    if (data.pool && data.pool.toBase58() !== existing.pool) return;
    this.noteSwap(mint, {
      ...existing,
      baseReserve: BigInt(data.poolBaseTokenReserves.toString(10)),
      quoteReserve: BigInt(data.poolQuoteTokenReserves.toString(10)),
      virtualQuoteReserves: data.virtualQuoteReserves?.toString() ?? existing.virtualQuoteReserves
    });
  }
  async buildBuy({ descriptor, owner, lamports, slippageBps }: BuildBuyArgs): Promise<PreparedTradeTransaction> {
    const swap = this.#pools.get(descriptor.mint);
    if (!swap) throw new Error(`no streamed pumpswap pool for ${descriptor.mint}`);
    const { base, maxQuote } = quoteAmmBuy(new BN(lamports.toString()), swap, slippageBps);
    if (base.isZero()) throw new Error(`pumpswap buy quotes zero tokens for ${descriptor.mint}`);
    const instructions = await PUMP_AMM_SDK.buyInstructionsNoPool(swapState(swap, owner), base, maxQuote);
    return this.prepared(instructions, owner);
  }
  async buildSell({ descriptor, owner, tokenAmount, slippageBps }: BuildSellArgs): Promise<PreparedTradeTransaction> {
    const swap = this.#pools.get(descriptor.mint);
    if (!swap) throw new Error(`no streamed pumpswap pool for ${descriptor.mint}`);
    const amount = new BN(tokenAmount.toString());
    const minQuote = quoteAmmSell(amount, swap, slippageBps);
    const instructions = await PUMP_AMM_SDK.sellInstructionsNoPool(swapState(swap, owner), amount, minQuote);
    return this.prepared(instructions, owner);
  }
}

function quoteAmmBuy(quote: BN, swap: PumpSwapSnapshot, slippageBps: number): { base: BN; maxQuote: BN } {
  const baseReserve = new BN(swap.baseReserve.toString());
  const effectiveQuoteReserve = new BN(swap.quoteReserve.toString()).add(new BN(swap.virtualQuoteReserves));
  const creatorFee = swap.coinCreator === PublicKey.default.toBase58() ? 0n : swap.coinCreatorFeeBps;
  const totalFeeBps = new BN((swap.lpFeeBps + swap.protocolFeeBps + creatorFee).toString());
  let effectiveQuote = quote.muln(10_000).div(new BN(10_000).add(totalFeeBps));
  const fees = ceilFee(effectiveQuote, swap.lpFeeBps).add(ceilFee(effectiveQuote, swap.protocolFeeBps)).add(creatorFee === 0n ? new BN(0) : ceilFee(effectiveQuote, creatorFee));
  if (fees.gt(quote)) effectiveQuote = effectiveQuote.sub(fees.sub(quote));
  const inputAmount = effectiveQuote.isZero() ? new BN(0) : effectiveQuote.subn(1);
  const denominator = effectiveQuoteReserve.add(inputAmount);
  const base = denominator.isZero() || denominator.isNeg() ? new BN(0) : baseReserve.mul(inputAmount).div(denominator);
  return { base, maxQuote: quote.mul(slippageFactor(slippageBps, true)).div(new BN(1_000_000_000)) };
}

function quoteAmmSell(base: BN, swap: PumpSwapSnapshot, slippageBps: number): BN {
  const baseReserve = new BN(swap.baseReserve.toString());
  const effectiveQuoteReserve = new BN(swap.quoteReserve.toString()).add(new BN(swap.virtualQuoteReserves));
  if (base.isZero() || baseReserve.isZero() || effectiveQuoteReserve.isZero() || effectiveQuoteReserve.isNeg()) return new BN(0);
  const quoteOut = effectiveQuoteReserve.mul(base).div(baseReserve.add(base));
  const creatorFee = swap.coinCreator === PublicKey.default.toBase58() ? 0n : swap.coinCreatorFeeBps;
  const net = quoteOut.sub(ceilFee(quoteOut, swap.lpFeeBps)).sub(ceilFee(quoteOut, swap.protocolFeeBps)).sub(creatorFee === 0n ? new BN(0) : ceilFee(quoteOut, creatorFee));
  if (net.isNeg()) return new BN(0);
  return net.mul(slippageFactor(slippageBps, false)).div(new BN(1_000_000_000));
}

const FEE_RECIPIENTS = [
  "62qc2CNXwrYqQScmEdiZFFAnJR262PxWEuNQtxfafNgV",
  "7VtfL8fvgNfhz17qKRMjzQEXgbdpnHHHQRh54R9jP2RJ",
  "7hTckgnGnLQR6sdH7YkqFTAA7VwTfYFaZ6EhEsU3saCX",
  "9rPYyANsfQZw3DnDmKE3YCQF5E8oD89UXoHn9JFEhJUz",
  "AVmoTthdrX6tKt4nDjco2D775W2YK3sDhxPcMmzUAmTY",
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM",
  "FWsW1xNtWscwNmKv6wVsU1iTzRN6wmmk3MjxRP5tT7hz",
  "G5UZAVbAf46s7cKWoyKu8kYTip9DGTpbLZ2qa9Aq69dP"
];

const BUYBACK_FEE_RECIPIENTS = [
  "5YxQFdt3Tr9zJLvkFccqXVUwhdTWJQc1fFg2YPbxvxeD",
  "9M4giFFMxmFGXtc3feFzRai56WbBqehoSeRE5GK7gf7",
  "GXPFM2caqTtQYC2cJ5yJRi9VDkpsYZXzYdwYpGnLmtDL",
  "3BpXnfJaUTiwXnJNe7Ej1rcbzqTTQUvLShZaWazebsVR",
  "5cjcW9wExnJJiqgLjq7DEG75Pm6JBgE1hNv4B2vHXUW6",
  "EHAAiTxcdDwQ3U4bU6YcMsQGaekdzLS3B5SmYo46kJtL",
  "5eHhjP8JaYkz83CWwvGU2uMUXefd3AazWGx4gpcuEEYD",
  "A7hAgCzFw14fejgCp387JUJRMNyz4j89JKnhtKU8piqW"
];

function feeRecipient(): PublicKey {
  return new PublicKey(FEE_RECIPIENTS[Math.floor(Math.random() * FEE_RECIPIENTS.length)]!);
}

function buybackFeeRecipient(): PublicKey {
  return new PublicKey(BUYBACK_FEE_RECIPIENTS[Math.floor(Math.random() * BUYBACK_FEE_RECIPIENTS.length)]!);
}

function slippageFactor(slippageBps: number, up: boolean): BN {
  const slippage = slippageBps / 100;
  return new BN(Math.max(0, Math.floor((up ? 1 + slippage / 100 : 1 - slippage / 100) * 1e9)));
}

function swapState(swap: PumpSwapSnapshot, owner: PublicKey): SwapSolanaState {
  const baseMint = new PublicKey(swap.baseMint);
  const quoteMint = new PublicKey(swap.quoteMint);
  const baseTokenProgram = new PublicKey(swap.baseTokenProgram);
  const quoteTokenProgram = new PublicKey(swap.quoteTokenProgram);
  const recipient = new PublicKey(swap.protocolFeeRecipient);
  const buyback = new PublicKey(swap.buybackFeeRecipient);
  return {
    user: owner,
    userBaseTokenAccount: getAssociatedTokenAddressSync(baseMint, owner, true, baseTokenProgram),
    userQuoteTokenAccount: getAssociatedTokenAddressSync(quoteMint, owner, true, quoteTokenProgram),
    userBaseAccountInfo: null,
    userQuoteAccountInfo: null,
    poolKey: new PublicKey(swap.pool),
    baseTokenProgram,
    quoteTokenProgram,
    globalConfig: { protocolFeeRecipients: [recipient], reservedFeeRecipient: recipient, reservedFeeRecipients: [], buybackFeeRecipients: [buyback] },
    pool: {
      baseMint,
      quoteMint,
      poolBaseTokenAccount: new PublicKey(swap.poolBaseTokenAccount),
      poolQuoteTokenAccount: new PublicKey(swap.poolQuoteTokenAccount),
      coinCreator: new PublicKey(swap.coinCreator),
      isMayhemMode: false,
      isCashbackCoin: swap.cashback
    }
  } as unknown as SwapSolanaState;
}
