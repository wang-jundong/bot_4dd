import BN from "bn.js";
import {
  ComputeBudgetProgram, Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction,
  type TransactionInstruction, type VersionedTransactionResponse
} from "@solana/web3.js";
import {
  getBuyTokenAmountFromSolAmount, getSellSolAmountFromTokenAmount, getPumpAmmProgram, getPumpProgram, OnlinePumpSdk,
  PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, PUMP_SDK
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk, PUMP_AMM_SDK } from "@pump-fun/pump-swap-sdk";
import type {
  BuildBuyArgs, BuildSellArgs, FillResult, ParsedTargetTransaction, ParsedTrade,
  PreparedTradeTransaction, VenueAdapter
} from "./types.js";

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
    const ownerIndex = parsed.transaction.message.staticAccountKeys.findIndex(key => key.equals(owner));
    const preToken = parsed.meta.preTokenBalances?.filter(balance => balance.owner === owner.toBase58() && balance.mint === mint)
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n) ?? 0n;
    const postToken = parsed.meta.postTokenBalances?.filter(balance => balance.owner === owner.toBase58() && balance.mint === mint)
      .reduce((sum, balance) => sum + BigInt(balance.uiTokenAmount.amount), 0n) ?? 0n;
    const tokenAmount = postToken >= preToken ? postToken - preToken : preToken - postToken;
    const solDelta = ownerIndex < 0 ? 0n : BigInt(parsed.meta.postBalances[ownerIndex] ?? 0) - BigInt(parsed.meta.preBalances[ownerIndex] ?? 0);
    const solAmount = solDelta < 0n ? -solDelta : solDelta;
    return { tokenAmount, solAmount, price: tokenAmount === 0n ? 0 : Number(solAmount) / Number(tokenAmount), success: tokenAmount > 0n };
  }
  abstract buildBuy(args: BuildBuyArgs): Promise<PreparedTradeTransaction>;
  abstract buildSell(args: BuildSellArgs): Promise<PreparedTradeTransaction>;
}

export class PumpBondingCurveAdapter extends PumpAdapterBase {
  readonly name = "pump";
  readonly #program: ReturnType<typeof getPumpProgram>;
  readonly programId = PUMP_PROGRAM_ID;
  readonly #online: OnlinePumpSdk;
  constructor(connection: Connection, computeUnitLimit: number, priorityFeeLamports: number, tipLamports: number) {
    super(connection, computeUnitLimit, priorityFeeLamports, tipLamports);
    this.#online = new OnlinePumpSdk(connection);
    this.#program = getPumpProgram(connection);
  }
  parseFill(tx: unknown, owner: PublicKey, mint: string): FillResult {
    const parsed = tx as VersionedTransactionResponse;
    for (const log of parsed.meta?.logMessages ?? []) {
      if (!log.startsWith("Program data: ")) continue;
      const event = this.#program.coder.events.decode(log.slice("Program data: ".length));
      if (event?.name !== "tradeEvent") continue;
      const data = event.data as { mint: PublicKey; user: PublicKey; tokenAmount: BN; solAmount: BN };
      if (data.mint.toBase58() !== mint || !data.user.equals(owner)) continue;
      const tokenAmount = BigInt(data.tokenAmount.toString(10));
      const solAmount = BigInt(data.solAmount.toString(10));
      return { tokenAmount, solAmount, price: tokenAmount === 0n ? 0 : Number(solAmount) / Number(tokenAmount), success: tokenAmount > 0n };
    }
    return super.parseFill(tx, owner, mint);
  }
  async buildBuy({ descriptor, owner, lamports, slippageBps }: BuildBuyArgs): Promise<PreparedTradeTransaction> {
    const mint = new PublicKey(descriptor.mint);
    const tokenProgram = await this.#tokenProgram(mint, descriptor.tokenProgram);
    const [global, feeConfig, state, supply] = await Promise.all([
      this.#online.fetchGlobal(), this.#online.fetchFeeConfig(), this.#online.fetchBuyState(mint, owner, tokenProgram), this.connection.getTokenSupply(mint)
    ]);
    const solAmount = new BN(lamports.toString());
    const mintSupply = new BN(supply.value.amount);
    const amount = getBuyTokenAmountFromSolAmount({ global, feeConfig, mintSupply, bondingCurve: state.bondingCurve, amount: solAmount, quoteMint: state.bondingCurve.quoteMint });
    const instructions = await PUMP_SDK.buyInstructions({ global, ...state, mint, user: owner, amount, solAmount, slippage: slippageBps / 100, tokenProgram });
    return this.prepared(instructions, owner);
  }
  async buildSell({ descriptor, owner, tokenAmount, slippageBps }: BuildSellArgs): Promise<PreparedTradeTransaction> {
    const mint = new PublicKey(descriptor.mint);
    const tokenProgram = await this.#tokenProgram(mint, descriptor.tokenProgram);
    const [global, feeConfig, state, supply] = await Promise.all([
      this.#online.fetchGlobal(), this.#online.fetchFeeConfig(), this.#online.fetchSellState(mint, owner, tokenProgram), this.connection.getTokenSupply(mint)
    ]);
    const amount = new BN(tokenAmount.toString());
    const solAmount = getSellSolAmountFromTokenAmount({ global, feeConfig, mintSupply: new BN(supply.value.amount), bondingCurve: state.bondingCurve, amount });
    const instructions = await PUMP_SDK.sellInstructions({ global, ...state, mint, user: owner, amount, solAmount, slippage: slippageBps / 100, tokenProgram, mayhemMode: state.bondingCurve.isMayhemMode, cashback: state.bondingCurve.isCashbackCoin });
    return this.prepared(instructions, owner);
  }
  async #tokenProgram(mint: PublicKey, configured?: string): Promise<PublicKey> {
    if (configured) return new PublicKey(configured);
    const account = await this.connection.getAccountInfo(mint);
    if (!account) throw new Error(`mint account not found: ${mint.toBase58()}`);
    return account.owner;
  }
}

