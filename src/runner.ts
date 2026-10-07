import crypto from "node:crypto";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { config, mints } from "./config";
import { executeJupiterSwap, JupiterQuote, quoteSwap, solToLamportsRaw } from "./jupiter";
import {
  marketCapSolFromBuyQuote,
  marketCapSolFromSellQuote,
  pumpFeeBpsForMarketCap,
} from "./pumpfees";
import type { SwapLegLog, TradeLog, TradeMode } from "./types";

export interface RoundTripRequest {
  connection: Connection;
  wallet: Keypair;
  tokenMint: string;
  solAmount: number;
  runId?: string;
  route?: "jupiter-round-trip" | "pumpfun-round-trip";
  mode?: TradeMode;
  graduatedAt?: string;
  slippageBps?: number;
}

export async function runRoundTrip(request: RoundTripRequest): Promise<TradeLog> {
  const runId = request.runId ?? config.runId;
  const id = crypto.randomUUID();
  const route = request.route ?? "jupiter-round-trip";
  const mode = request.mode ?? "calm";
  const slippageBps = request.slippageBps ?? (mode === "hot" ? config.hotSlippageBps : config.slippageBps);
  const inputLamports = Number(solToLamportsRaw(request.solAmount));
  const startedAt = new Date();
  const graduatedAt = request.graduatedAt;
  let quoteAttempts: number | undefined;
  let indexingLagMs: number | undefined;
  let buyQuote: JupiterQuote | undefined;
  const walletLamportsBefore = await solBalanceLamports(request.connection, request.wallet.publicKey);

  if (mode === "hot") {
    const quoteResult = await waitForBuyQuote({
      inputMint: mints.sol,
      outputMint: request.tokenMint,
      amountRaw: solToLamportsRaw(request.solAmount),
      slippageBps,
      graduatedAt,
    });
    quoteAttempts = quoteResult.attempts;
    indexingLagMs = quoteResult.indexingLagMs;
    buyQuote = quoteResult.quote;
    if (!buyQuote) {
      const buy = skippedBuyLeg({
        tokenMint: request.tokenMint,
        amountRaw: solToLamportsRaw(request.solAmount),
        startedAt,
        error: "jupiter-no-route",
      });
      return {
        schemaVersion: 1,
        id,
        runId,
      engine: "spike",
      executorVersion: config.executorVersion,
      mode,
      createdAt: new Date().toISOString(),
      tokenMint: request.tokenMint,
      solAmount: request.solAmount,
      route,
      graduatedAt,
      ageAtTradeSec: ageAt(startedAt, graduatedAt),
        quoteAttempts,
        indexingLagMs,
        buy,
        status: "skipped",
        totalFeeLamports: 0,
        totalRentLamports: 0,
        totalTimeToLandMs: 0,
      };
    }
  }

  const buy = await executeJupiterSwap({
    connection: request.connection,
    wallet: request.wallet,
    inputMint: mints.sol,
    outputMint: request.tokenMint,
    amountRaw: solToLamportsRaw(request.solAmount),
    side: "buy",
    venue: route === "pumpfun-round-trip" ? "pumpfun-via-jupiter" : "jupiter",
    slippageBps,
    prefetchedQuote: buyQuote,
  });

  let sell: SwapLegLog | undefined;
  if (buy.status === "landed" && buy.actualOutputRaw && BigInt(buy.actualOutputRaw) > 0n) {
    // Holding a fresh coin is the expensive failure, so a failed sell retries with a
    // fresh quote and wider slippage. Landing-cost stats use the final attempt.
    const priorErrors: string[] = [];
    for (let attempt = 1; attempt <= config.sellAttempts; attempt += 1) {
      sell = await executeJupiterSwap({
        connection: request.connection,
        wallet: request.wallet,
        inputMint: request.tokenMint,
        outputMint: mints.sol,
        amountRaw: buy.actualOutputRaw,
        side: "sell",
        venue: route === "pumpfun-round-trip" ? "pumpfun-via-jupiter" : "jupiter",
        slippageBps: Math.min(slippageBps * 2 ** (attempt - 1), 3_000),
      });
      sell.attempts = attempt;
      if (priorErrors.length) sell.priorErrors = [...priorErrors];
      if (sell.status === "landed") break;
      priorErrors.push(sell.error ?? "unknown");
      // A send that timed out may still land; don't sell the same tokens twice.
      if (isUnknownOutcome(sell.error)) break;
      const held = await tokenBalanceRaw(request.connection, request.wallet.publicKey, request.tokenMint);
      if (held === undefined || BigInt(held) === 0n) break;
    }
  }

  const status = buy.status === "landed" && sell?.status === "landed" ? "landed" : "failed";
  let strandedTokenRaw: string | undefined;
  let cleanup: SwapLegLog | undefined;
  let walletLamportsAfter: number | undefined;
  if (status === "failed") {
    await settleUnknown(request.connection, [buy, sell]);
    strandedTokenRaw = await tokenBalanceRaw(request.connection, request.wallet.publicKey, request.tokenMint);
    if (strandedTokenRaw && BigInt(strandedTokenRaw) > 0n) {
      cleanup = await executeJupiterSwap({
        connection: request.connection,
        wallet: request.wallet,
        inputMint: request.tokenMint,
        outputMint: mints.sol,
        amountRaw: strandedTokenRaw,
        side: "sell",
        venue: route === "pumpfun-round-trip" ? "pumpfun-via-jupiter" : "jupiter",
        slippageBps: Math.max(slippageBps, 1_000),
      });
      if (cleanup.status === "landed") await sleep(1_500);
    }
    walletLamportsAfter = await solBalanceLamports(request.connection, request.wallet.publicKey);
  }
  const totalFeeLamports = (buy.feeLamports ?? 0) + (sell?.feeLamports ?? 0) + (cleanup?.feeLamports ?? 0);
  const totalRentLamports = (buy.rentLamports ?? 0) + (sell?.rentLamports ?? 0);
  const totalTimeToLandMs = (buy.timeToLandMs ?? 0) + (sell?.timeToLandMs ?? 0);
  const roundTripShortfallBps = computeRoundTripShortfall(request.solAmount, sell?.actualOutputRaw);
  const landingCostBps = sumBps(buy.quoteShortfallBps, sell?.quoteShortfallBps);
  const buyFeeBps =
    mode === "hot"
      ? pumpFeeBpsForMarketCap(marketCapSolFromBuyQuote(buy.inputAmountRaw, buy.quotedOutputRaw))
      : undefined;
  const sellFeeBps =
    mode === "hot" && sell
      ? pumpFeeBpsForMarketCap(marketCapSolFromSellQuote(sell.inputAmountRaw, sell.quotedOutputRaw))
      : undefined;
  const poolFeeBps =
    buyFeeBps !== undefined || sellFeeBps !== undefined ? (buyFeeBps ?? 0) + (sellFeeBps ?? 0) : undefined;
  const driftBps =
    poolFeeBps !== undefined && sell?.status === "landed" && sell.quotedOutputRaw
      ? ((Number(sell.quotedOutputRaw) - inputLamports) / inputLamports) * 10_000 + poolFeeBps
      : undefined;

  return {
    schemaVersion: 1,
    id,
    runId,
    engine: "spike",
    executorVersion: config.executorVersion,
    mode,
    createdAt: new Date().toISOString(),
    tokenMint: request.tokenMint,
    solAmount: request.solAmount,
    route,
    graduatedAt,
    ageAtTradeSec: ageAt(new Date(buy.sentAt), graduatedAt),
    quoteAttempts,
    indexingLagMs,
    buy,
    sell,
    strandedTokenRaw,
    cleanup,
    walletLamportsBefore,
    walletLamportsAfter,
    status,
    totalFeeLamports,
    totalRentLamports,
    totalTimeToLandMs,
    roundTripShortfallBps,
    // Swap shortfall plus tx fees, as bps of SOL in. Excludes rent (recoverable).
    allInCostBps:
      roundTripShortfallBps !== undefined
        ? roundTripShortfallBps + (totalFeeLamports / inputLamports) * 10_000
        : undefined,
    landingCostBps,
    poolFeeBps,
    driftBps,
  };
}

