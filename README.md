# u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry-v2

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/tongsang199712-cyber/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry-v2/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/tongsang199712-cyber/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532-entry-v2/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Steady Scalper is a deterministic pump.fun paper-trading bot for the make.fun "Pump.fun Sharpe Sprint" bounty. It follows the creator's opening buy — but only when that buy is 0.2–1.25 SOL — stakes a fixed 0.30 SOL per coin (capped at 1% of the real SOL reserve), holds at most 5 coins at once, and exits fast and mechanically: +25% take-profit, −12% stop-loss, a trailing stop that arms at +15% and exits on a −10% pullback, a 100-slot maximum hold, or an immediate exit when the creator dumps 0.1 SOL or more. One buy per coin, no randomness, no network access — the strategy is a pure function of the replayed batches, built to maximize hourly Sharpe ratio with steady, controlled gains rather than one lucky moonshot.

## Run it

```sh
node main.ts
```

---

Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards
