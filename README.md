# Stock Tracker

A static, hand-coded investing dashboard: live watchlist quotes (stocks + crypto), daily
candle charts, a private in-browser portfolio, a **relational map** of the watchlist's
correlation architecture, and a **Claude-powered analyst** that forms evidence-grounded
opinions. No framework, no build step, no backend — all user state lives in
`localStorage` and never leaves the browser.

**Live:** https://k84hero.github.io/stock-tracker/

## Data sources (free tiers)
- [Finnhub](https://finnhub.io) — stock quotes, symbol search, profiles, news (60 req/min)
- [Twelve Data](https://twelvedata.com) — stock daily series for charts (800 credits/day)
- [CoinGecko](https://www.coingecko.com) — crypto quotes + history (keyless)
- [Anthropic](https://platform.claude.com) — the analyst agent (BYOK: your key, entered in
  Settings, stored only in `localStorage`, sent only to `api.anthropic.com`)

Market-data keys are publishable client-side keys; enter them in Settings or bake
defaults into `config.js`. The Anthropic key is a real secret — it is **never** baked in.
With no keys the app runs in demo mode (synthetic stock data; crypto stays live).

## The relational layer
The watchlist is treated as a graph: pairwise Spearman correlations of daily returns are
the edges. The panel compares this month's correlation architecture against last month's
with a weighted-Jaccard similarity — 1.0 means the relationship structure is unchanged;
lower means the architecture itself is reorganizing (regime information). The analyst
agent reads the same structure through its `get_relations` tool and is prompted to reason
relationally: price history × news flow × cross-asset correlations, not any number alone.

## Files
- `index.html` / `styles.css` / `app.js` — the app (CSP via meta tag; Pages can't serve headers)
- `analyst.js` — the browser-side Claude agent loop (manual tool-use loop, adaptive thinking)
- `lib.js` — pure logic (formatters, portfolio math, series transforms, demo generator,
  rate-limit scheduler, correlation matrix + weighted Jaccard, verdict parsing)
- `lib.test.js` — unit tests · `config.js` — defaults and tuning · `tools/make-assets.py` — icon/OG generation

## Develop
- `npm test` — run the unit tests (node:test, zero install)
- Serve the repo root with any static server (`python -m http.server 8000 --bind 127.0.0.1`)

Educational only. Not investment advice. Free-tier data can be delayed.
