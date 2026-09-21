import type { PublicKey, TransactionInstruction, VersionedTransaction } from "@solana/web3.js";
import type { PoolTradeEvent } from "../events/types.js";

export interface ParsedTargetTransaction { signature: string; slot: number; timestampMs: number; accountKeys: readonly string[]; programIds: readonly string[]; raw: unknown; }
export interface PoolDescriptor { mint: string; pool: string; programId: string; venue: string; tokenProgram?: string; quoteMint?: string; relevantAccounts: readonly string[]; }
export interface ParsedTrade { descriptor: PoolDescriptor; event: PoolTradeEvent; }
export interface PreparedTradeTransaction {
  readonly instructions: readonly TransactionInstruction[];
  readonly signers: readonly PublicKey[];
  compile(blockhash: string): VersionedTransaction;
}
export interface FillResult { tokenAmount: bigint; solAmount: bigint; price: number; success: boolean; }
export interface BuildBuyArgs { descriptor: PoolDescriptor; owner: PublicKey; lamports: bigint; slippageBps: number; }
export interface BuildSellArgs { descriptor: PoolDescriptor; owner: PublicKey; tokenAmount: bigint; slippageBps: number; }
export interface VenueAdapter {
  readonly name: string;
  canHandle(tx: ParsedTargetTransaction): boolean;
  parseTargetTrade(tx: ParsedTargetTransaction): ParsedTrade | undefined;
  buildBuy(args: BuildBuyArgs): Promise<PreparedTradeTransaction>;
  buildSell(args: BuildSellArgs): Promise<PreparedTradeTransaction>;
  parseFill(tx: unknown, owner: PublicKey, mint: string): FillResult;
}
