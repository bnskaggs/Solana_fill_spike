import {
  Connection,
  PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import { config, mints, programs } from "./config";
import { appendGraduationEvent, readGraduationEvents, readTradeLogs } from "./log";
import type { GraduationEvent } from "./types";

type ParsedTx = NonNullable<Awaited<ReturnType<Connection["getParsedTransaction"]>>>;

export interface EnrichedGraduation extends GraduationEvent {
  ageSec: number;
  traded: boolean;
  liquidityUsd?: number;
  volume24hUsd?: number;
  symbol?: string;
}

const dexCache = new Map<string, { at: number; data: Partial<EnrichedGraduation> }>();

export function rpcToWsEndpoint(rpcUrl: string): string {
  const url = new URL(rpcUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

export async function parseGraduationFromSignature(
  connection: Connection,
  signature: string,
): Promise<GraduationEvent | undefined> {
  const tx = await connection.getParsedTransaction(signature, {
    commitment: "confirmed",
    maxSupportedTransactionVersion: 1,
  });
  if (!tx?.meta || !isPumpMigration(tx)) return undefined;

  const ix = allInstructions(tx).find(
    (instruction): instruction is PartiallyDecodedInstruction =>
      "programId" in instruction &&
      instruction.programId.toBase58() === programs.pumpSwap &&
      "accounts" in instruction &&
      instruction.accounts.length >= 11,
  );
  if (!ix) return undefined;

  const accounts = ix.accounts.map((account) => account.toBase58());
  const [pool, , , baseMint, quoteMint, , , , , poolBaseTokenAccount, poolQuoteTokenAccount] = accounts;
  if (!pool || !baseMint || !quoteMint) return undefined;
  if (quoteMint !== mints.sol) return undefined;

  const baseAccountIndex = accountIndex(tx, poolBaseTokenAccount);
  const quoteAccountIndex = accountIndex(tx, poolQuoteTokenAccount);
  const baseReserveRaw = tokenBalance(tx, baseAccountIndex, baseMint);
  const quoteReserveLamports = tokenBalance(tx, quoteAccountIndex, quoteMint);
  const blockTimeMs = tx.blockTime ? tx.blockTime * 1000 : Date.now();

  return {
    schemaVersion: 1,
    signature,
    mint: baseMint,
    pool,
    slot: tx.slot,
    graduatedAt: new Date(blockTimeMs).toISOString(),
    quoteMint,
    quoteReserveLamports,
    baseReserveRaw,
  };
}

export function watchGraduations(onEvent: (event: GraduationEvent) => void): () => Promise<void> {
  if (!config.rpcUrl) throw new Error("RPC_URL is required to watch graduations");
  let subscriptionId: number | undefined;
  const connection = new Connection(config.rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: rpcToWsEndpoint(config.rpcUrl),
  });
  const seen = new Set(readGraduationEvents(config.runsDir).map((event) => event.signature));

  const start = async () => {
    subscriptionId = connection.onLogs(new PublicKey(programs.pumpSwap), async (logs) => {
      if (seen.has(logs.signature)) return;
      if (!logs.logs.some((line) => line.includes("Instruction: CreatePool"))) return;
      seen.add(logs.signature);
      try {
        const event = await parseGraduationFromSignature(connection, logs.signature);
        if (!event) return;
        appendGraduationEvent(config.runsDir, event);
        onEvent(event);
      } catch (error) {
        console.error(`graduation parse failed ${logs.signature}:`, error instanceof Error ? error.message : error);
      }
    });
  };

  void start();
  return async () => {
    if (subscriptionId !== undefined) await connection.removeOnLogsListener(subscriptionId);
  };
}

export async function enrichedGraduations(maxAgeSec = 900, runId = config.runId): Promise<EnrichedGraduation[]> {
  const now = Date.now();
  const trades = readTradeLogs(config.runsDir, runId);
  const tradedMints = new Set(trades.map((trade) => trade.tokenMint));
  const events = readGraduationEvents(config.runsDir)
    .map((event) => ({
      ...event,
      ageSec: Math.max(0, Math.floor((now - Date.parse(event.graduatedAt)) / 1000)),
      traded: tradedMints.has(event.mint),
    }))
    .filter((event) => event.ageSec <= maxAgeSec);

  return Promise.all(events.map(enrichWithDexscreener));
}

async function enrichWithDexscreener(event: EnrichedGraduation): Promise<EnrichedGraduation> {
  const cached = dexCache.get(event.mint);
  if (cached && Date.now() - cached.at < 10_000) return { ...event, ...cached.data };

  try {
    const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${event.mint}`);
    if (!response.ok) return event;
    const rows = (await response.json()) as Array<{
      baseToken?: { symbol?: string; address?: string };
      liquidity?: { usd?: number };
      volume?: { h24?: number };
    }>;
    const best = rows
      .filter((row) => row.baseToken?.address === event.mint)
      .sort((a, b) => Number(b.liquidity?.usd ?? 0) - Number(a.liquidity?.usd ?? 0))[0];
    const data = {
      symbol: best?.baseToken?.symbol,
      liquidityUsd: best?.liquidity?.usd,
      volume24hUsd: best?.volume?.h24,
    };
    dexCache.set(event.mint, { at: Date.now(), data });
    return { ...event, ...data };
  } catch {
    return event;
  }
}

function isPumpMigration(tx: ParsedTx): boolean {
  return allInstructions(tx).some((instruction) => {
    if (!("programId" in instruction)) return false;
    if (instruction.programId.toBase58() !== programs.pump) return false;
    if ("parsed" in instruction) return true;
    return true;
  });
}

function allInstructions(tx: ParsedTx): Array<ParsedTx["transaction"]["message"]["instructions"][number]> {
  const inner =
    tx.meta?.innerInstructions?.flatMap((group) => group.instructions) ??
    [];
  return [...tx.transaction.message.instructions, ...inner];
}

function accountIndex(tx: ParsedTx, pubkey: string): number | undefined {
  const index = tx.transaction.message.accountKeys.findIndex((account) => account.pubkey.toBase58() === pubkey);
  return index >= 0 ? index : undefined;
}

function tokenBalance(tx: ParsedTx, accountIndex: number | undefined, mint: string): string | undefined {
  if (accountIndex === undefined) return undefined;
  const balance = tx.meta?.postTokenBalances?.find((row) => row.accountIndex === accountIndex && row.mint === mint);
  return balance?.uiTokenAmount.amount;
}

