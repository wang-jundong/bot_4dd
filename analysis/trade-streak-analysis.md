# Trade streak and position-sizing analysis

## TL;DR

The supplied archive contains 67 complete Pump.fun token histories and 123,400 market events from 2026-08-26 06:38:55 UTC through 2026-08-31 06:54:37 UTC. For wallet `EqdQgjXzYu1GZ4XKkTqmf8CgZkCbhAkX9bkJv9CrDJ3K`, it contains 74 BUYs and 75 SELLs. FIFO matching yields 74 closed trades and one unmatched SELL.

The 74 matched trades contain 39 wins and 35 losses (52.70% win rate) and +0.026329935 SOL gross curve-flow PNL before network fees, priority fees, tips, and any costs absent from the export.

Results are clustered: a win was followed by another win 69.23% of the time (27/39), while a loss was followed by a win only 35.29% of the time (12/34). Longest runs were 11 wins and 8 losses. This supports testing a regime-aware sizing rule, but does not prove that the pattern will persist because the sample is small, spans only five days, and is in-sample.

Under the proposed state machine—reduce sizing after at least three consecutive wins followed by a loss, restore default sizing after at least three consecutive losses followed by a win—15 of 74 trades would use reduced size. Assuming PNL scales linearly with size:

| Reduced-size multiplier | Simulated gross PNL | Change vs. default |
|---:|---:|---:|
| 0.00 | +0.041469450 SOL | +0.015139515 SOL |
| 0.25 | +0.037684570 SOL | +0.011354635 SOL |
| 0.50 | +0.033899690 SOL | +0.007569755 SOL |
| 0.75 | +0.030114810 SOL | +0.003784875 SOL |
| 1.00 | +0.026329935 SOL | baseline |

The rule improved gross PNL in this sample because the trades placed in reduced mode had negative aggregate PNL. It did **not** improve full-period maximum drawdown: the worst drawdown was -0.03396433 SOL for every multiplier because the dataset begins with eight losses, before the proposed activation condition could fire.

## Exact rule tested

1. Start in normal mode at 1.0× the default buy amount.
2. When a loss immediately follows a run of at least three wins, switch to reduced mode for the **next** trade.
3. Stay in reduced mode.
4. When a win immediately follows a run of at least three losses, restore normal mode for the **next** trade.

This interpretation matters: the trigger trade itself retains the sizing mode selected before entry. The reduced multiplier has not yet been specified by the strategy owner, so the table reports a scenario grid rather than selecting a production value.

## Observed sequence

`LLLLLLLLWLWWLLWLLWLWLLWLWWLWWWWWWWLLLLLLWWWWWWWWWWWLWWWLLLLLWWLLLLWWWWWWWL`

Run lengths:

`L8, W1, L1, W2, L2, W1, L2, W1, L1, W1, L2, W1, L1, W2, L1, W7, L6, W11, L1, W3, L5, W2, L4, W7, L1`

The strategy entered reduced mode twice in the sample:

- Starting with trade 36 on 2026-08-29, and returning to normal at trade 42.
- Starting with trade 53 on 2026-08-30, and returning to normal at trade 62.

The exact pattern `WWWL` appeared three times; the following outcomes were loss, win, loss. The exact pattern `LLLW` appeared four times; the following outcomes were loss, win, win, win. These counts are too small to estimate reliable conditional probabilities.

## Data quality and methodology

- All 67 files report `status=complete`.
- All 123,400 events have required transaction fields and valid BUY/SELL sides.
- File-level `event_count` agrees with the actual event array length for every file.
- Event mint values agree with the containing file's mint.
- No duplicate event keys were found using signature, mint, wallet, side, and token amount.
- One market event has a non-positive amount and should be inspected before event-volume studies; it does not affect the wallet's matched trade set.
- The unmatched wallet SELL is for `GptB2MxtjhYmnfg7yXNaC4C49GShb8M1gq6FpFgHpump` at Unix time 1787766832. Its corresponding BUY is outside the supplied archive or otherwise missing, so it is excluded.
- Wallet BUYs and SELLs were sorted chronologically and matched FIFO within each mint. Gross PNL is `SELL sol_amount - BUY sol_amount`.
- The archive contains Pump.fun events only. The lifecycle journal also contains PumpSwap positions and extends beyond the archive's time/mint coverage, so the two sources are not interchangeable.

## Recommendation

Do not hard-code this rule as a proven profit enhancer yet. Add it behind a feature flag, define the reduced multiplier explicitly, and paper-trade or shadow-log the decisions on an out-of-sample cohort. Record both actual PNL and counterfactual default-size PNL. Re-evaluate after at least several hundred closed positions and include all transaction costs.

The safest initial experiment is a 0.5× reduced multiplier rather than skipping trades entirely. In this sample it preserves part of the recovery upside while improving gross PNL by 0.007569755 SOL. Add a cold-start protection separately if the objective includes drawdown reduction, because the proposed win-to-loss trigger cannot react to an initial losing regime.
