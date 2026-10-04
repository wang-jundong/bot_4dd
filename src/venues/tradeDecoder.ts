import BN from "bn.js";
import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getPumpAmmProgram, getPumpProgram, PUMP_AMM_PROGRAM_ID, PUMP_PROGRAM_ID, bondingCurvePda } from "@pump-fun/pump-sdk";
import { GLOBAL_CONFIG_PDA, GLOBAL_VOLUME_ACCUMULATOR_PDA, PUMP_AMM_EVENT_AUTHORITY_PDA, PUMP_AMM_FEE_CONFIG_PDA, PUMP_FEE_PROGRAM_ID, coinCreatorVaultAtaPda, coinCreatorVaultAuthorityPda, poolV2Pda, userVolumeAccumulatorPda } from "@pump-fun/pump-swap-sdk";
import type { SubscribeUpdateTransactionInfo } from "@triton-one/yellowstone-grpc";
import type { PoolTradeEvent, PumpSwapSnapshot } from "../events/types.js";
import type { ParsedTargetTransaction, ParsedTrade, PoolDescriptor } from "./types.js";

interface PumpTradeData {
  mint: PublicKey; solAmount: BN; tokenAmount: BN; isBuy: boolean; user: PublicKey; timestamp: BN;
  virtualTokenReserves: BN; virtualQuoteReserves?: BN; virtualSolReserves?: BN; realTokenReserves: BN;
  creator?: PublicKey; mayhemMode?: boolean; quoteMint?: PublicKey;
  feeBasisPoints?: BN; creatorFeeBasisPoints?: BN; feeRecipient?: PublicKey; cashbackFeeBasisPoints?: BN;
}
interface AmmTradeData {
  timestamp: BN; pool: PublicKey; user: PublicKey;
  baseAmountOut?: BN; baseAmountIn?: BN; quoteAmountIn?: BN; quoteAmountOut?: BN;
  poolBaseTokenReserves: BN; poolQuoteTokenReserves: BN;
  lpFeeBasisPoints?: BN; protocolFeeBasisPoints?: BN; coinCreatorFeeBasisPoints?: BN;
  coinCreator?: PublicKey; protocolFeeRecipient?: PublicKey; virtualQuoteReserves?: BN; cashbackFeeBasisPoints?: BN;
}
interface TokenBalance { accountIndex: number; mint: string; owner?: string; programId?: string; uiTokenAmount?: { amount: string }; }
interface AnchorEvent { name: string; data: unknown; }

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ASSOCIATED_TOKEN_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const rawInfo = (tx: ParsedTargetTransaction): SubscribeUpdateTransactionInfo => tx.raw as SubscribeUpdateTransactionInfo;
const bnBigInt = (value: BN): bigint => BigInt(value.toString(10));
const ratio = (quote: BN, base: BN): number => base.isZero() ? 0 : Number(quote.toString(10)) / Number(base.toString(10));

export class PumpTradeDecoder {
  readonly #pumpProgram;
  readonly #ammProgram;

