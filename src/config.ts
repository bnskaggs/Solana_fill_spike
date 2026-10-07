import "dotenv/config";
import path from "node:path";
import { z } from "zod";

const EnvSchema = z.object({
  RPC_URL: z.string().url().optional(),
  KEYPAIR_PATH: z.string().optional(),
  RUN_ID: z.string().default("manual"),
  RUNS_DIR: z.string().default("runs"),
  DEFAULT_SOL_AMOUNT: z.coerce.number().positive().default(0.01),
  PRIORITY_FEE_MICRO_LAMPORTS: z.coerce.number().int().nonnegative().default(10_000),
  SLIPPAGE_BPS: z.coerce.number().int().positive().default(150),
  HOT_SLIPPAGE_BPS: z.coerce.number().int().positive().default(500),
  /** "fixed" uses PRIORITY_FEE_MICRO_LAMPORTS; otherwise Jupiter estimates the fee at this level, capped by PRIORITY_MAX_LAMPORTS. */
  PRIORITY_LEVEL: z.enum(["fixed", "medium", "high", "veryHigh"]).default("veryHigh"),
  PRIORITY_MAX_LAMPORTS: z.coerce.number().int().positive().default(200_000),
  SELL_ATTEMPTS: z.coerce.number().int().positive().default(3),
  JUPITER_INDEX_TIMEOUT_MS: z.coerce.number().int().positive().default(180_000),
  MAX_TRADE_SOL: z.coerce.number().positive().default(0.1),
  MAX_RUN_LOSS_SOL: z.coerce.number().positive().default(0.25),
  MAX_RUN_TRADES: z.coerce.number().int().positive().default(30),
  MAX_CONSECUTIVE_FAILS: z.coerce.number().int().nonnegative().default(3),
  JITO_BLOCK_ENGINE_URL: z.string().url().optional(),
});

const parsed = EnvSchema.parse(process.env);

export const config = {
  rpcUrl: parsed.RPC_URL,
  keypairPath: parsed.KEYPAIR_PATH,
  runId: parsed.RUN_ID,
  runsDir: path.resolve(parsed.RUNS_DIR),
  defaultSolAmount: parsed.DEFAULT_SOL_AMOUNT,
  priorityFeeMicroLamports: parsed.PRIORITY_FEE_MICRO_LAMPORTS,
  slippageBps: parsed.SLIPPAGE_BPS,
  hotSlippageBps: parsed.HOT_SLIPPAGE_BPS,
  priorityLevel: parsed.PRIORITY_LEVEL,
  priorityMaxLamports: parsed.PRIORITY_MAX_LAMPORTS,
  sellAttempts: parsed.SELL_ATTEMPTS,
  /** Bumped when the send/landing logic changes, so before/after landing rates can be split. */
  executorVersion: "v2-rebroadcast",
  jupiterIndexTimeoutMs: parsed.JUPITER_INDEX_TIMEOUT_MS,
  maxTradeSol: parsed.MAX_TRADE_SOL,
  maxRunLossSol: parsed.MAX_RUN_LOSS_SOL,
  maxRunTrades: parsed.MAX_RUN_TRADES,
  maxConsecutiveFails: parsed.MAX_CONSECUTIVE_FAILS,
  jitoBlockEngineUrl: parsed.JITO_BLOCK_ENGINE_URL,
  // quote-api.jup.ag/v6 stopped resolving (verified 2026-10-06). lite-api is the free, keyless tier;
  // api.jup.ag/swap/v1 is the same API behind an x-api-key if we ever need higher rate limits.
  jupiterQuoteUrl: process.env.JUPITER_QUOTE_URL ?? "https://lite-api.jup.ag/swap/v1/quote",
  jupiterSwapUrl: process.env.JUPITER_SWAP_URL ?? "https://lite-api.jup.ag/swap/v1/swap",
};

export const programs = {
  pump: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  pumpSwap: "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
};

export const mints = {
  sol: "So11111111111111111111111111111111111111112",
  usdc: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
};

export const benchmarks = {
  gmgn: { medianShortfallBps: 333, failRatePct: 1.83 },
  axiom: { medianShortfallBps: 405, failRatePct: 4.68 },
};

export function requireRuntimeSecrets(): { rpcUrl: string; keypairPath: string } {
  const missing = [
    config.rpcUrl ? null : "RPC_URL",
    config.keypairPath ? null : "KEYPAIR_PATH",
  ].filter(Boolean);
  if (missing.length) {
    throw new Error(
      `Missing required runtime setting(s): ${missing.join(", ")}. Copy .env.example to .env and set them.`,
    );
  }
  return { rpcUrl: config.rpcUrl!, keypairPath: config.keypairPath! };
}
