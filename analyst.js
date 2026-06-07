// analyst.js — the resident Claude analyst: a browser-side agent loop over the
// Anthropic Messages API (BYOK: the key lives in localStorage only, entered via
// Settings — never baked into the bundle). Raw fetch by design: this project is
// hand-coded with no build step, so the npm SDK is not an option.
//
// The analysis method is WJ-relational (Anthony's design language): the signal
// lives in the relationships BETWEEN data sources — price history x news flow x
// cross-asset correlation architecture x portfolio context — not in any single
// number. The get_relations tool exposes the watchlist's correlation
// architecture and its reorganization (weighted Jaccard vs the prior window).

import { ANALYST_MAX_TOKENS, ANALYST_MAX_TURNS, ANALYST_PROXY_URL } from './config.js';
import { parseVerdict } from './lib.js';

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const usingProxy = Boolean(ANALYST_PROXY_URL);

const SYSTEM = `You are the resident analyst inside Stock Tracker, a personal investing dashboard. You produce a clear, evidence-grounded opinion on a stock, coin, or portfolio.

METHOD — relational first:
- The signal lives in the RELATIONSHIPS between data sources, not in any single number. Connect price history, news flow, cross-asset correlation structure, and (when relevant) portfolio context before forming a view.
- Use get_relations to read the watchlist's correlation architecture: "wj" is a weighted-Jaccard similarity between the recent and prior correlation windows (1.0 = stable architecture, lower = the relationship structure is reorganizing — regime information). "shifts" are the pairs whose relationship changed most.
- Use get_regimes for portfolio reviews: "hero.reorg" is how much the holdings' correlation architecture reorganized recently (0 = stable diversification, toward 1 = positions converging onto one factor — rising portfolio risk). "perSymbol[x].decoupling_from" names which holdings broke from the pack. Reason from the regime, not any single price.
- Fundamental units are individual stocks and coins. Sector/index labels are context, never inputs to your reasoning.
- A relationship that contradicts the headline story is worth more than one that confirms it. Say so when you see it.

PROCESS: Call tools to gather evidence first (typically 3-6 calls), then deliver the verdict. Do not ask the user questions; work with what the tools return. If a tool returns an error or empty data, note the gap and reason with what you have.

FINAL ANSWER — exactly one fenced JSON block, then nothing else:
\`\`\`json
{"rating": "BUY" | "HOLD" | "SELL", "confidence": 0-100, "summary": "one paragraph, plain language, the relational story", "reasons": ["3-5 evidence-backed reasons, each naming the data it rests on"], "risks": ["2-4 concrete risks that would change the call"]}
\`\`\`
For a PORTFOLIO review, rating means overall posture: BUY = add exposure, HOLD = stay the course, SELL = de-risk.
This is educational analysis, not financial advice — keep claims calibrated; never imply certainty.`;

const TOOLS = [
  {
    name: 'get_quote',
    description: 'Current quote for a stock or crypto symbol: price, day change, day range, previous close. Call this for the symbol under analysis and for any comparison symbol.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string', description: 'Ticker, e.g. AAPL or BTC' } }, required: ['symbol'] },
  },
  {
    name: 'get_history',
    description: 'Condensed 1-year daily price history for a symbol: ~60 evenly spaced closes plus stats (52-week high/low, total change %). Call this before judging trend or valuation context.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_news',
    description: 'Recent company news headlines (last 14 days) for a stock symbol. Returns [] for crypto symbols. Use it to connect price moves to the news flow.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_profile',
    description: 'Company profile for a stock: name, exchange, industry, market cap. Returns null for crypto.',
    input_schema: { type: 'object', properties: { symbol: { type: 'string' } }, required: ['symbol'] },
  },
  {
    name: 'get_watchlist',
    description: 'The user watchlist with current quotes — the comparison universe for relational context.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_portfolio',
    description: "The user's positions with live value, cost, P/L and totals. Required for portfolio reviews; useful context for single-symbol calls when the user already holds it.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_relations',
    description: "The relational read on the watchlist: pairwise Spearman correlations of daily returns (recent ~1-month window), the prior window, weighted-Jaccard similarity between the two correlation architectures (wj: 1 = stable, lower = reorganizing), strongest current pairs, and the pairs whose relationship shifted most. This is the regime signal — call it on every analysis.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_regimes',
    description: "The portfolio-regime read over the user's HOLDINGS only: hero = how much the holdings' correlation architecture reorganized between the last two rolling daily-return windows (reorg 0 = stable, 1 = fully reorganized; 1 − signed weighted-Jaccard), a per-holding regime (stable/elevated/reorganizing) with what each is decoupling from, a dollar-weighted stress number, and the recent reorg trajectory. Call this for any portfolio review to judge whether diversification is holding or breaking down. Distinct from get_relations, which covers the whole watchlist.",
    input_schema: { type: 'object', properties: {} },
  },
];

