# Solana Fill-Quality Spike

A small harness that measures what a memecoin round trip on Solana actually
costs, and where the cost comes from. It asks one question:

> Can a minimal Solana executor land memecoin swaps with lower all-in cost than
> the big trading terminals (GMGN's 333 bps benchmark)?

It is not a terminal. There is no feed, charting, custody, or copy trading.

## Results (October 2026)

0.1 SOL round trips (buy, then immediately sell) through Jupiter, mostly on
pump.fun coins in the first two minutes after they graduate to PumpSwap.

- **When a trade lands, it fills at the quote.** 20 hot trades: median buy
  shortfall 0.1 bps, median sell 17 bps better than quoted. Coins 40 s old or
  younger: median buy 13 bps worse than quote.
- **The cost is the pool fee.** Median all-in cost 229 bps against a median
  estimated PumpSwap fee of 230 bps.
- **Landing is where naive execution fails.** Sending once with a minimal
  priority fee and a 30 s timeout, about half of sends on coins under two
  minutes old never landed, and two failed sells on dumping coins became
  near-total losses. With a Jupiter-estimated priority fee (median ~95k
  lamports per tx), re-sending until the blockhash expires, and sell retries
  with widening slippage, 38 of 39 legs landed (19 of 20 trades).
- **Not tested:** sizes above 0.1 SOL, Jito bundles.

## Safety

- Use a fresh hot wallet only.
- Fund it with a capped bankroll only.
- Never commit `.env`, keypair files, wallets, or `runs/`.

## Setup

```powershell
npm install
Copy-Item .env.example .env
```

Edit `.env`:

```txt
RPC_URL=https://mainnet.helius-rpc.com/?api-key=...
KEYPAIR_PATH=..\solana-fill-spike-wallet.json
RUN_ID=manual
DEFAULT_SOL_AMOUNT=0.01
```

The keypair can be either a Solana CLI JSON array or a base58 secret key. Keep it
outside the repo or in a gitignored path. No Solana CLI needed:

```powershell
npm run wallet -- new     # writes KEYPAIR_PATH, prints only the public address
npm run wallet -- show    # public address + SOL balance (needs RPC_URL)
npm run wallet -- close   # closes empty SPL Token and Token-2022 accounts to recover rent
```

## One Jupiter round trip

```powershell
npm run swap:jupiter -- --token=<mint> --sol=0.01 --run=manual
```

This buys the token with SOL and sells the filled amount back to SOL. Each leg is
logged to `runs/<run>.jsonl`.

`npm run swap:pumpfun` takes the same arguments and labels the trade as a
pump.fun route; it also goes through Jupiter.

## Hot-moment campaign

Quiet small round trips mostly re-measure the PumpSwap fee table. The hot
campaign watches fresh graduations and lets you click one capped trade while
the market is moving.

In one terminal:

```powershell
npm run watch:graduations
```

In another:

```powershell
npm run serve
```

Open `http://localhost:8733`. The Fresh Graduations table updates every 5
seconds. Each row has a `Trade 0.1 SOL` button. Server guards:

- `MAX_TRADE_SOL=0.1`
- `MAX_RUN_LOSS_SOL=0.25`: SOL actually lost in the run, excluding recoverable
  rent.
- `MAX_RUN_TRADES=30`: start a new run ID after that.
- `MAX_CONSECUTIVE_FAILS=3`
- One trade at a time. Parallel trades on the same pool trade against each
  other and corrupt the numbers.

Execution settings:

- `PRIORITY_LEVEL=veryHigh` with `PRIORITY_MAX_LAMPORTS=200000`: Jupiter
  estimates the priority fee, capped at 0.0002 SOL per leg. `fixed` uses
  `PRIORITY_FEE_MICRO_LAMPORTS` instead.
- The signed tx is re-sent every ~2 s until it lands or its blockhash expires.
- Failed sells retry up to `SELL_ATTEMPTS=3` times with a fresh quote and
  doubling slippage.
- After a failed round trip, leftover tokens are detected and sold.

Each trade is split into `landingCostBps` (quote vs fill, the part execution
can improve), `poolFeeBps` (estimated from pump.fun's public fee table), and
`driftBps` (market movement).

## Calm-control campaign

Copy `tokens.example.json` to `tokens.json`, fill in established mints, then:

```powershell
npm run campaign -- --tokens=tokens.json --count=50 --sol=0.01 --run=campaign-001
```

## Summary CLI

```powershell
npm run summary -- --run=campaign-001
npm run summary -- --mode=hot
```
