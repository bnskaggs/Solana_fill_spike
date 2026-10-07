// Copy of pump.fun's canonical PumpSwap SOL-denominated fee tiers as of 2026-10-06.
// These are market-cap tiers in SOL. The table can change; treat it as a logged assumption.
const SOL_TOKEN_SUPPLY_RAW = 1_000_000_000_000_000;

const tiers = [
  { minMarketCapSol: 0, totalFeeBps: 125 },
  { minMarketCapSol: 420, totalFeeBps: 120 },
  { minMarketCapSol: 1_470, totalFeeBps: 115 },
  { minMarketCapSol: 2_460, totalFeeBps: 110 },
  { minMarketCapSol: 3_440, totalFeeBps: 105 },
  { minMarketCapSol: 4_420, totalFeeBps: 100 },
  { minMarketCapSol: 9_820, totalFeeBps: 95 },
  { minMarketCapSol: 14_740, totalFeeBps: 90 },
  { minMarketCapSol: 24_560, totalFeeBps: 85 },
  { minMarketCapSol: 34_380, totalFeeBps: 80 },
  { minMarketCapSol: 44_200, totalFeeBps: 75 },
  { minMarketCapSol: 54_020, totalFeeBps: 70 },
  { minMarketCapSol: 63_840, totalFeeBps: 65 },
  { minMarketCapSol: 73_660, totalFeeBps: 60 },
  { minMarketCapSol: 83_480, totalFeeBps: 55 },
  { minMarketCapSol: 93_300, totalFeeBps: 50 },
  { minMarketCapSol: 98_240, totalFeeBps: 30 },
];

export function pumpFeeBpsForMarketCap(marketCapSol: number | undefined): number | undefined {
  if (marketCapSol === undefined || !Number.isFinite(marketCapSol) || marketCapSol < 0) return undefined;
  return [...tiers].reverse().find((tier) => marketCapSol >= tier.minMarketCapSol)?.totalFeeBps;
}

export function marketCapSolFromBuyQuote(inputLamports: string, quotedTokenOutRaw: string): number | undefined {
  const input = Number(inputLamports);
  const out = Number(quotedTokenOutRaw);
  if (!Number.isFinite(input) || !Number.isFinite(out) || out <= 0) return undefined;
  return (input * (SOL_TOKEN_SUPPLY_RAW / 1_000_000_000)) / out;
}

export function marketCapSolFromSellQuote(tokenInRaw: string, quotedSolOutLamports: string): number | undefined {
  const tokenIn = Number(tokenInRaw);
  const out = Number(quotedSolOutLamports);
  if (!Number.isFinite(tokenIn) || !Number.isFinite(out) || tokenIn <= 0) return undefined;
  return (out * (SOL_TOKEN_SUPPLY_RAW / 1_000_000_000)) / tokenIn;
}