// Execute one tool call against the app-provided context.
async function execTool(ctx, name, input) {
  try {
    switch (name) {
      case 'get_quote': return await ctx.toolQuote(String(input.symbol ?? ''));
      case 'get_history': return await ctx.toolHistory(String(input.symbol ?? ''));
      case 'get_news': return await ctx.toolNews(String(input.symbol ?? ''));
      case 'get_profile': return await ctx.toolProfile(String(input.symbol ?? ''));
      case 'get_watchlist': return await ctx.toolWatchlist();
      case 'get_portfolio': return ctx.toolPortfolio();
      case 'get_relations': return await ctx.toolRelations();
      case 'get_regimes': return await ctx.toolRegimes();
      default: return { error: `unknown tool ${name}` };
    }
  } catch (err) {
    return { error: String(err?.message ?? err) };
  }
}

// Adaptive thinking is documented for the Opus/Sonnet tiers; Haiku runs without it.
const supportsAdaptiveThinking = (model) =>
  model.startsWith('claude-opus') || model.startsWith('claude-sonnet');

// `secret` is the user-entered value: a Worker passphrase in proxy mode, or a
// raw sk-ant- key in BYOK mode. In proxy mode the worker holds the real key, so
// we send only the passphrase; in BYOK mode we send the key direct to Anthropic.
async function callAPI(secret, model, messages) {
  const payload = JSON.stringify({
    model,
    max_tokens: ANALYST_MAX_TOKENS,
    ...(supportsAdaptiveThinking(model) ? { thinking: { type: 'adaptive' } } : {}),
    system: SYSTEM,
    tools: TOOLS,
    messages,
  });
  const res = await fetch(usingProxy ? ANALYST_PROXY_URL : API_URL, {
    method: 'POST',
    headers: usingProxy
      ? { 'content-type': 'application/json', 'x-analyst-auth': secret }
      : {
          'content-type': 'application/json',
          'x-api-key': secret,
          'anthropic-version': API_VERSION,
          'anthropic-dangerous-direct-browser-access': 'true',
        },
    body: payload,
  });
  if (!res.ok) {
    let detail = '';
    try { detail = String((await res.json())?.error?.message ?? '').slice(0, 200); } catch { /* opaque */ }
    const friendly = {
      401: usingProxy ? 'Analyst passphrase rejected — check it in Settings.' : 'Anthropic API key rejected — check it in Settings.',
      403: 'The key lacks permission for the selected model.',
      404: 'Model not found — pick another model in Settings.',
      413: 'Request too large — try a single symbol instead of the full portfolio.',
      429: 'Rate limit hit — wait a minute and retry.',
      529: 'Anthropic API is overloaded — retry shortly.',
    }[res.status];
    throw new Error(friendly ?? `Analyst error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

// Run the agent. mode: 'symbol' (needs symbol) or 'portfolio'.
// onProgress(label) is called as the loop advances (for the trace UI).
export async function runAnalyst({ apiKey, model, mode, symbol, ctx, onProgress = () => {} }) {
  const task = mode === 'portfolio'
    ? 'Review my portfolio. Gather the portfolio, the watchlist context, and the relational read; pull history or news where a position warrants it. Then give the posture verdict.'
    : `Analyze ${symbol} and give me your verdict. Gather its quote, history, news (if a stock), the relational read, and any comparison context you need.`;

  const messages = [{ role: 'user', content: task }];
  const trace = [];
  const usage = { input_tokens: 0, output_tokens: 0 };

  for (let turn = 0; turn < ANALYST_MAX_TURNS; turn++) {
    onProgress(turn === 0 ? 'thinking…' : `thinking… (turn ${turn + 1})`);
    const response = await callAPI(apiKey, model, messages);
    usage.input_tokens += response.usage?.input_tokens ?? 0;
    usage.output_tokens += response.usage?.output_tokens ?? 0;

    const toolUses = response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) {
      const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      return { verdict: parseVerdict(text), text, trace, usage, stopReason: response.stop_reason };
    }

    // Append the assistant turn in full (thinking blocks must be preserved).
    messages.push({ role: 'assistant', content: response.content });

    const results = [];
    for (const tu of toolUses) {
      const label = tu.input?.symbol ? `${tu.name}(${tu.input.symbol})` : tu.name;
      onProgress(label);
      trace.push(label);
      const result = await execTool(ctx, tu.name, tu.input ?? {});
      results.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result ?? null),
        ...(result && result.error ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  return {
    verdict: null,
    text: 'The analyst hit its tool-call budget without reaching a verdict. Try again (or a more capable model).',
    trace, usage, stopReason: 'max_turns',
  };
}