export class PumpSwapAdapter extends PumpAdapterBase {
  readonly name = "pumpswap";
  readonly #program: ReturnType<typeof getPumpAmmProgram>;
  readonly programId = PUMP_AMM_PROGRAM_ID;
  readonly #online: OnlinePumpAmmSdk;
  constructor(connection: Connection, computeUnitLimit: number, priorityFeeLamports: number, tipLamports: number) {
    super(connection, computeUnitLimit, priorityFeeLamports, tipLamports);
    this.#online = new OnlinePumpAmmSdk(connection);
    this.#program = getPumpAmmProgram(connection);
  }
  parseFill(tx: unknown, owner: PublicKey, mint: string): FillResult {
    const parsed = tx as VersionedTransactionResponse;
    for (const log of parsed.meta?.logMessages ?? []) {
      if (!log.startsWith("Program data: ")) continue;
      const event = this.#program.coder.events.decode(log.slice("Program data: ".length));
      if (event?.name !== "buyEvent" && event?.name !== "sellEvent") continue;
      const data = event.data as { user: PublicKey; baseAmountOut?: BN; baseAmountIn?: BN; quoteAmountIn?: BN; quoteAmountOut?: BN };
      if (!data.user.equals(owner)) continue;
      const base = data.baseAmountOut ?? data.baseAmountIn;
      const quote = data.quoteAmountIn ?? data.quoteAmountOut;
      if (!base || !quote) continue;
      const tokenAmount = BigInt(base.toString(10));
      const solAmount = BigInt(quote.toString(10));
      return { tokenAmount, solAmount, price: tokenAmount === 0n ? 0 : Number(solAmount) / Number(tokenAmount), success: tokenAmount > 0n };
    }
    return super.parseFill(tx, owner, mint);
  }
  async buildBuy({ descriptor, owner, lamports, slippageBps }: BuildBuyArgs): Promise<PreparedTradeTransaction> {
    const state = await this.#online.swapSolanaState(new PublicKey(descriptor.pool), owner);
    const instructions = await PUMP_AMM_SDK.buyQuoteInput(state, new BN(lamports.toString()), slippageBps / 100);
    return this.prepared(instructions, owner);
  }
  async buildSell({ descriptor, owner, tokenAmount, slippageBps }: BuildSellArgs): Promise<PreparedTradeTransaction> {
    const state = await this.#online.swapSolanaState(new PublicKey(descriptor.pool), owner);
    const instructions = await PUMP_AMM_SDK.sellBaseInput(state, new BN(tokenAmount.toString()), slippageBps / 100);
    return this.prepared(instructions, owner);
  }
}