  constructor(private readonly connection: Connection) {
    this.#pumpProgram = getPumpProgram(connection);
    this.#ammProgram = getPumpAmmProgram(connection);
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
        const trade = this.#ammTrade(tx, amm.name === "buyEvent", amm.data as AmmTradeData, eventIndex++);
        if (trade) trades.push(trade);
      }
    }
    return trades;
  }

  #decode(coder: { decode(log: string): AnchorEvent | null }, encoded: string): AnchorEvent | null {
    try { return coder.decode(encoded); } catch { return null; }
  }

  async #pumpTrade(tx: ParsedTargetTransaction, data: PumpTradeData, eventIndex: number): Promise<ParsedTrade> {
    const mint = data.mint.toBase58();
    const pool = bondingCurvePda(data.mint).toBase58();
    const descriptor: PoolDescriptor = {
      mint, pool, programId: PUMP_PROGRAM_ID.toBase58(), venue: "pump",
      tokenProgram: this.#tokenProgram(tx, mint), relevantAccounts: [pool, mint]
    };
    const quoteReserves = data.virtualQuoteReserves ?? data.virtualSolReserves;
    const event = this.#event(tx, eventIndex, descriptor, data.user, data.isBuy, data.solAmount, data.tokenAmount, ratio(quoteReserves ?? new BN(0), data.virtualTokenReserves), undefined, data.timestamp);
    if (quoteReserves && data.creator) {
      event.curve = {
        virtualQuoteReserves: bnBigInt(quoteReserves),
        virtualTokenReserves: bnBigInt(data.virtualTokenReserves),
        realTokenReserves: bnBigInt(data.realTokenReserves),
        creator: data.creator.toBase58(),
        mayhemMode: data.mayhemMode === true,
        quoteMint: data.quoteMint?.toBase58(),
        protocolFeeBps: data.feeBasisPoints ? bnBigInt(data.feeBasisPoints) : 0n,
        creatorFeeBps: data.creatorFeeBasisPoints ? bnBigInt(data.creatorFeeBasisPoints) : 0n,
        feeRecipient: data.feeRecipient && !data.feeRecipient.equals(PublicKey.default) ? data.feeRecipient.toBase58() : undefined,
        cashback: data.cashbackFeeBasisPoints ? !data.cashbackFeeBasisPoints.isZero() : false
      };
    }
    return { descriptor, event };
  }

  #ammTrade(tx: ParsedTargetTransaction, isBuy: boolean, data: AmmTradeData, eventIndex: number): ParsedTrade | undefined {
    const poolKey = data.pool.toBase58();
    const vaults = poolVaults(tx, poolKey, data.poolBaseTokenReserves, data.poolQuoteTokenReserves);
    if (!vaults) return undefined;
    const mint = vaults.base.mint;
    const descriptor: PoolDescriptor = {
      mint, pool: poolKey, programId: PUMP_AMM_PROGRAM_ID.toBase58(), venue: "pumpswap",
      tokenProgram: vaults.base.programId, quoteMint: vaults.quote.mint, relevantAccounts: [poolKey, mint]
    };
    const tokenAmount = isBuy ? data.baseAmountOut! : data.baseAmountIn!;
    const solAmount = isBuy ? data.quoteAmountIn! : data.quoteAmountOut!;
    const event = this.#event(tx, eventIndex, descriptor, data.user, isBuy, solAmount, tokenAmount, ratio(data.poolQuoteTokenReserves, data.poolBaseTokenReserves), 1, data.timestamp);
    const buyback = data.coinCreator && data.protocolFeeRecipient
      ? buybackRecipient(tx, poolKey, data.user.toBase58(), vaults, data.coinCreator, data.protocolFeeRecipient)
      : undefined;
    if (buyback && data.coinCreator && data.protocolFeeRecipient) {
      event.swap = {
        pool: poolKey,
        baseMint: mint,
        quoteMint: vaults.quote.mint,
        poolBaseTokenAccount: vaults.base.address,
        poolQuoteTokenAccount: vaults.quote.address,
        baseTokenProgram: vaults.base.programId,
        quoteTokenProgram: vaults.quote.programId,
        baseReserve: bnBigInt(data.poolBaseTokenReserves),
        quoteReserve: bnBigInt(data.poolQuoteTokenReserves),
        virtualQuoteReserves: data.virtualQuoteReserves?.toString() ?? "0",
        lpFeeBps: data.lpFeeBasisPoints ? bnBigInt(data.lpFeeBasisPoints) : 0n,
        protocolFeeBps: data.protocolFeeBasisPoints ? bnBigInt(data.protocolFeeBasisPoints) : 0n,
        coinCreatorFeeBps: data.coinCreatorFeeBasisPoints ? bnBigInt(data.coinCreatorFeeBasisPoints) : 0n,
        coinCreator: data.coinCreator.toBase58(),
        protocolFeeRecipient: data.protocolFeeRecipient.toBase58(),
        buybackFeeRecipient: buyback,
        cashback: data.cashbackFeeBasisPoints ? !data.cashbackFeeBasisPoints.isZero() : false
      } satisfies PumpSwapSnapshot;
    }
    return { descriptor, event };
  }

  #tokenProgram(tx: ParsedTargetTransaction, mint: string): string | undefined {
    const info = rawInfo(tx);
    return [...(info.meta?.preTokenBalances ?? []), ...(info.meta?.postTokenBalances ?? [])].find(balance => balance.mint === mint)?.programId;
  }

  #event(tx: ParsedTargetTransaction, eventIndex: number, descriptor: PoolDescriptor, user: PublicKey, isBuy: boolean, sol: BN, token: BN, price: number, curveProgress: number | undefined, timestamp: BN): PoolTradeEvent {
    return {
      signature: tx.signature, slot: tx.slot, eventIndex, timestampMs: Number(timestamp.toString(10)) * 1000,
      receivedMonoMs: performance.now(), mint: descriptor.mint, pool: descriptor.pool, programId: descriptor.programId,
      trader: user.toBase58(), side: isBuy ? "buy" : "sell", solAmount: bnBigInt(sol), tokenAmount: bnBigInt(token), price, curveProgress
    };
  }
}

