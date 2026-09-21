import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { getPumpAmmProgram, getPumpProgram, OnlinePumpSdk, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import type { SubscribeUpdateTransactionInfo } from "@triton-one/yellowstone-grpc";
import type { PoolTradeEvent } from "../events/types.js";
import type { ParsedTargetTransaction, ParsedTrade, PoolDescriptor } from "./types.js";

interface PumpTradeData {
  mint: PublicKey; solAmount: BN; tokenAmount: BN; isBuy: boolean; user: PublicKey; timestamp: BN;
  virtualTokenReserves: BN; virtualQuoteReserves: BN; realTokenReserves: BN;
}
interface AmmTradeData {
  timestamp: BN; pool: PublicKey; user: PublicKey;
  baseAmountOut?: BN; baseAmountIn?: BN; quoteAmountIn?: BN; quoteAmountOut?: BN;
  poolBaseTokenReserves: BN; poolQuoteTokenReserves: BN;
}
interface AnchorEvent { name: string; data: unknown; }

const rawInfo = (tx: ParsedTargetTransaction): SubscribeUpdateTransactionInfo => tx.raw as SubscribeUpdateTransactionInfo;
const bnBigInt = (value: BN): bigint => BigInt(value.toString(10));
const ratio = (quote: BN, base: BN): number => base.isZero() ? 0 : Number(quote.toString(10)) / Number(base.toString(10));

export class PumpTradeDecoder {
  readonly #pumpProgram;
  readonly #ammProgram;
  readonly #onlinePump: OnlinePumpSdk;
  readonly #onlineAmm: OnlinePumpAmmSdk;
  readonly #poolCache = new Map<string, { baseMint: PublicKey; quoteMint: PublicKey }>();
  #initialRealTokenReserves?: BN;

  constructor(private readonly connection: Connection) {
    this.#pumpProgram = getPumpProgram(connection);
    this.#ammProgram = getPumpAmmProgram(connection);
    this.#onlinePump = new OnlinePumpSdk(connection);
    this.#onlineAmm = new OnlinePumpAmmSdk(connection);
  }

  async decode(tx: ParsedTargetTransaction): Promise<readonly ParsedTrade[]> {
    const logs = rawInfo(tx).meta?.logMessages ?? [];
    const trades: ParsedTrade[] = [];
    let eventIndex = 0;
    for (const log of logs) {
      if (!log.startsWith("Program data: ")) continue;
      const encoded = log.slice("Program data: ".length);
      const pump = this.#decode(this.#pumpProgram.coder.events, encoded);
      if (pump?.name === "tradeEvent") {
        trades.push(await this.#pumpTrade(tx, pump.data as PumpTradeData, eventIndex++));
        continue;
      }
      const amm = this.#decode(this.#ammProgram.coder.events, encoded);
      if (amm?.name === "buyEvent" || amm?.name === "sellEvent") {
        trades.push(await this.#ammTrade(tx, amm.name === "buyEvent", amm.data as AmmTradeData, eventIndex++));
      }
    }
    return trades;
  }

  #decode(coder: { decode(log: string): AnchorEvent | null }, encoded: string): AnchorEvent | null {
    try { return coder.decode(encoded); } catch { return null; }
  }

  async #pumpTrade(tx: ParsedTargetTransaction, data: PumpTradeData, eventIndex: number): Promise<ParsedTrade> {
    if (!this.#initialRealTokenReserves) this.#initialRealTokenReserves = (await this.#onlinePump.fetchGlobal()).initialRealTokenReserves;
    const mint = data.mint.toBase58();
    const pool = bondingCurvePda(data.mint).toBase58();
    const descriptor: PoolDescriptor = {
      mint, pool, programId: PUMP_PROGRAM_ID.toBase58(), venue: "pump",
      tokenProgram: this.#tokenProgram(tx, mint), relevantAccounts: [pool, mint]
    };
    const progress = this.#initialRealTokenReserves.isZero() ? 0 : 1 - Number(data.realTokenReserves.toString(10)) / Number(this.#initialRealTokenReserves.toString(10));
    return { descriptor, event: this.#event(tx, eventIndex, descriptor, data.user, data.isBuy, data.solAmount, data.tokenAmount, ratio(data.virtualQuoteReserves, data.virtualTokenReserves), Math.max(0, Math.min(1, progress)), data.timestamp) };
  }

  async #ammTrade(tx: ParsedTargetTransaction, isBuy: boolean, data: AmmTradeData, eventIndex: number): Promise<ParsedTrade> {
    const poolKey = data.pool.toBase58();
    let pool = this.#poolCache.get(poolKey);
    if (!pool) {
      const fetched = await this.#onlineAmm.fetchPool(data.pool);
      pool = { baseMint: fetched.baseMint, quoteMint: fetched.quoteMint };
      this.#poolCache.set(poolKey, pool);
    }
    const mint = pool.baseMint.toBase58();
    const descriptor: PoolDescriptor = {
      mint, pool: poolKey, programId: PUMP_AMM_PROGRAM_ID.toBase58(), venue: "pumpswap",
      tokenProgram: this.#tokenProgram(tx, mint), quoteMint: pool.quoteMint.toBase58(), relevantAccounts: [poolKey, mint]
    };
    const tokenAmount = isBuy ? data.baseAmountOut! : data.baseAmountIn!;
    const solAmount = isBuy ? data.quoteAmountIn! : data.quoteAmountOut!;
    return { descriptor, event: this.#event(tx, eventIndex, descriptor, data.user, isBuy, solAmount, tokenAmount, ratio(data.poolQuoteTokenReserves, data.poolBaseTokenReserves), 1, data.timestamp) };
  }

  #tokenProgram(tx: ParsedTargetTransaction, mint: string): string | undefined {
    const info = rawInfo(tx);
    return [...(info.meta?.preTokenBalances ?? []), ...(info.meta?.postTokenBalances ?? [])].find(balance => balance.mint === mint)?.programId;
  }

  #event(tx: ParsedTargetTransaction, eventIndex: number, descriptor: PoolDescriptor, user: PublicKey, isBuy: boolean, sol: BN, token: BN, price: number, curveProgress: number, timestamp: BN): PoolTradeEvent {
    return {
      signature: tx.signature, slot: tx.slot, eventIndex, timestampMs: Number(timestamp.toString(10)) * 1000,
      receivedMonoMs: performance.now(), mint: descriptor.mint, pool: descriptor.pool, programId: descriptor.programId,
      trader: user.toBase58(), side: isBuy ? "buy" : "sell", solAmount: bnBigInt(sol), tokenAmount: bnBigInt(token), price, curveProgress
    };
  }
}
