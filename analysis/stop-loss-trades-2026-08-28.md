# Four Stop-Loss Trades: What Actually Went Wrong

## Executive Summary

- **All four exits were correctly classified as `TSR_STOP`.** Three trades used the earlier −40% stop and the newest trade used −30%. The observed event price had already crossed the applicable threshold when the bot emitted each sell.
- **Your bundler-sell hypothesis is likely correct.** Every token showed concentrated multi-wallet selling immediately before the bot exited. `GRP…` is the strongest case: 13 distinct wallets sold 8.80 SOL in one slot. Same-slot timing proves clustering, but not common ownership by itself.
- **The cohort lost 0.0170833 SOL gross.** Realized fill-to-fill returns ranged from −40.54% to −53.31%. Every first sell transaction failed on-chain with Pump error 6003, `TooLittleSolReceived`, before the second attempt succeeded.
- **Two losses point primarily to entry controls.** `2Ck…` entered after a +27.56% confirmation rebound and would now be rejected by `TSR_POST_SELL_MAX_RETURN_PCT=10`. `A6J…` filled 7.56% above its entry signal after a failed first buy; a 5% retry-deviation ceiling would have prevented that entry.
- **Do not widen or remove the stop from these four selected rebounders alone.** The sample was selected because price recovered later and excludes stopped tokens that continued toward zero. A safer improvement is to fix stop execution and test a separate, confirmed re-entry rule after liquidation.

## Trade-Level Evidence

| Token | Hold to sell signal | Pool transactions, buy→sell | Entry deviation | Stop signal PNL | Realized PNL | Gross SOL PNL | Sell fill vs signal price |
|---|---:|---:|---:|---:|---:|---:|---:|
| `2Ck…pump` | 5.86 s | 733 | +6.01% | −41.83% | −41.63% | −0.003548331 | +0.35% |
| `A6J…pump` | 35.63 s | 580 | +7.56% | −41.10% | −43.47% | −0.004269377 | −4.02% |
| `GRP…pump` | 273.72 s | 414 | +0.02% | −42.76% | −53.31% | −0.005261619 | −18.43% |
| `6oF…pump` | 11.36 s | 31 | +0.02% | −32.22% | −40.54% | −0.004003973 | −12.28% |

`Pool transactions` counts all signatures involving the bonding-curve account between the successful buy and successful sell signatures. It describes transaction intensity, not only decoded successful trades.

## Multi-Wallet Sell Clusters Likely Caused the Dumps

The final successful Pump.fun trades before each bot exit show sell volume spread across many wallets, with multiple wallets selling in the same Solana slot. This is consistent with a bundled or coordinated holder exit rather than one ordinary retail seller.

| Token | Final successful-trade sample | BUY SOL | SELL SOL | Distinct sellers | Strongest same-slot cluster |
|---|---:|---:|---:|---:|---:|
| `2Ck…pump` | 30 successful transactions | 0.667 | 3.889 | 6 | 2 wallets, 2.600 SOL |
| `A6J…pump` | Final 30 attempts | 0.312 | 9.814 | 16 | 4 wallets, 3.089 SOL |
| `GRP…pump` | Final 30 attempts | 0.791 | 10.080 | 23 | 13 wallets, 8.804 SOL |
| `6oF…pump` | Final 30 attempts | 2.074 | 15.395 | 15 | 5 wallets, 5.503 SOL |

The concentration was particularly sharp:

- `2Ck…`: its three largest sellers accounted for 97.7% of sampled sell SOL. Two large sellers exited in the same slot.
- `A6J…`: four wallets sold 3.09 SOL in one slot; another three sold 3.93 SOL in one slot.
- `GRP…`: thirteen wallets sold 8.80 SOL in the same slot. Most sampled sellers sold exactly once, which is a strong distributed-exit signature.
- `6oF…`: five wallets sold 5.50 SOL in one slot and three more sold 2.92 SOL in another.

