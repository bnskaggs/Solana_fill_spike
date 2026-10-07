import type { Engine, Summary, TradeLog, TradeMode } from "./types";

export function engineOf(trade: TradeLog): Engine {
  return trade.engine ?? "spike";
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function percentile(values: number[], pct: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1);
  return sorted[idx];
}

export function shortfallBps(quotedOutputRaw: string, actualOutputRaw?: string): number | undefined {
  if (!actualOutputRaw) return undefined;
  const quoted = Number(quotedOutputRaw);
  const actual = Number(actualOutputRaw);
  if (!Number.isFinite(quoted) || !Number.isFinite(actual) || quoted <= 0) return undefined;
  return ((quoted - actual) / quoted) * 10_000;
}

export function summariseTrades(
  trades: TradeLog[],
  runId = "all",
  engine: Engine | "all" = "all",
  mode: TradeMode | "all" = "all",
): Summary {
  if (engine !== "all") trades = trades.filter((trade) => engineOf(trade) === engine);
  if (mode !== "all") trades = trades.filter((trade) => modeOf(trade) === mode);
  const legs = trades.flatMap((trade) => [trade.buy, trade.sell].filter(Boolean));
  const landed = trades.filter((trade) => trade.status === "landed").length;
  const failed = trades.filter((trade) => trade.status === "failed").length;
  const shortfalls = legs
    .map((leg) => leg?.quoteShortfallBps)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const times = legs.map((leg) => leg?.timeToLandMs).filter(isNum);
  const processedTimes = legs.map((leg) => leg?.timeToProcessedMs).filter(isNum);
  const allIn = trades.map((trade) => trade.allInCostBps).filter(isNum);
  const landing = trades.map((trade) => trade.landingCostBps).filter(isNum);
  const poolFees = trades.map((trade) => trade.poolFeeBps).filter(isNum);
  const drift = trades.map((trade) => trade.driftBps).filter(isNum);
  const indexingLags = trades.map((trade) => trade.indexingLagMs).filter(isNum);

  return {
    runId,
    engine,
    mode,
    trades: trades.length,
    landed,
    failed,
    failRatePct: trades.length ? (failed / trades.length) * 100 : 0,
    medianQuoteShortfallBps: median(shortfalls),
    p75QuoteShortfallBps: percentile(shortfalls, 75),
    medianAllInCostBps: median(allIn),
    medianLandingCostBps: median(landing),
    medianPoolFeeBps: median(poolFees),
    medianDriftBps: median(drift),
    medianIndexingLagMs: median(indexingLags),
    medianTimeToProcessedMs: median(processedTimes),
    medianTimeToLandMs: median(times),
  };
}

export function modeOf(trade: TradeLog): TradeMode {
  return trade.mode ?? "calm";
}
