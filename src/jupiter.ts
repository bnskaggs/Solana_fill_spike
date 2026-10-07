import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  VersionedTransaction,
} from "@solana/web3.js";
import { config, mints } from "./config";
import { shortfallBps } from "./stats";
import type { SwapLegLog, Venue } from "./types";

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  otherAmountThreshold: string;
  swapMode: "ExactIn" | "ExactOut";
  slippageBps: number;
  priceImpactPct: string;
  routePlan: unknown[];
}

interface JupiterSwapResponse {
  swapTransaction: string;
  lastValidBlockHeight?: number;
  prioritizationFeeLamports?: number;
}

type ParsedTransaction = NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>;
type ParsedTransactionMeta = NonNullable<ParsedTransaction["meta"]>;

export interface SwapRequest {
  connection: Connection;
  wallet: Keypair;
  inputMint: string;
  outputMint: string;
  amountRaw: string;
  side: "buy" | "sell";
  venue?: Venue;
  slippageBps?: number;
  priorityFeeMicroLamports?: number;
  prefetchedQuote?: JupiterQuote;
}

export async function quoteSwap(
  inputMint: string,
  outputMint: string,
  amountRaw: string,
  slippageBps = config.slippageBps,
): Promise<JupiterQuote> {
  const url = new URL(config.jupiterQuoteUrl);
  url.searchParams.set("inputMint", inputMint);
  url.searchParams.set("outputMint", outputMint);
  url.searchParams.set("amount", amountRaw);
  url.searchParams.set("slippageBps", String(slippageBps));
  url.searchParams.set("onlyDirectRoutes", "false");

  const response = await fetchWithBackoff(url);
  if (!response.ok) throw new Error(`Jupiter quote failed ${response.status}: ${await response.text()}`);
  return (await response.json()) as JupiterQuote;
}

/** lite-api rate-limits hard (429). Back off instead of failing the trade. */
async function fetchWithBackoff(input: URL | string, init?: RequestInit): Promise<Response> {
  let response = await fetch(input, init);
  for (const waitMs of [1_000, 2_000, 4_000]) {
    if (response.status !== 429 && response.status < 500) return response;
    await sleep(waitMs);
    response = await fetch(input, init);
  }
  return response;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send once, then keep re-sending the same signed bytes every ~2 s until the tx shows
 * up or its blockhash expires. Sent-once-and-forgotten txs were being dropped on busy
 * pools. Polls signature status instead of using websocket confirmations.
 */
async function sendUntilLanded(
  connection: Connection,
  raw: Buffer,
  lastValidBlockHeight: number,
): Promise<{ signature: string; processedAt?: Date; confirmedAt?: Date; broadcasts: number; err?: unknown }> {
  const signature = await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 });
  let broadcasts = 1;
  let processedAt: Date | undefined;
  let lastBroadcast = Date.now();
  let lastHeightCheck = 0;
  let expired = false;
  while (true) {
    await sleep(600);
    const status = (await connection.getSignatureStatuses([signature]).catch(() => undefined))?.value[0];
    if (status) {
      if (status.err) return { signature, processedAt: processedAt ?? new Date(), broadcasts, err: status.err };
      processedAt ??= new Date();
      if (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized") {
        return { signature, processedAt, confirmedAt: new Date(), broadcasts };
      }
      continue;
    }
    if (expired) return { signature, broadcasts };
    if (Date.now() - lastHeightCheck > 2_000) {
      lastHeightCheck = Date.now();
      const height = await connection.getBlockHeight("confirmed").catch(() => undefined);
      // One more status poll after expiry before declaring it dead.
      if (height !== undefined && height > lastValidBlockHeight) expired = true;
    }
    if (!expired && Date.now() - lastBroadcast > 2_000) {
      lastBroadcast = Date.now();
      broadcasts += 1;
      await connection.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 0 }).catch(() => undefined);
    }
  }
}

