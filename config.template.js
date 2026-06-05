// config.template.js — SOURCE OF TRUTH for config after the GitHub Actions cutover.
// The deploy workflow substitutes the __PLACEHOLDER__ values from GitHub Actions
// Secrets and writes config.js at publish time, so the real keys never live in the
// repo. Edit THIS file (not config.js) for any config change once the cutover is done.
// The two market keys are publishable client-side keys (security.md §1); they are
// kept out of the repo for clean git history + 'rotate without a public commit'.
export const DEFAULT_KEYS = {
  finnhub: '__FINNHUB_KEY__',
  twelvedata: '__TWELVEDATA_KEY__',
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

// Analyst agent. In PROXY mode the Anthropic key lives server-side in a Cloudflare
// Worker; the Settings field is a passphrase. In BYOK mode (proxy URL empty) the
// field is a real sk-ant- key sent direct to api.anthropic.com.
export const ANALYST_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8 (most capable)' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 (balanced)' },
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
];
export const ANALYST_DEFAULT_MODEL = 'claude-opus-4-8';
export const ANALYST_MAX_TOKENS = 16000;
export const ANALYST_MAX_TURNS = 8;          // tool-loop safety cap

// The Worker URL is NOT secret (the passphrase is what gates it), so it lives here
// as a literal. Set it to your deployed worker URL to switch the analyst to proxy mode.
export const ANALYST_PROXY_URL = '';

// $ per 1M tokens {input, output} — for the per-run cost estimate in the UI.
export const MODEL_PRICES = {
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
};
