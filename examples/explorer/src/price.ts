// NIGHT market data from CoinGecko, cached in memory for 60 s.
// Failures are cached too (as null) so an offline machine never hammers
// the endpoint or breaks the page — testnet explorers survive without it.

// Determined via https://api.coingecko.com/api/v3/search?query=midnight :
// "midnight-3" is the Midnight Network NIGHT token (Cardano ecosystem,
// market-cap rank ~121); plain "midnight" is an unrelated micro-cap.
const COINGECKO_ID = 'midnight-3';

const PRICE_URL =
  `https://api.coingecko.com/api/v3/simple/price?ids=${COINGECKO_ID}` +
  `&vs_currencies=usd&include_market_cap=true&include_24hr_change=true`;

const CACHE_MS = 60_000;

export interface NightPrice {
  usd: number;
  marketCapUsd: number;
  change24h: number;
}

let cachedAt = 0;
let cached: NightPrice | null = null;
let inflight: Promise<NightPrice | null> | null = null;

export function nightPrice(): Promise<NightPrice | null> {
  if (Date.now() - cachedAt < CACHE_MS) return Promise.resolve(cached);
  inflight ??= (async () => {
    try {
      const res = await fetch(PRICE_URL);
      if (!res.ok) throw new Error(`coingecko ${res.status}`);
      const body = (await res.json()) as Record<
        string,
        { usd?: number; usd_market_cap?: number; usd_24h_change?: number }
      >;
      const row = body[COINGECKO_ID];
      cached =
        row && typeof row.usd === 'number'
          ? { usd: row.usd, marketCapUsd: row.usd_market_cap ?? 0, change24h: row.usd_24h_change ?? 0 }
          : null;
    } catch {
      cached = null;
    }
    cachedAt = Date.now();
    inflight = null;
    return cached;
  })();
  return inflight;
}

export function formatUsd(v: number): string {
  if (v >= 1) return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${v.toFixed(5)}`;
}

export function formatUsdCompact(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
}
