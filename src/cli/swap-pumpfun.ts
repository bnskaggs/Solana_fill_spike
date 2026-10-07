import { Connection } from "@solana/web3.js";
import { config, requireRuntimeSecrets } from "../config";
import { appendTradeLog } from "../log";
import { runRoundTrip } from "../runner";
import { loadKeypair } from "../wallet";
import { arg, numberArg } from "./args";
import type { TradeMode } from "../types";

async function main() {
  const runtime = requireRuntimeSecrets();
  const tokenMint = arg("token");
  if (!tokenMint) throw new Error("Usage: npm run swap:pumpfun -- --token=<pump.fun mint> [--sol=0.01] [--run=my-run]");

  const solAmount = numberArg("sol", config.defaultSolAmount);
  const runId = arg("run", config.runId) ?? config.runId;
  const mode = (arg("mode", "calm") === "hot" ? "hot" : "calm") as TradeMode;
  const graduatedAt = arg("graduated-at");
  const connection = new Connection(runtime.rpcUrl, "confirmed");
  const wallet = await loadKeypair(runtime.keypairPath);

  const trade = await runRoundTrip({
    connection,
    wallet,
    tokenMint,
    solAmount,
    runId,
    route: "pumpfun-round-trip",
    mode,
    graduatedAt,
  });
  trade.notes =
    "pump.fun-labeled path currently routes through Jupiter. If the mint is still on the bonding curve, Jupiter must support it; otherwise this fails cleanly.";
  appendTradeLog(config.runsDir, runId, trade);
  console.log(JSON.stringify(trade, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
