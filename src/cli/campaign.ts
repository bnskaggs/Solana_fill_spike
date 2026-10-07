import fs from "node:fs";
import { Connection } from "@solana/web3.js";
import { config, requireRuntimeSecrets } from "../config";
import { appendTradeLog } from "../log";
import { runRoundTrip } from "../runner";
import { loadKeypair } from "../wallet";
import { arg, numberArg } from "./args";
import type { TradeMode } from "../types";

interface TokenCandidate {
  symbol?: string;
  mint: string;
  route?: "jupiter-round-trip" | "pumpfun-round-trip";
  mode?: TradeMode;
  graduatedAt?: string;
}

async function main() {
  const runtime = requireRuntimeSecrets();
  const tokensPath = arg("tokens", "tokens.json") ?? "tokens.json";
  const count = Math.max(1, Math.floor(numberArg("count", 50)));
  const solAmount = numberArg("sol", config.defaultSolAmount);
  const runId = arg("run", config.runId) ?? config.runId;

  if (!fs.existsSync(tokensPath)) {
    throw new Error(`Token file not found: ${tokensPath}. Copy tokens.example.json to tokens.json and fill in mints.`);
  }

  const tokens = JSON.parse(fs.readFileSync(tokensPath, "utf8")) as TokenCandidate[];
  if (!tokens.length) throw new Error("Token file is empty");

  const connection = new Connection(runtime.rpcUrl, "confirmed");
  const wallet = await loadKeypair(runtime.keypairPath);

  for (let i = 0; i < count; i += 1) {
    const candidate = tokens[Math.floor(Math.random() * tokens.length)];
    console.log(`[${i + 1}/${count}] ${candidate.symbol ?? candidate.mint}`);
    const trade = await runRoundTrip({
      connection,
      wallet,
      tokenMint: candidate.mint,
      solAmount,
      runId,
      route: candidate.route ?? "jupiter-round-trip",
      mode: candidate.mode ?? "calm",
      graduatedAt: candidate.graduatedAt,
    });
    appendTradeLog(config.runsDir, runId, trade);
    console.log(`${trade.status} ${trade.id} shortfall=${trade.roundTripShortfallBps?.toFixed(1) ?? "n/a"}bps`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
