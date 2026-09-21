# PNL by market cap at BUY

## Direct answer

The uploaded trades performed best when the token's fully diluted market cap at the wallet BUY was below approximately **90–95 SOL**. Performance deteriorated sharply above this range.

The most defensible experimental entry filter is:

```text
Estimated market cap at entry < 95 SOL
```

A stricter 90 SOL cap gives a slightly higher-quality cohort but excludes eight additional trades that were net profitable in this sample. Treat 90–95 SOL as the supported range rather than claiming one exact optimum.

## Results by entry market cap

Market cap is calculated as:

```text
entry token price in SOL × 1,000,000,000 token supply
```

| Entry market cap | Trades | Wins | Win rate | Gross PNL | Median return | Profit factor |
|---|---:|---:|---:|---:|---:|---:|
| <60 SOL | 1 | 1 | 100.0% | +0.025676 SOL | +260.0% | n/a |
| 60–75 SOL | 8 | 7 | 87.5% | +0.017403 SOL | +26.9% | 5.10 |
| 75–90 SOL | 26 | 16 | 61.5% | +0.006503 SOL | +21.6% | 1.18 |
| 90–110 SOL | 20 | 8 | 40.0% | -0.006274 SOL | -26.1% | 0.85 |
| 110–140 SOL | 13 | 5 | 38.5% | -0.008525 SOL | -29.0% | 0.64 |
| ≥140 SOL | 6 | 2 | 33.3% | -0.008453 SOL | -30.9% | 0.37 |

Overall: 74 matched trades, 39 wins, 35 losses, 52.7% gross win rate, and +0.026330 SOL gross PNL.

## Threshold comparison

| Entry rule | Trades | Win rate | Gross PNL | Median return |
|---|---:|---:|---:|---:|
| MC <80 SOL | 15 | 86.7% | +0.050376 SOL | +23.3% |
| MC <85 SOL | 25 | 72.0% | +0.047875 SOL | +23.2% |
| MC <90 SOL | 35 | 68.6% | +0.049582 SOL | +23.2% |
| MC <95 SOL | 43 | 65.1% | +0.056548 SOL | +23.2% |
| MC <100 SOL | 46 | 60.9% | +0.048420 SOL | +21.6% |
| MC ≥95 SOL | 31 | 35.5% | -0.030218 SOL | -30.2% |

The <95 SOL rule produced the highest total gross PNL among the tested simple caps. The <80 SOL group had the highest win rate, but only 15 observations and substantially lower trade coverage.

## Earlier/later validation

Using 95 SOL as the cutoff:

| Period | Group | Trades | Win rate | Gross PNL | Median return |
|---|---|---:|---:|---:|---:|
| First 49 trades | MC <95 | 30 | 60.0% | +0.030882 SOL | +20.1% |
| First 49 trades | MC ≥95 | 19 | 36.8% | -0.015532 SOL | -29.0% |
| Last 25 trades | MC <95 | 13 | 76.9% | +0.025666 SOL | +27.6% |
| Last 25 trades | MC ≥95 | 12 | 33.3% | -0.014687 SOL | -31.7% |

The direction is consistent in both periods: lower-MC entries were profitable, while higher-MC entries were unprofitable.

## Outlier sensitivity

The <60 SOL band contains one exceptional +260% trade. Removing it:

- MC <90 SOL remains profitable at +0.023906 SOL.
- Win rate remains 67.6% across 34 trades.
- Median return remains +23.2%.
- MC ≥90 SOL remains unprofitable at -0.023252 SOL with a 38.5% win rate.

Therefore, the conclusion does not depend solely on that outlier.

## Interpretation

Higher entry market cap appears to mean the reversal is being bought later in the token's move. Above roughly 90–95 SOL, the median trade reaches approximately the configured stop-loss region rather than continuing upward. The current curve-progress minimum prevents very early entries but does not prevent late, high-market-cap entries.

A market-cap ceiling should complement—not replace—the existing curve progress, activity, pressure, drawdown, and return checks.

## Implementation consideration

The archive contains actual BUY fill price, but the bot must decide before that fill exists. A live filter should estimate market cap from the confirmation-final or current mark price:

```text
estimated_mc_sol = current_price_sol_per_token × 1,000,000,000
```

Because fill price can move after the signal, a 90 SOL signal cap is safer if the desired maximum actual-fill MC is approximately 95 SOL. The bot should log signal MC and actual fill MC separately.

## Limitations

- Market cap is denominated in SOL because the uploaded dataset has no historical SOL/USD series. USD market cap would require timestamp-aligned SOL/USD prices.
- The calculation assumes the standard Pump.fun 1 billion token supply and is best described as fully diluted market cap.
- Gross PNL excludes priority fees, tips, network fees, and costs not represented by `sol_amount`.
- Results cover only 74 trades across about five days; the exact 90–95 SOL boundary may move in another market regime.
- Nine token files are marked migrated, but their archived events are still Pump.fun-source events. PumpSwap behavior is not separately validated.