/**
 * SOL a trade actually cost (or may still have stuck in tokens), excluding
 * recoverable rent. Buys that never confirmed count as fully at risk, because
 * "not confirmed in time" does not mean "did not land".
 */
export function solLostLamports(trade: TradeLog): number {
  if (trade.engine === "external") return 0;
  const input = Number(solToLamportsRaw(trade.solAmount));
  const buy = trade.buy;
  const sell = trade.sell;
  if (buy.status === "skipped") return 0;
  // Failed trades: trust the wallet. Includes token-account rent, which is small and recoverable.
  if (trade.status === "failed" && trade.walletLamportsBefore !== undefined && trade.walletLamportsAfter !== undefined) {
    return Math.max(0, trade.walletLamportsBefore - trade.walletLamportsAfter);
  }
  if (buy.status !== "landed") {
    return isUnknownOutcome(buy.error) ? input : buy.feeLamports ?? 0;
  }
  if (!sell || sell.status !== "landed") return input + (buy.feeLamports ?? 0);
  if (buy.walletSolDeltaLamports !== undefined && sell.walletSolDeltaLamports !== undefined) {
    const net = Number(buy.walletSolDeltaLamports) + Number(sell.walletSolDeltaLamports);
    return Math.max(0, -net - (trade.totalRentLamports ?? 0));
  }
  return Math.max(0, input - Number(sell.actualOutputRaw ?? 0) + (trade.totalFeeLamports ?? 0));
}