interface Vault { mint: string; address: string; programId: string; }

function poolVaults(tx: ParsedTargetTransaction, pool: string, baseReserve: BN, quoteReserve: BN): { base: Vault; quote: Vault } | undefined {
  const balances = (rawInfo(tx).meta?.postTokenBalances ?? []) as TokenBalance[];
  const owned = balances.filter(balance => balance.owner === pool);
  const base = vault(tx, owned.length > 0 ? owned : balances, baseReserve.toString(10));
  const quote = vault(tx, (owned.length > 0 ? owned : balances).filter(balance => tx.accountKeys[balance.accountIndex] !== base?.address), quoteReserve.toString(10));
  if (!base || !quote) return undefined;
  return { base, quote };
}

function vault(tx: ParsedTargetTransaction, balances: readonly TokenBalance[], amount: string): Vault | undefined {
  const match = balances.find(balance => balance.uiTokenAmount?.amount === amount);
  const address = match ? tx.accountKeys[match.accountIndex] : undefined;
  if (!match?.mint || !address) return undefined;
  return { mint: match.mint, address, programId: match.programId || TOKEN_PROGRAM };
}

function buybackRecipient(tx: ParsedTargetTransaction, pool: string, trader: string, vaults: { base: Vault; quote: Vault }, coinCreator: PublicKey, protocolFeeRecipient: PublicKey): string | undefined {
  const quoteProgram = new PublicKey(vaults.quote.programId);
  const traderKey = new PublicKey(trader);
  const creatorVault = coinCreatorVaultAuthorityPda(coinCreator);
  const known = new Set([
    pool, trader, GLOBAL_CONFIG_PDA.toBase58(), vaults.base.mint, vaults.quote.mint,
    getAssociatedTokenAddressSync(new PublicKey(vaults.base.mint), traderKey, true, new PublicKey(vaults.base.programId)).toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(vaults.quote.mint), traderKey, true, quoteProgram).toBase58(),
    vaults.base.address, vaults.quote.address, protocolFeeRecipient.toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(vaults.quote.mint), protocolFeeRecipient, true, quoteProgram).toBase58(),
    vaults.base.programId, vaults.quote.programId, SYSTEM_PROGRAM, ASSOCIATED_TOKEN_PROGRAM,
    PUMP_AMM_EVENT_AUTHORITY_PDA.toBase58(), PUMP_AMM_PROGRAM_ID.toBase58(),
    coinCreatorVaultAtaPda(creatorVault, new PublicKey(vaults.quote.mint), quoteProgram).toBase58(), creatorVault.toBase58(),
    GLOBAL_VOLUME_ACCUMULATOR_PDA.toBase58(), userVolumeAccumulatorPda(traderKey).toBase58(),
    PUMP_AMM_FEE_CONFIG_PDA.toBase58(), PUMP_FEE_PROGRAM_ID.toBase58(), poolV2Pda(new PublicKey(vaults.base.mint)).toBase58(),
    getAssociatedTokenAddressSync(new PublicKey(vaults.quote.mint), userVolumeAccumulatorPda(traderKey), true, quoteProgram).toBase58()
  ]);
  const message = rawInfo(tx).transaction?.message;
  const inner = (rawInfo(tx).meta?.innerInstructions ?? []).flatMap(group => group.instructions);
  const instructions = [...(message?.instructions ?? []), ...inner] as Array<{ programIdIndex: number; accounts: Uint8Array | number[]; data: Uint8Array | number[] }>;
  const swapDiscs = [
    Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
    Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]),
    Buffer.from([51, 230, 133, 164, 1, 127, 131, 173])
  ];
  for (const ix of instructions) {
    const data = Buffer.from(ix.data);
    if (!swapDiscs.some(disc => data.subarray(0, 8).equals(disc))) continue;
    if (tx.accountKeys[ix.programIdIndex] !== PUMP_AMM_PROGRAM_ID.toBase58()) continue;
    const keys = [...ix.accounts].map(index => tx.accountKeys[index]).filter((key): key is string => key !== undefined && !known.has(key));
    for (let index = 0; index < keys.length - 1; index++) {
      const recipient = keys[index];
      if (!recipient) continue;
      const ata = getAssociatedTokenAddressSync(new PublicKey(vaults.quote.mint), new PublicKey(recipient), true, quoteProgram).toBase58();
      if (keys[index + 1] === ata) return recipient;
    }
  }
  return undefined;
}
