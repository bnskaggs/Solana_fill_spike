export type Venue =
  | "jupiter"
  | "pumpfun-via-jupiter"
  | "jito"
  | "external";

/** Which executor produced the trade. "spike" = this repo's TS executor; "external" = imported records from another executor. */
export type Engine = "spike" | "external";

export type TradeStatus = "landed" | "failed" | "skipped";
export type TradeMode = "calm" | "hot";

export interface SwapLegLog {
  side: "buy" | "sell";
  venue: Venue;
  inputMint: string;
  outputMint: string;
  inputAmountRaw: string;
  quotedOutputRaw: string;
  actualOutputRaw?: string;
  signature?: string;
  status: TradeStatus;
  error?: string;
  sentAt: string;
  /** First seen at `processed` commitment. */
  processedAt?: string;
  confirmedAt?: string;
  timeToProcessedMs?: number;
  timeToLandMs?: number;
  slot?: number;
  feeLamports?: number;
  /** Wallet SOL change for this tx, raw lamports, negative = spent. From pre/postBalances. */
  walletSolDeltaLamports?: number;
  /** Token-account deposits paid (+) or refunded (−) in this tx. Recoverable, but it leaves the wallet. */
  rentLamports?: number;
  priorityFeeMicroLamports?: number;
  /** Priority fee Jupiter actually set when PRIORITY_LEVEL is not "fixed". */
  priorityFeeLamports?: number;
  /** Times the same signed tx was sent. 1 = landed (or died) on the first send. */
  broadcasts?: number;
  /** Sell legs only: attempts with a fresh quote, and the errors of the ones that failed. */
  attempts?: number;
  priorErrors?: string[];
  jitoTipLamports?: number;
  quoteShortfallBps?: number;
}

export interface TradeLog {
  schemaVersion: 1;
  id: string;
  runId: string;
  /** Absent on older logs; treat as "spike". */
  engine?: Engine;
  /** Absent = v1 (send once, websocket confirm, 30 s timeout). */
  executorVersion?: string;
  mode?: TradeMode;
  createdAt: string;
  tokenMint: string;
  solAmount: number;
  route: "jupiter-round-trip" | "pumpfun-round-trip" | "external-leg";
  notes?: string;
  graduatedAt?: string;
  ageAtTradeSec?: number;
  quoteAttempts?: number;
  indexingLagMs?: number;
  buy: SwapLegLog;
  sell?: SwapLegLog;
  /** Tokens found in the wallet after a failed round trip (checked once the outcome settles). */
  strandedTokenRaw?: string;
  /** Sell of strandedTokenRaw, so a failed leg doesn't leave a position open. */
  cleanup?: SwapLegLog;
  /** Wallet SOL just before the buy and (on failed trades) after settle + cleanup. Trades are serialized, so the gap is this trade's cost. */
  walletLamportsBefore?: number;
  walletLamportsAfter?: number;
  status: TradeStatus;
  totalFeeLamports?: number;
  totalRentLamports?: number;
  totalTimeToLandMs?: number;
  roundTripShortfallBps?: number;
  /** roundTripShortfallBps + tx fees as bps of SOL in. The number to compare with GMGN 333 / Axiom 405. */
  allInCostBps?: number;
  /** Sum of buy/sell quote shortfalls. This is the part execution quality can actually improve. */
  landingCostBps?: number;
  /** Estimated PumpSwap canonical-pool fee paid across both legs, from pump.fun's public fee table. */
  poolFeeBps?: number;
  /** Market movement between the buy fill and sell quote after backing out estimated pool fees. */
  driftBps?: number;
}

export interface Summary {
  runId: string;
  engine: Engine | "all";
  mode: TradeMode | "all";
  trades: number;
  landed: number;
  failed: number;
  failRatePct: number;
  medianQuoteShortfallBps: number | null;
  p75QuoteShortfallBps: number | null;
  medianAllInCostBps: number | null;
  medianLandingCostBps: number | null;
  medianPoolFeeBps: number | null;
  medianDriftBps: number | null;
  medianIndexingLagMs: number | null;
  medianTimeToProcessedMs: number | null;
  medianTimeToLandMs: number | null;
}

export interface GraduationEvent {
  schemaVersion: 1;
  signature: string;
  mint: string;
  pool: string;
  slot: number;
  graduatedAt: string;
  quoteMint?: string;
  quoteReserveLamports?: string;
  baseReserveRaw?: string;
}
