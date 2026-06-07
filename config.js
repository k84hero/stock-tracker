// config.js — baked default API keys (publishable client-side keys; the control
// is the per-key rate limit, per security.md §1). Settings-panel keys in
// localStorage override these. Empty string = no default → demo mode.
export const DEFAULT_KEYS = {
  finnhub: 'd8hf209r01qgcfbpfjkgd8hf209r01qgcfbpfjl0',
  twelvedata: '611bda3de7cf48f6883f33679d8327d3',
};

export const DEFAULT_WATCHLIST = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'BTC'];
export const MARKET_STRIP = [
  { symbol: 'SPY', label: 'S&P 500' },
  { symbol: 'QQQ', label: 'Nasdaq 100' },
  { symbol: 'DIA', label: 'Dow 30' },
  { symbol: 'IWM', label: 'Russell 2k' },
];

export const QUOTE_REFRESH_MS = 60_000;      // watchlist + strip refresh cycle
export const NEWS_TTL_MS = 10 * 60_000;      // general news cache
export const FINNHUB_PER_MIN = 50;           // free tier is 60/min — keep headroom
export const TWELVEDATA_PER_MIN = 7;         // free tier is 8/min — keep headroom
export const COINGECKO_PER_MIN = 20;         // keyless public tier ~30/min — keep headroom

// Crypto symbols served by CoinGecko (keyless) instead of the stock providers.
export const CRYPTO_IDS = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  DOGE: 'dogecoin',
};

// Analyst agent (BYOK — the Anthropic key lives ONLY in localStorage via the
// Settings panel; it is a real secret and must never be baked in here).
export const ANALYST_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
];
export const ANALYST_DEFAULT_MODEL = 'claude-opus-4-8';
export const ANALYST_MAX_TOKENS = 16000;
export const ANALYST_MAX_TURNS = 8;          // tool-loop safety cap

// When set to a Cloudflare Worker URL, the analyst runs in PROXY mode: the
// Anthropic key lives server-side in the worker and the Settings field becomes a
// PASSPHRASE (the worker's gate). Empty string = BYOK mode (the field is a real
// sk-ant- key, sent direct to api.anthropic.com from the browser).
export const ANALYST_PROXY_URL = 'https://stocktraderhero.anthonyharbertjr.workers.dev';

// $ per 1M tokens {input, output} — for the per-run cost estimate in the UI.
export const MODEL_PRICES = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};

// ---------- portfolio regime monitor ----------
// Rolling daily-return correlation windows over the HOLDINGS-only universe.
export const REGIME_WINDOW = 21;        // trading days per correlation window (~1 month)
export const REGIME_STEP = 5;           // stride between rolling windows (~1 week)
export const REGIME_MIN_OVERLAP = 15;   // a window shorter than this is not trusted (~70% of window)
export const REGIME_MIN_HOLDINGS = 3;   // fewer held symbols → no aggregate gauge
