import express from "express";
import path from "node:path";
import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { config, requireRuntimeSecrets } from "./config";
import { enrichedGraduations } from "./graduations";
import { appendTradeLog, readTradeLogs } from "./log";
import { runRoundTrip, solLostLamports } from "./runner";
import { engineOf, modeOf, summariseTrades } from "./stats";
import { loadKeypair } from "./wallet";
import type { Engine, TradeLog, TradeMode } from "./types";

const app = express();
const port = Number(process.env.PORT) || 8733;

// One connection for the whole server. Each Connection opens its own websocket for
// confirmations, and parallel ones blow through Helius free-tier limits (429s).
let shared: { connection: Connection; wallet: Keypair } | undefined;
async function runtimeContext() {
  if (!shared) {
    const runtime = requireRuntimeSecrets();
    shared = {
      connection: new Connection(runtime.rpcUrl, "confirmed"),
      wallet: await loadKeypair(runtime.keypairPath),
    };
  }
  return shared;
}

// Trades run one at a time: parallel round trips on the same pool trade against
// each other and contaminate the shortfall numbers.
let tradeInFlight: { tokenMint: string; startedAt: string } | undefined;

let balanceCache: { at: number; sol: number } | undefined;

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/api/trades", (req, res) => {
  const run = typeof req.query.run === "string" ? req.query.run : undefined;
  res.json(readTradeLogs(config.runsDir, run));
});

app.get("/api/summary", (req, res) => {
  const run = typeof req.query.run === "string" ? req.query.run : undefined;
  const trades = readTradeLogs(config.runsDir, run);
  res.json(summariseTrades(trades, run ?? "all"));
});

// One row per engine so the page can put an external executor and the spike side by side.
app.get("/api/summary/by-engine", (req, res) => {
  const run = typeof req.query.run === "string" ? req.query.run : undefined;
  const trades = readTradeLogs(config.runsDir, run);
  const engines: Engine[] = [...new Set(trades.map(engineOf))].sort();
  res.json(engines.map((engine) => summariseTrades(trades, run ?? "all", engine)));
});

app.get("/api/summary/by-mode", (req, res) => {
  const run = typeof req.query.run === "string" ? req.query.run : undefined;
  const trades = readTradeLogs(config.runsDir, run);
  const modes: TradeMode[] = [...new Set(trades.map(modeOf))].sort();
  res.json(modes.map((mode) => summariseTrades(trades, run ?? "all", "all", mode)));
});

app.get("/api/graduations", async (req, res) => {
  const run = typeof req.query.run === "string" ? req.query.run : config.runId;
  const maxAgeSec = Number(req.query.maxAgeSec ?? 900);
  res.json(await enrichedGraduations(Number.isFinite(maxAgeSec) ? maxAgeSec : 900, run));
});

app.get("/api/budget", async (req, res) => {
  const run = typeof req.query.run === "string" ? req.query.run : config.runId;
  const trades = spikeTrades(readTradeLogs(config.runsDir, run));
  let walletBalanceSol: number | undefined;
  if (config.rpcUrl && config.keypairPath) {
    if (!balanceCache || Date.now() - balanceCache.at > 30_000) {
      try {
        const { connection, wallet } = await runtimeContext();
        balanceCache = { at: Date.now(), sol: (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL };
      } catch {
        // keep the stale value on rate limits
      }
    }
    walletBalanceSol = balanceCache?.sol;
  }
  const lostSol = lostSolForRun(trades);
  res.json({
    run,
    trades: trades.length,
    maxRunTrades: config.maxRunTrades,
    lostSol,
    maxRunLossSol: config.maxRunLossSol,
    maxTradeSol: config.maxTradeSol,
    consecutiveFails: consecutiveFailures(trades),
    maxConsecutiveFails: config.maxConsecutiveFails,
    walletBalanceSol,
    tradeInFlight: tradeInFlight ?? null,
    canTrade: blockReason(trades, config.maxTradeSol) === undefined && !tradeInFlight,
    blockReason: tradeInFlight ? "trade in progress" : blockReason(trades, config.maxTradeSol) ?? null,
  });
});

app.post("/api/trade", async (req, res) => {
  if (tradeInFlight) {
    return res.status(409).json({ error: `trade already in progress (${tradeInFlight.tokenMint.slice(0, 6)}…)` });
  }
  const tokenMint = String(req.body.tokenMint ?? "");
  const solAmount = Number(req.body.solAmount ?? config.defaultSolAmount);
  const runId = String(req.body.runId ?? config.runId);
  const mode = (req.body.mode === "hot" ? "hot" : "calm") as TradeMode;
  const graduatedAt = typeof req.body.graduatedAt === "string" ? req.body.graduatedAt : undefined;
  if (!tokenMint) return res.status(400).json({ error: "tokenMint is required" });
  if (!Number.isFinite(solAmount) || solAmount <= 0) {
    return res.status(400).json({ error: "solAmount must be positive" });
  }
  const reason = blockReason(spikeTrades(readTradeLogs(config.runsDir, runId)), solAmount);
  if (reason) return res.status(400).json({ error: reason });

  tradeInFlight = { tokenMint, startedAt: new Date().toISOString() };
  try {
    const { connection, wallet } = await runtimeContext();
    const trade = await runRoundTrip({ connection, wallet, tokenMint, solAmount, runId, mode, graduatedAt });
    appendTradeLog(config.runsDir, runId, trade);
    balanceCache = undefined;
    return res.json(trade);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  } finally {
    tradeInFlight = undefined;
  }
});

app.listen(port, () => {
  console.log(`Solana fill spike results: http://localhost:${port}`);
});

function spikeTrades(trades: TradeLog[]): TradeLog[] {
  return trades.filter((trade) => trade.engine !== "external");
}

function blockReason(trades: TradeLog[], solAmount: number): string | undefined {
  if (solAmount > config.maxTradeSol) return `solAmount exceeds MAX_TRADE_SOL (${config.maxTradeSol})`;
  if (trades.length >= config.maxRunTrades) return `run has hit MAX_RUN_TRADES (${config.maxRunTrades}); start a new run id`;
  if (lostSolForRun(trades) >= config.maxRunLossSol) {
    return `run has lost ${lostSolForRun(trades).toFixed(4)} SOL, at MAX_RUN_LOSS_SOL (${config.maxRunLossSol})`;
  }
  if (consecutiveFailures(trades) >= config.maxConsecutiveFails) {
    return `stopped after ${config.maxConsecutiveFails} consecutive failed trades`;
  }
  return undefined;
}

function lostSolForRun(trades: TradeLog[]): number {
  return trades.reduce((sum, trade) => sum + solLostLamports(trade), 0) / LAMPORTS_PER_SOL;
}

function consecutiveFailures(trades: TradeLog[]): number {
  let count = 0;
  for (const trade of [...trades].reverse()) {
    if (trade.status === "landed") break;
    if (trade.status === "failed") count += 1;
  }
  return count;
}