**Conclusion:** multi-wallet sell clustering is verified for all four. A common controller or bundler is highly plausible for `GRP…`, plausible for `A6J…` and `6oF…`, and possible but less strongly established for `2Ck…`. Proving shared ownership would require wallet-funding, token-acquisition, or bundle-relay linkage analysis.

## The Stops Reacted to Fast, Discontinuous Dumps

These exits did not happen in a smooth market. `2Ck…` crossed the old −40% stop less than six seconds after its buy amid 733 pool-account transactions. `6oF…` crossed the current −30% stop in about eleven seconds. Since the bot evaluates PNL on observed trade events, the first event below a threshold can be materially below it.

The stop signals were therefore consistent with the configured price rules. Later recovery does not by itself make those signals incorrect: holding through a 30–50% drawdown is a different risk policy and would also retain tokens that never recover.

## Entry Quality Explains Two of the Four Losses

### `2Ck…pump` would fail the new maximum-return rule

The target-sell price was `0.0000764588272`, while the two-second confirmation final price was `0.0000975295887`. That is a +27.56% rebound before the entry signal. The newly implemented +10% maximum return rejects this chase entry.

The submitted transaction observed an even higher current mark (`0.0001203477224`), and the eventual fill was 6.01% above the stored entry signal. This trade should be treated as an entry-control failure in the historical strategy, not evidence for relaxing the stop.

### `A6J…pump` was filled after a failed first BUY

The first buy failed. The second attempt filled 7.56% above the original entry signal, still below the current 10% deviation limit. Tightening `MAX_ENTRY_DEVIATION_PCT` to 5% would reject a retry at that price and would have avoided this historical trade.

### `GRP…pump` and `6oF…pump` had clean fills

Both filled only about 0.02% above their entry signals. Their losses cannot be attributed to entry latency or chase fills. They are genuine examples where the market dumped after a valid live entry.

## SELL Execution Is the Repeated Operational Weakness

All four first sell transactions failed with Pump error 6003:

```text
TooLittleSolReceived: slippage: Too little SOL received to sell the given amount of tokens
```

The configured sell slippage is 300 bps (3%). During these dumps, the prepared minimum output became stale before execution. Each retry rebuilt the transaction and succeeded about 0.8–1.5 seconds after the initial submission.

The largest signal-to-fill deterioration was `GRP…` (−18.43%) and `6oF…` (−12.28%). This difference includes market movement, AMM impact from liquidating the full position, fees, and execution delay; it should not be interpreted as latency alone.

## Proposed Re-Entry Rule Has High False-Positive Risk

The proposed re-entry rule should not be implemented unchanged. Its dump detector is useful, but the recovery trigger—one BUY larger than 0.1 SOL—does not establish that the dump has ended.

Main disadvantages:

1. **The same-slot condition is incomplete at sell-signal time.** The bot must decide from events observed so far, but additional sellers can arrive later in the same slot. Freezing eligibility exactly when the stop fires will miss some real bundles.
2. **One 0.1 SOL BUY can be a fake bounce.** It is only 3.3% of the minimum qualifying 3 SOL sell volume and may come from the same bundler, a sandwich bot, or ordinary noise.
3. **There is no price-recovery requirement.** The bot can re-enter while price is still making new lows because the trigger checks BUY size, not price reclaim or stabilization.
4. **The strategy may become exit liquidity twice.** Coordinated sellers can dump, submit a small BUY to create activity, and continue selling after the bot re-enters.
5. **Losses compound.** A historical original loss of roughly 40–53%, followed by a re-entry stop nominally at −20%, creates two sets of AMM impact, Pump fees, priority fees, tips, and slippage. Realized re-entry loss can exceed −20%.
6. **Absolute SOL thresholds do not scale with liquidity.** A 0.1 SOL BUY can be meaningful in a small pool and irrelevant in a large one; similarly, 3 SOL of sells has different impact across curves.
7. **The 60-second watcher consumes capacity.** Multiple stopped tokens waiting for re-entry keep subscriptions and state alive, potentially increasing stream load and interacting with position/exposure limits.
8. **The evidence cohort is selected after recovery.** The four examples do not include bundle-dumped tokens that never recovered, so they cannot estimate re-entry expectancy.

