# Solana Fill Spike — agent rules

Purpose: measure whether a minimal Solana executor can match or beat the big
trading terminals (GMGN/Axiom) on memecoin fill quality. Trades are scored by
`src/stats.ts`; external executors' records can be scored by the same stats
under `engine: "external"`.

This is a spike, not a terminal and not a product.

Hard rules:

- Never commit a wallet key, API key, `.env`, or run folder.
- Never paste secrets into chat or docs.
- Use a fresh hot wallet with a capped bankroll only.
- Mainnet trades require explicit funding and approval from the wallet owner.
- No feed, charts-as-product, wallet management, custody, or copy trading in
  this repo.