export async function executeJupiterSwap(request: SwapRequest): Promise<SwapLegLog> {
  const sentAt = new Date();
  const slippageBps = request.slippageBps ?? config.slippageBps;
  const priorityFeeMicroLamports =
    request.priorityFeeMicroLamports ?? config.priorityFeeMicroLamports;
  let signature: string | undefined;
  let broadcasts: number | undefined;
  let priorityFeeLamports: number | undefined;

  try {
    const quote =
      request.prefetchedQuote ??
      (await quoteSwap(request.inputMint, request.outputMint, request.amountRaw, slippageBps));
    const swapResponse = await buildSwapTransaction(quote, request.wallet.publicKey, slippageBps, priorityFeeMicroLamports);
    priorityFeeLamports = swapResponse.prioritizationFeeLamports;
    const transaction = VersionedTransaction.deserialize(
      Buffer.from(swapResponse.swapTransaction, "base64"),
    );
    transaction.sign([request.wallet]);

    const simulation = await request.connection.simulateTransaction(transaction, {
      replaceRecentBlockhash: true,
      sigVerify: false,
    });
    if (simulation.value.err) {
      throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
    }

    const lastValidBlockHeight =
      swapResponse.lastValidBlockHeight ?? (await request.connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
    const sent = await sendUntilLanded(request.connection, Buffer.from(transaction.serialize()), lastValidBlockHeight);
    signature = sent.signature;
    broadcasts = sent.broadcasts;
    if (sent.err) throw new Error(`Processed with error: ${JSON.stringify(sent.err)}`);
    if (!sent.confirmedAt || !sent.processedAt) {
      throw new Error(`Blockhash expired before landing (${sent.broadcasts} broadcasts); did not land`);
    }
    const processedAt = sent.processedAt;
    const confirmedAt = sent.confirmedAt;
    const tx = await request.connection.getParsedTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const actualOutputRaw = tx?.meta
      ? amountDeltaForOwner(tx.meta, request.wallet.publicKey, request.outputMint, "out")
      : undefined;
    const feeLamports = tx?.meta?.fee;
    const walletSolDeltaLamports = tx?.meta
      ? (tx.meta.postBalances[0] ?? 0) - (tx.meta.preBalances[0] ?? 0)
      : undefined;
    const rentLamports = rentFromDelta({
      walletSolDeltaLamports,
      feeLamports,
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmountRaw: request.amountRaw,
      actualOutputRaw,
    });

    return {
      side: request.side,
      venue: request.venue ?? "jupiter",
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmountRaw: request.amountRaw,
      quotedOutputRaw: quote.outAmount,
      actualOutputRaw,
      signature,
      status: "landed",
      sentAt: sentAt.toISOString(),
      processedAt: processedAt.toISOString(),
      confirmedAt: confirmedAt.toISOString(),
      timeToProcessedMs: processedAt.getTime() - sentAt.getTime(),
      timeToLandMs: confirmedAt.getTime() - sentAt.getTime(),
      slot: tx?.slot,
      feeLamports,
      walletSolDeltaLamports,
      rentLamports,
      priorityFeeMicroLamports,
      priorityFeeLamports,
      broadcasts,
      quoteShortfallBps: shortfallBps(quote.outAmount, actualOutputRaw),
    };
  } catch (error) {
    return {
      side: request.side,
      venue: request.venue ?? "jupiter",
      inputMint: request.inputMint,
      outputMint: request.outputMint,
      inputAmountRaw: request.amountRaw,
      quotedOutputRaw: "0",
      signature,
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
      sentAt: sentAt.toISOString(),
      priorityFeeMicroLamports,
      priorityFeeLamports,
      broadcasts,
    };
  }
}

export function solToLamportsRaw(solAmount: number): string {
  return Math.round(solAmount * LAMPORTS_PER_SOL).toString();
}

async function buildSwapTransaction(
  quoteResponse: JupiterQuote,
  wallet: PublicKey,
  slippageBps: number,
  priorityFeeMicroLamports: number,
): Promise<JupiterSwapResponse> {
  const priority =
    config.priorityLevel === "fixed"
      ? { computeUnitPriceMicroLamports: priorityFeeMicroLamports }
      : {
          prioritizationFeeLamports: {
            priorityLevelWithMaxLamports: { maxLamports: config.priorityMaxLamports, priorityLevel: config.priorityLevel },
          },
        };
  const response = await fetchWithBackoff(config.jupiterSwapUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      quoteResponse: { ...quoteResponse, slippageBps },
      userPublicKey: wallet.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      ...priority,
    }),
  });
  if (!response.ok) throw new Error(`Jupiter swap failed ${response.status}: ${await response.text()}`);
  return (await response.json()) as JupiterSwapResponse;
}

/**
 * Whatever part of the wallet's SOL change isn't explained by the swap amount and the
 * tx fee is token-account rent: a deposit when an account is created for a new token,
 * a refund when one is closed. Positive = paid out, negative = refunded.
 */
function rentFromDelta(args: {
  walletSolDeltaLamports?: number;
  feeLamports?: number;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  actualOutputRaw?: string;
}): number | undefined {
  const { walletSolDeltaLamports: delta, feeLamports: fee } = args;
  if (delta === undefined || fee === undefined) return undefined;
  if (args.inputMint === mints.sol) {
    return -delta - Number(args.inputAmountRaw) - fee;
  }
  if (args.outputMint === mints.sol && args.actualOutputRaw !== undefined) {
    // actualOutputRaw for SOL is itself derived from the wallet delta, so this is 0 by
    // construction. A refund (closeAccount) on a sell leg would land in actualOutputRaw
    // instead. Jupiter leaves the token account open by default, so it hasn't happened
    // in practice; if we ever add closeAccount on sells, derive SOL output from the
    // wSOL unwrap instead.
    return Number(args.actualOutputRaw) - fee - delta;
  }
  return -delta - fee;
}

function amountDeltaForOwner(
  meta: ParsedTransactionMeta,
  owner: PublicKey,
  mint: string,
  direction: "out",
): string | undefined {
  if (mint === mints.sol) {
    const accountIndex = 0;
    const pre = meta.preBalances[accountIndex] ?? 0;
    const post = meta.postBalances[accountIndex] ?? 0;
    const fee = meta.fee ?? 0;
    const delta = direction === "out" ? post - pre + fee : pre - post - fee;
    return delta > 0 ? String(delta) : undefined;
  }

  const ownerText = owner.toBase58();
  const pre = tokenAmount(meta.preTokenBalances ?? [], ownerText, mint);
  const post = tokenAmount(meta.postTokenBalances ?? [], ownerText, mint);
  const delta = post - pre;
  return delta > 0n ? delta.toString() : undefined;
}

function tokenAmount(
  balances: ParsedTransactionMeta["preTokenBalances"],
  owner: string,
  mint: string,
): bigint {
  let total = 0n;
  for (const balance of balances ?? []) {
    if (balance.owner === owner && balance.mint === mint) {
      total += BigInt(balance.uiTokenAmount.amount);
    }
  }
  return total;
}