A safer backtest variant should require the original 0.1 SOL BUY plus confirmation:

```text
Wait until the dump slot closes
AND one BUY > 0.1 SOL
AND rolling BUY pressure >= 60%
AND at least 3 distinct buyers
AND price is 10–15% above the post-exit low
AND no new low for 1–2 seconds
```

The one-minute timeout and one-re-entry limit are sensible guardrails. Re-entry PNL should be based on executable liquidation value rather than only the marginal event price.

## Recommended Sell-Logic Experiments

1. **Keep a hard catastrophic stop.** Do not replace the current stop with an unconditional delay based on these four recovered tokens.
2. **Trigger risk from an executable sell quote.** Compare expected net liquidation proceeds with entry cost instead of relying only on the marginal event price. This accounts for position size, AMM impact, and fees before the stop is breached.
3. **Use stop-specific adaptive slippage.** Rebuild immediately from current reserves and allow a separately capped `TSR_STOP_SELL_SLIPPAGE_BPS`. Test 5%, 10%, 15%, and 20% against realized proceeds and failure rate. Avoid unlimited slippage.
4. **Retain pool monitoring after a stop.** The current runtime unsubscribes immediately after closing. Keep a bounded cooldown watcher so later recovery is measurable.
5. **Test re-entry instead of delayed liquidation.** After a stop, re-enter only if price stops making new lows, reclaims a defined level, and buy pressure passes a fresh confirmation window. This preserves downside control while allowing participation in real rebounds.
6. **Backtest on every stopped trade.** Compare the current stop, a persistence-based soft stop plus hard floor, and stop-then-re-entry. Include tokens that never recovered to avoid survivorship bias.
7. **Backtest a bundle-sell emergency exit.** Maintain a rolling one-to-two-second window of seller wallets and SOL flow. Exit before the normal stop when distinct-seller count, sell pressure, and sell volume all indicate a coordinated dump.

## Suggested Candidate Policy for Backtesting

```text
Soft stop: observed or executable PNL <= -30%
  -> require 1 second persistence or two consecutive events

Hard stop: executable PNL <= -40%
  -> sell immediately with adaptive stop slippage

After confirmed exit:
  -> continue observing for 60 seconds
  -> no new low for 2 seconds
  -> price reclaims 15% above post-exit low
  -> buy pressure >= 60%
  -> optional one-time re-entry

Candidate bundle emergency exit:
  -> rolling window = 2 seconds
  -> distinct sellers >= 3
  -> SELL pressure >= 85%
  -> total SELL volume >= 2 SOL
  -> or same-slot sellers >= 3 with >= 2 SOL sold
```

This is an experiment design, not a production recommendation. Thresholds must be swept across the complete stopped-trade population.

## Further Questions

- How high did each token recover, and how long after the exit did recovery begin?
- Did recovery exceed the original entry price after accounting for a second set of fees and AMM impact?
- How many stopped tokens during the same period never recovered by 15%, 30%, or to breakeven?
- Would smaller position sizing reduce the gap between signal PNL and executable liquidation PNL?

## Caveats and Assumptions

- Lifecycle logs and the recovery journal are authoritative for bot signals, fills, and gross SOL transferred. Network fees, priority fees, and tips are not subtracted from the gross PNL table.
- On-chain signature history verified transaction counts and error 6003 for every first sell. A full decoded post-exit price replay was not completed because the configured RPC rate-limited the bulk transaction request.
- The multi-wallet analysis decodes bounded samples immediately preceding each successful sell. Same-slot clustering is authoritative; common ownership remains an inference because funding and acquisition links were not established.
- The four-token sample was chosen after observing rebounds, so it cannot estimate whether a wider stop or delayed stop improves portfolio-level PNL.