function isUnknownOutcome(error?: string): boolean {
  return !!error && /not confirmed|timed? ?out|block height exceeded/i.test(error);
}

/** A tx that "wasn't confirmed in 30 s" can still land until its blockhash expires (~60–90 s). */
async function settleUnknown(connection: Connection, legs: Array<SwapLegLog | undefined>): Promise<void> {
  const pending = legs.filter((leg) => leg?.status === "failed" && leg.signature && isUnknownOutcome(leg.error));
  if (!pending.length) {
    await sleep(2_000);
    return;
  }
  const deadline = Date.now() + 75_000;
  while (Date.now() < deadline) {
    const statuses = await connection
      .getSignatureStatuses(pending.map((leg) => leg!.signature!), { searchTransactionHistory: true })
      .catch(() => undefined);
    const settled = statuses?.value.every(
      (status) => status && (status.err || status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized"),
    );
    if (settled) break;
    await sleep(3_000);
  }
  await sleep(2_000);
}

async function tokenBalanceRaw(connection: Connection, owner: PublicKey, mint: string): Promise<string | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(mint) });
      return accounts.value
        .reduce((sum, account) => sum + BigInt(account.account.data.parsed.info.tokenAmount.amount), 0n)
        .toString();
    } catch {
      await sleep(1_500);
    }
  }
  return undefined;
}

async function solBalanceLamports(connection: Connection, owner: PublicKey): Promise<number | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await connection.getBalance(owner, "confirmed");
    } catch {
      await sleep(1_500);
    }
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function computeRoundTripShortfall(solAmount: number, finalSolRaw?: string): number | undefined {
  if (!finalSolRaw) return undefined;
  const inputLamports = Number(solToLamportsRaw(solAmount));
  const outputLamports = Number(finalSolRaw);
  if (!Number.isFinite(inputLamports) || !Number.isFinite(outputLamports) || inputLamports <= 0) {
    return undefined;
  }
  return ((inputLamports - outputLamports) / inputLamports) * 10_000;
}

async function waitForBuyQuote(args: {
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  slippageBps: number;
  graduatedAt?: string;
}): Promise<{ quote?: JupiterQuote; attempts: number; indexingLagMs?: number }> {
  const started = Date.now();
  let attempts = 0;
  let lastError: unknown;
  while (Date.now() - started <= config.jupiterIndexTimeoutMs) {
    attempts += 1;
    try {
      const quote = await quoteSwap(args.inputMint, args.outputMint, args.amountRaw, args.slippageBps);
      return {
        quote,
        attempts,
        indexingLagMs: args.graduatedAt ? Date.now() - Date.parse(args.graduatedAt) : undefined,
      };
    } catch (error) {
      lastError = error;
      await sleep(1_500);
    }
  }
  if (lastError) console.error("Jupiter route not available before timeout:", lastError);
  return { attempts, indexingLagMs: args.graduatedAt ? Date.now() - Date.parse(args.graduatedAt) : undefined };
}

function skippedBuyLeg(args: {
  tokenMint: string;
  amountRaw: string;
  startedAt: Date;
  error: string;
}): SwapLegLog {
  return {
    side: "buy",
    venue: "jupiter",
    inputMint: mints.sol,
    outputMint: args.tokenMint,
    inputAmountRaw: args.amountRaw,
    quotedOutputRaw: "0",
    status: "skipped",
    error: args.error,
    sentAt: args.startedAt.toISOString(),
  };
}

function ageAt(date: Date, graduatedAt?: string): number | undefined {
  if (!graduatedAt) return undefined;
  const start = Date.parse(graduatedAt);
  if (!Number.isFinite(start)) return undefined;
  return Math.max(0, Math.floor((date.getTime() - start) / 1000));
}

function sumBps(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return present.length ? present.reduce((sum, value) => sum + value, 0) : undefined;
}
