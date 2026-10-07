import { config } from "../config";
import { readTradeLogs } from "../log";
import { engineOf, modeOf, summariseTrades } from "../stats";
import type { Engine, TradeMode } from "../types";
import { arg } from "./args";

const runId = arg("run");
const engineArg = arg("engine") as Engine | "all" | undefined;
const modeArg = arg("mode") as TradeMode | "all" | undefined;
const trades = readTradeLogs(config.runsDir, runId);

if ((engineArg && engineArg !== "all") || (modeArg && modeArg !== "all")) {
  console.log(JSON.stringify(summariseTrades(trades, runId ?? "all", engineArg ?? "all", modeArg ?? "all"), null, 2));
} else {
  const engines = [...new Set(trades.map(engineOf))].sort();
  const modes = [...new Set(trades.map(modeOf))].sort();
  const out = {
    all: summariseTrades(trades, runId ?? "all"),
    byEngine: Object.fromEntries(
      engines.map((engine) => [engine, summariseTrades(trades, runId ?? "all", engine)]),
    ),
    byMode: Object.fromEntries(
      modes.map((mode) => [mode, summariseTrades(trades, runId ?? "all", "all", mode)]),
    ),
  };
  console.log(JSON.stringify(out, null, 2));
}
