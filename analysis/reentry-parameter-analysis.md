# Re-entry parameter analysis

## Recommendation

Keep the current re-entry parameters except add an upper confirmation BUY-pressure cap:

```env
TSR_REENTRY_MIN_BUY_PRESSURE=0.60
TSR_REENTRY_MAX_BUY_PRESSURE=0.90
TSR_REENTRY_MIN_DISTINCT_BUYERS=3
TSR_REENTRY_MIN_RECOVERY_PCT=10
TSR_REENTRY_MAX_TRIGGER_RETURN_PCT=15
TSR_REENTRY_TAKE_PROFIT_PCT=30
TSR_REENTRY_STOP_LOSS_PCT=-20
TSR_REENTRY_MAX_HOLD_SEC=600
```

`TSR_REENTRY_MAX_BUY_PRESSURE` does not exist in the current code and would require implementation. The suggested rule is `0.60 <= confirmation buy pressure <= 0.90`.

## Replay results

The uploaded archive covers 67 Pump.fun tokens, 123,400 events, 74 matched wallet trades, and 35 losing exits from 2026-08-26 through 2026-08-31 UTC.

Using the current dump and confirmation parameters produced nine simulated re-entries:

- 4 TP and 5 SL
- 44.4% win rate
- +31.31 aggregate percentage points of gross return
- Approximate +0.00313 SOL at a fixed 0.01 SOL per entry before fees and fill differences

Adding a 90% maximum confirmation BUY-pressure cap produced:

- 5 simulated re-entries
- 4 TP and 1 SL
- 80.0% win rate
- +114.93 aggregate percentage points of gross return
- Approximate +0.01149 SOL at a fixed 0.01 SOL per entry before fees and fill differences

The four removed entries were all losses. Their confirmation BUY pressures ranged from about 93.1% to 100%. The result is unchanged for maximum caps from 85% through 92.5%, which makes 90% a reasonable round experimental setting.

## Exit sweep

With the 90% maximum BUY-pressure cap, TP +30% and SL -20% had the best balance in the later-period check:

| TP / SL | Full aggregate return | Later-period return | Comment |
|---|---:|---:|---|
| +20 / -20 | +68.2 pp | -0.7 pp | Takes profit too early |
| +25 / -20 | +84.5 pp | +4.6 pp | Better, but below current TP |
| +30 / -20 | +114.9 pp | +10.6 pp | Recommended |
| +40 / -20 | +123.1 pp | -5.0 pp | Higher in-sample, worse later |
| +50 / -20 | +79.9 pp | -5.0 pp | Too ambitious |
| +60 / -20 | +97.5 pp | -5.0 pp | Too ambitious |

Tightening SL from -20% to -15% reduced the number of winners because volatile recoveries hit the tighter stop before rebounding. Loosening SL below -20% reduced results. Keep -20%.

## Parameters that should remain unchanged

- Dump window: 2 seconds
- Minimum dump sell pressure: 0.85
- Minimum dump sell volume: 3 SOL
- Same-slot sellers: 3
- Wait window: 60 seconds
- Trigger BUY: strictly greater than 0.1 SOL
- Confirmation: 2 seconds
- Minimum confirmation BUY pressure: 0.60
- Minimum distinct buyers: 3
- Minimum recovery: 10%
- No-new-low interval: 1 second
- Maximum trigger return: 15%
- Take profit: +30%
- Stop loss: -20%
- Maximum hold: 600 seconds

Lowering dump pressure from 0.85 to 0.80 added only one profitable observation. Lowering minimum sell volume to 2 SOL added a loser. Relaxing buyer count, minimum BUY pressure, recovery, wait time, or trigger size did not reliably improve results. These changes are not supported by enough observations.

## Important limitations

- The archive has timestamps at one-second resolution, while live execution is sub-second. Replayed entry and exit fills are approximations.
- The archive uses the wallet SELL as the exit reference. Live dump eligibility is frozen at the exit signal before the actual SELL confirmation, so the exact two-second window differs slightly.
- The archive replay found nine current-parameter dump candidates; the lifecycle journal recorded only three eligible live evaluations among 50 evaluations. This mismatch prevents treating the replay as an exact live backtest.
- Only five entries remain after the recommended cap, and only two occur in the later-period holdout. Statistical confidence is low.
- Gross returns exclude priority fees, tips, slippage, price impact, and dynamic 0.5x loss-streak sizing.
- The dataset contains Pump.fun events only and does not validate PumpSwap behavior.

## Deployment approach

Add the maximum BUY-pressure rule behind its own feature/config threshold, log rejected candidates and their counterfactual outcomes, and shadow-test it for at least 100 eligible re-entry candidates before relying on the estimated 80% win rate. Do not loosen the dump gate at the same time; changing one parameter family keeps the experiment interpretable.
