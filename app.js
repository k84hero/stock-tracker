// app.js — Stock Tracker orchestration: storage, rate-limited fetch layer
// (Finnhub + Twelve Data + keyless CoinGecko for crypto), rendering, canvas
// chart, dialogs, the WJ relational panel, and the Claude analyst wiring.
// Pure logic lives in lib.js; the agent loop lives in analyst.js.

import {
  fmtMoney, fmtPct, fmtCompact,
  positionMetrics, portfolioTotals,
  parseTimeSeries, sliceRange, seriesExtent, scaleY, buildSparkPoints,
  genDemoSeries, demoQuote,
  nextDelay, seriesCacheFresh,
  condenseSeries, relationalSnapshot,
} from './lib.js';
import {
  DEFAULT_KEYS, DEFAULT_WATCHLIST, MARKET_STRIP,
  QUOTE_REFRESH_MS, NEWS_TTL_MS, FINNHUB_PER_MIN, TWELVEDATA_PER_MIN,
  COINGECKO_PER_MIN, CRYPTO_IDS, ANALYST_MODELS, ANALYST_DEFAULT_MODEL, MODEL_PRICES,
} from './config.js';
import { runAnalyst } from './analyst.js';

// ---------- tiny DOM helpers ----------

const $ = (sel) => document.querySelector(sel);

// Only http(s) URLs may become hrefs — API data is untrusted.
const safeUrl = (u) => (/^https?:\/\//i.test(u ?? '') ? u : '#');

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child);
  }
  return node;
}

const svgNS = 'http://www.w3.org/2000/svg';

// Unix-seconds → locale string; '' when the field is junk.
function newsDate(dt, dateOnly = false) {
  const ms = typeof dt === 'number' && dt > 1e9 ? dt * 1000 : null;
  if (!ms) return '';
  const d = new Date(ms);
  return dateOnly ? d.toLocaleDateString() : d.toLocaleString();
}

// ---------- storage ----------

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(`st.${key}`);
      return raw == null ? fallback : JSON.parse(raw);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`st.${key}`, JSON.stringify(value)); } catch { /* quota/private mode */ }
  },
  clearAll() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith('st.'))
        .forEach((k) => localStorage.removeItem(k));
    } catch { /* ignore */ }
  },
};

// ---------- state ----------

let posSeq = Date.now();
const withIds = (positions) => positions.map((p) => (p.id ? p : { ...p, id: `p${posSeq++}` }));

const state = {
  keys: { ...DEFAULT_KEYS, anthropic: '', ...store.get('keys', {}) },
  model: store.get('model', ANALYST_DEFAULT_MODEL),
  watchlist: store.get('watchlist', DEFAULT_WATCHLIST.slice()),
  positions: withIds(store.get('positions', [])),
  quotes: new Map(),    // symbol → {c,d,dp,h,l,o,pc,t}
  series: new Map(),    // symbol → [{t,o,h,l,c,v}]
  profiles: new Map(),  // symbol → profile2-shaped object
  stale: new Set(),     // symbols whose last quote fetch failed
  detailSymbol: null,
  detailRange: '3M',
  lastDetailSeries: null,
  refreshTimer: null,
  bootGen: 0,           // increments per boot(); stale sweeps check it before rendering
  analystBusy: false,
};

const quotesLive = () => Boolean(state.keys.finnhub);
const chartsLive = () => Boolean(state.keys.twelvedata);
const analystReady = () => Boolean(state.keys.anthropic);
const isCrypto = (symbol) => Object.hasOwn(CRYPTO_IDS, symbol);

const SYMBOL_RE = /^[A-Za-z0-9.\-:]{1,12}$/;
const cleanSymbol = (s) => (SYMBOL_RE.test(s.trim()) ? s.trim().toUpperCase() : null);

// ---------- rate-limited fetch queues ----------

class RateQueue {
  constructor(limitPerMin) {
    this.limit = limitPerMin;
    this.stamps = [];
    this.chain = Promise.resolve();
  }
  run(thunk) {
    const job = this.chain.then(async () => {
      const wait = nextDelay(this.stamps, this.limit, Date.now());
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.stamps.push(Date.now());
      // evict just past the 60s rate window so the array stays bounded at ~limit
      this.stamps = this.stamps.filter((t) => Date.now() - t < 60_500);
      return thunk();
    });
    this.chain = job.catch(() => {});
    return job;
  }
}

const fhQueue = new RateQueue(FINNHUB_PER_MIN);
const tdQueue = new RateQueue(TWELVEDATA_PER_MIN);
const cgQueue = new RateQueue(COINGECKO_PER_MIN);

async function getJSON(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---------- API layer (Finnhub + Twelve Data + CoinGecko, with demo fallbacks) ----------

const FH = 'https://finnhub.io/api/v1';
const TD = 'https://api.twelvedata.com';
const CG = 'https://api.coingecko.com/api/v3';

async function fetchCryptoQuote(symbol) {
  const id = CRYPTO_IDS[symbol];
  const rows = await cgQueue.run(() =>
    getJSON(`${CG}/coins/markets?vs_currency=usd&ids=${id}`));
  const r = Array.isArray(rows) ? rows[0] : null;
  if (!r || typeof r.current_price !== 'number') throw new Error('no crypto quote');
  const c = r.current_price;
  const d = r.price_change_24h ?? 0;
  return {
    c, d,
    dp: r.price_change_percentage_24h ?? 0,
    h: r.high_24h ?? c, l: r.low_24h ?? c,
    o: c - d, pc: c - d,
    t: Math.floor(Date.now() / 1000),
  };
}

async function fetchCryptoSeries(symbol) {
  const id = CRYPTO_IDS[symbol];
  const data = await cgQueue.run(() =>
    getJSON(`${CG}/coins/${id}/market_chart?vs_currency=usd&days=365&interval=daily`));
  const prices = Array.isArray(data?.prices) ? data.prices : [];
  if (!prices.length) throw new Error('no crypto series');
  const out = [];
  let prev = prices[0][1];
  for (const [ms, p] of prices) {
    out.push({
      t: new Date(ms).toISOString().slice(0, 10),
      o: prev, h: Math.max(prev, p), l: Math.min(prev, p), c: p, v: 0,
    });
    prev = p;
  }
  return out;
}

const CRYPTO_PROFILES = {
  BTC: { name: 'Bitcoin', exchange: 'Crypto · CoinGecko', finnhubIndustry: 'Digital asset', currency: 'USD', ticker: 'BTC' },
  ETH: { name: 'Ethereum', exchange: 'Crypto · CoinGecko', finnhubIndustry: 'Digital asset', currency: 'USD', ticker: 'ETH' },
  SOL: { name: 'Solana', exchange: 'Crypto · CoinGecko', finnhubIndustry: 'Digital asset', currency: 'USD', ticker: 'SOL' },
  DOGE: { name: 'Dogecoin', exchange: 'Crypto · CoinGecko', finnhubIndustry: 'Digital asset', currency: 'USD', ticker: 'DOGE' },
};

async function fetchQuote(symbol) {
  if (isCrypto(symbol)) return fetchCryptoQuote(symbol); // keyless — live even in demo mode
  if (!quotesLive()) return demoQuote(getDemoSeries(symbol));
  const q = await fhQueue.run(() =>
    getJSON(`${FH}/quote?symbol=${encodeURIComponent(symbol)}&token=${state.keys.finnhub}`));
  if (!q || typeof q.c !== 'number' || q.c === 0) throw new Error('no quote');
  return q;
}

async function fetchProfile(symbol) {
  if (isCrypto(symbol)) return CRYPTO_PROFILES[symbol];
  if (state.profiles.has(symbol)) return state.profiles.get(symbol);
  const cached = store.get(`profile.${symbol}`, null);
  if (cached) { state.profiles.set(symbol, cached); return cached; }
  if (!quotesLive()) return null;
  const p = await fhQueue.run(() =>
    getJSON(`${FH}/stock/profile2?symbol=${encodeURIComponent(symbol)}&token=${state.keys.finnhub}`));
  if (p && p.ticker) {
    state.profiles.set(symbol, p);
    store.set(`profile.${symbol}`, p);
    return p;
  }
  return null;
}

function cryptoMatches(query) {
  const q = query.toUpperCase();
  return Object.entries(CRYPTO_IDS)
    .filter(([sym, id]) => sym.includes(q) || id.toUpperCase().includes(q))
    .map(([sym]) => ({ symbol: sym, description: `${CRYPTO_PROFILES[sym]?.name ?? sym} (crypto)` }));
}

async function fetchSearch(query) {
  const crypto = cryptoMatches(query);
  if (!quotesLive()) {
    const q = query.toUpperCase();
    const stocks = DEMO_UNIVERSE.filter((r) => r.symbol.includes(q) || r.description.toUpperCase().includes(q));
    return [...crypto, ...stocks].slice(0, 8);
  }
  const data = await fhQueue.run(() =>
    getJSON(`${FH}/search?q=${encodeURIComponent(query)}&token=${state.keys.finnhub}`));
  const stocks = (data?.result ?? [])
    .filter((r) => !r.symbol.includes(' ') && (r.type === 'Common Stock' || r.type === 'ETP' || r.type === ''))
    .map((r) => ({ symbol: r.displaySymbol || r.symbol, description: r.description || '' }));
  return [...crypto, ...stocks].slice(0, 8);
}

function getDemoSeries(symbol) {
  if (!state.series.has(`demo:${symbol}`)) state.series.set(`demo:${symbol}`, genDemoSeries(symbol, 260));
  return state.series.get(`demo:${symbol}`);
}

async function fetchSeries(symbol) {
  if (state.series.has(symbol)) return { series: state.series.get(symbol), demo: false };
  const cached = store.get(`series.${symbol}`, null);
  if (cached && seriesCacheFresh(cached.savedAt, Date.now()) && Array.isArray(cached.series) && cached.series.length) {
    state.series.set(symbol, cached.series);
    return { series: cached.series, demo: false };
  }
  let series;
  if (isCrypto(symbol)) {
    series = await fetchCryptoSeries(symbol); // keyless — live even without keys
  } else if (!chartsLive()) {
    return { series: getDemoSeries(symbol), demo: true };
  } else {
    const data = await tdQueue.run(() =>
      getJSON(`${TD}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=260&apikey=${state.keys.twelvedata}`));
    series = parseTimeSeries(data);
    if (!series.length) throw new Error(data?.message || 'no series');
  }
  state.series.set(symbol, series);
  store.set(`series.${symbol}`, { savedAt: Date.now(), series });
  return { series, demo: false };
}

async function fetchGeneralNews() {
  const cached = store.get('newsGeneral', null);
  if (cached && Date.now() - cached.savedAt < NEWS_TTL_MS) return cached.items;
  if (!quotesLive()) return DEMO_NEWS;
  const data = await fhQueue.run(() => getJSON(`${FH}/news?category=general&token=${state.keys.finnhub}`));
  const items = (Array.isArray(data) ? data : []).slice(0, 8)
    .map((n) => ({ headline: n.headline, url: safeUrl(n.url), source: n.source, datetime: n.datetime }));
  if (items.length) store.set('newsGeneral', { savedAt: Date.now(), items });
  return items;
}

async function fetchCompanyNews(symbol) {
  if (!quotesLive() || isCrypto(symbol)) return [];
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const data = await fhQueue.run(() =>
    getJSON(`${FH}/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}&token=${state.keys.finnhub}`));
  return (Array.isArray(data) ? data : []).slice(0, 5)
    .map((n) => ({ headline: n.headline, url: safeUrl(n.url), source: n.source, datetime: n.datetime }));
}

const DEMO_UNIVERSE = [
  { symbol: 'AAPL', description: 'Apple Inc' }, { symbol: 'MSFT', description: 'Microsoft Corp' },
  { symbol: 'NVDA', description: 'NVIDIA Corp' }, { symbol: 'AMZN', description: 'Amazon.com Inc' },
  { symbol: 'GOOGL', description: 'Alphabet Inc' }, { symbol: 'META', description: 'Meta Platforms' },
  { symbol: 'TSLA', description: 'Tesla Inc' }, { symbol: 'AMD', description: 'Advanced Micro Devices' },
  { symbol: 'NFLX', description: 'Netflix Inc' }, { symbol: 'INTC', description: 'Intel Corp' },
  { symbol: 'SPY', description: 'SPDR S&P 500 ETF' }, { symbol: 'QQQ', description: 'Invesco QQQ' },
  { symbol: 'DIA', description: 'SPDR Dow Jones ETF' }, { symbol: 'IWM', description: 'iShares Russell 2000' },
];

const DEMO_NEWS = [
  { headline: 'Demo mode: add a free Finnhub key in Settings for live market news.', url: 'https://finnhub.io/register', source: 'Stock Tracker', datetime: Date.now() / 1000 },
];

// ---------- dialogs (focus-managed) ----------

let dialogOpener = null;

function openModal(dialog) {
  dialogOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!dialog.open) dialog.showModal();
}

function wireDialog(dialog) {
  dialog.addEventListener('close', () => {
    dialogOpener?.focus();
    dialogOpener = null;
  });
  // backdrop click closes (the dialog element itself is the backdrop target)
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

// ---------- rendering ----------

function deltaClass(n) { return n > 0 ? 'delta up' : n < 0 ? 'delta down' : 'delta'; }

function renderStrip() {
  const strip = $('#strip');
  strip.replaceChildren(...MARKET_STRIP.map(({ symbol, label }) => {
    const q = state.quotes.get(symbol);
    return el('div', { class: 'strip-item' },
      el('span', { class: 'strip-label', text: `${label} · ${symbol}` }),
      el('span', { class: 'strip-price', text: q ? fmtMoney(q.c) : '…' }),
      el('span', { class: q ? deltaClass(q.d) : 'delta', text: q ? `${fmtMoney(q.d)} (${fmtPct(q.dp)})` : '' }),
    );
  }));
}

function sparkSvg(symbol) {
  const series = state.series.get(symbol) ?? (!chartsLive() && !isCrypto(symbol) ? getDemoSeries(symbol) : null);
  if (!series) return null;
  const slice = sliceRange(series, '1M');
  if (slice.length < 2) return null;
  const up = slice.at(-1).c >= slice[0].c;
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('class', `spark ${up ? 'up' : 'down'}`);
  svg.setAttribute('viewBox', '0 0 120 36');
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(svgNS, 'polyline');
  line.setAttribute('points', buildSparkPoints(slice, 120, 36));
  svg.append(line);
  return svg;
}

function renderWatchlist() {
  const grid = $('#grid');
  grid.replaceChildren(...state.watchlist.map((symbol) =>
    cardComposite(symbol, state.quotes.get(symbol), state.profiles.get(symbol) ?? (isCrypto(symbol) ? CRYPTO_PROFILES[symbol] : null), state.stale.has(symbol))));
}

// A card: quote summary + sparkline, with detail + remove actions.
function cardComposite(symbol, q, p, stale) {
  return el('div', { class: `card${stale ? ' stale' : ''}` },
    el('div', { class: 'sym-row' },
      el('span', { class: 'sym', text: symbol }),
      el('span', { class: q ? deltaClass(q.d) : 'delta', text: q ? fmtPct(q.dp) : '' }),
    ),
    el('div', { class: 'name', text: p?.name ?? '' }),
    el('div', { class: 'price', text: q ? fmtMoney(q.c) : '…' }),
    el('div', { class: 'range', text: q ? `Day ${fmtMoney(q.l)} – ${fmtMoney(q.h)}` : ' ' }),
    stale ? el('div', { class: 'stale-badge', text: 'quote unavailable — retrying' }) : null,
    sparkSvg(symbol),
    el('div', { class: 'row2' },
      el('button', { class: 'ghost', 'data-detail': symbol, 'aria-haspopup': 'dialog', text: 'Chart & info' }),
      el('button', { class: 'card-remove', 'data-remove': symbol, 'aria-label': `Remove ${symbol} from watchlist`, text: 'remove' }),
    ),
  );
}

function renderPortfolio() {
  const body = $('#portfolio-body');
  const foot = $('#portfolio-foot');
  const empty = $('#portfolio-empty');
  const rows = state.positions.map((pos) => ({ pos, m: positionMetrics(pos, state.quotes.get(pos.symbol) ?? null) }));
  empty.hidden = rows.length > 0;
  $('#portfolio-table').hidden = rows.length === 0;
  $('#portfolio-analyze').hidden = rows.length === 0;

  body.replaceChildren(...rows.map(({ pos, m }) => el('tr', {},
    el('td', { text: m.symbol }),
    el('td', { class: 'num', text: String(m.shares) }),
    el('td', { class: 'num', text: fmtMoney(m.costBasis) }),
    el('td', { class: 'num', text: m.value == null ? '—' : fmtMoney(m.value / m.shares) }),
    el('td', { class: 'num', text: fmtMoney(m.value) }),
    el('td', { class: `num ${deltaClass(m.dayChange ?? 0)}`, text: fmtMoney(m.dayChange) }),
    el('td', { class: `num ${deltaClass(m.pl ?? 0)}`, text: fmtMoney(m.pl) }),
    el('td', { class: `num ${deltaClass(m.plPct ?? 0)}`, text: fmtPct(m.plPct) }),
    el('td', {}, el('button', { class: 'row-remove', 'data-remove-pos': pos.id, 'aria-label': `Remove ${m.symbol} position`, text: '×' })),
  )));

  if (rows.length) {
    const t = portfolioTotals(rows.map((r) => r.m));
    foot.replaceChildren(el('tr', {},
      el('td', { text: 'Total' }),
      el('td', {}), el('td', {}),
      el('td', {}),
      el('td', { class: 'num', text: fmtMoney(t.value) }),
      el('td', { class: `num ${deltaClass(t.dayChange)}`, text: fmtMoney(t.dayChange) }),
      el('td', { class: `num ${deltaClass(t.pl)}`, text: fmtMoney(t.pl) }),
      el('td', { class: `num ${deltaClass(t.plPct ?? 0)}`, text: fmtPct(t.plPct) }),
      el('td', {}),
    ));
  } else {
    foot.replaceChildren();
  }
}

function renderNews(items) {
  $('#news').replaceChildren(...items.map((n) => el('li', {},
    el('a', { href: safeUrl(n.url), target: '_blank', rel: 'noopener noreferrer', text: n.headline }),
    el('div', { class: 'news-meta', text: `${n.source ?? ''} · ${newsDate(n.datetime)}` }),
  )));
}

function setStatus(text) { $('#status').textContent = text; }

function refreshStatusLine() {
  const mode = quotesLive() ? 'Live quotes' : 'Demo data (crypto live)';
  const charts = chartsLive() ? 'live charts' : 'demo charts';
  setStatus(`${mode} · ${charts} · updated ${new Date().toLocaleTimeString()}`);
}

// ---------- relational panel (WJ as design language) ----------

function buildSeriesMap() {
  const map = {};
  for (const symbol of state.watchlist) {
    const s = state.series.get(symbol) ?? (!chartsLive() && !isCrypto(symbol) ? getDemoSeries(symbol) : null);
    if (s && s.length >= 43) map[symbol] = s;
  }
  return map;
}

function renderRelations() {
  const panel = $('#relations-body');
  const map = buildSeriesMap();
  const snap = relationalSnapshot(map, 21, 21);
  if (!snap) {
    panel.replaceChildren(el('p', { class: 'ref', text: 'Needs at least 3 watchlist symbols with ~2 months of overlapping history. Charts are still loading, or add more symbols.' }));
    return null;
  }
  const stability = snap.wj >= 0.8 ? 'stable' : snap.wj >= 0.6 ? 'drifting' : 'reorganizing';
  const pairLine = (p) => `${p.a} × ${p.b}`;
  panel.replaceChildren(
    el('div', { class: 'wj-row' },
      el('div', { class: 'stat wj-stat' },
        el('span', { text: 'Architecture similarity (WJ)' }),
        el('b', { class: `wj-${stability}`, text: `${snap.wj.toFixed(3)} · ${stability}` }),
      ),
      el('p', { class: 'ref', text: 'Weighted Jaccard between this month’s correlation architecture and last month’s, over all watchlist pairs. 1.000 = relationships unchanged; lower = the structure itself is moving.' }),
    ),
    el('div', { class: 'rel-cols' },
      el('div', {},
        el('h4', { text: 'Strongest relationships (1M)' }),
        el('ul', { class: 'rel-list' }, ...snap.pairs.slice(0, 5).map((p) => el('li', {},
          el('span', { class: 'rel-pair', text: pairLine(p) }),
          el('span', { class: `num ${deltaClass(p.r)}`, text: p.r.toFixed(2) }),
        ))),
      ),
      el('div', {},
        el('h4', { text: 'Biggest shifts vs prior month' }),
        el('ul', { class: 'rel-list' }, ...snap.shifts.slice(0, 5).map((p) => el('li', {},
          el('span', { class: 'rel-pair', text: pairLine(p) }),
          el('span', { class: 'num', text: `${p.prior.toFixed(2)} → ${p.r.toFixed(2)}` }),
        ))),
      ),
    ),
  );
  return snap;
}

// ---------- canvas chart ----------

function drawChart(canvas, series, range, symbol = state.detailSymbol ?? '') {
  const slice = sliceRange(series, range);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const cssW = canvas.clientWidth || 660;
  const cssH = 300;
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  const ctx = canvas.getContext('2d');
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;   // resize clears + re-uploads the texture — only when needed
    canvas.height = pxH;
  } else {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pxW, pxH);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (slice.length < 2) return;

  const padL = 56, padR = 10, padT = 12, padB = 24;
  const plotW = cssW - padL - padR;
  const plotH = cssH - padT - padB;
  const { min, max } = seriesExtent(slice);
  const y = (v) => padT + scaleY(v, min, max, plotH, 2);
  const step = plotW / slice.length;
  const bodyW = Math.max(1.5, Math.min(9, step * 0.62));

  // gridlines + y labels
  ctx.strokeStyle = '#2a3744';
  ctx.fillStyle = '#9fb0bf';
  ctx.lineWidth = 1;
  ctx.font = '11px ui-monospace, Consolas, monospace';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 3; i++) {
    const v = min + ((max - min) * i) / 3;
    const gy = y(v);
    ctx.beginPath();
    ctx.moveTo(padL, gy);
    ctx.lineTo(cssW - padR, gy);
    ctx.stroke();
    ctx.fillText(fmtMoney(v).replace('$', ''), padL - 6, gy);
  }

  // candles
  for (let i = 0; i < slice.length; i++) {
    const b = slice[i];
    const cx = padL + step * (i + 0.5);
    const up = b.c >= b.o;
    ctx.strokeStyle = up ? '#4ade80' : '#ff8389';
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.moveTo(cx, y(b.h));
    ctx.lineTo(cx, y(b.l));
    ctx.stroke();
    const top = y(Math.max(b.o, b.c));
    const bot = y(Math.min(b.o, b.c));
    ctx.fillRect(cx - bodyW / 2, top, bodyW, Math.max(1, bot - top));
  }

  // x labels: first + last date
  ctx.textAlign = 'left';
  ctx.fillText(slice[0].t, padL, cssH - 8);
  ctx.textAlign = 'right';
  ctx.fillText(slice.at(-1).t, cssW - padR, cssH - 8);

  // text alternative for the chart content (WCAG 1.1.1)
  canvas.setAttribute('aria-label',
    `Daily price chart for ${symbol}, ${range}: ${slice[0].t} to ${slice.at(-1).t}, range ${fmtMoney(min)} to ${fmtMoney(max)}, latest close ${fmtMoney(slice.at(-1).c)}`);
}

// ---------- analyst (Claude agent) ----------

function analystCtx() {
  const round2 = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : n);
  return {
    async toolQuote(raw) {
      const symbol = cleanSymbol(raw);
      if (!symbol) return { error: 'bad symbol' };
      const q = state.quotes.get(symbol) ?? await fetchQuote(symbol);
      return { symbol, price: round2(q.c), dayChange: round2(q.d), dayChangePct: round2(q.dp), dayLow: round2(q.l), dayHigh: round2(q.h), prevClose: round2(q.pc) };
    },
    async toolHistory(raw) {
      const symbol = cleanSymbol(raw);
      if (!symbol) return { error: 'bad symbol' };
      const { series, demo } = await fetchSeries(symbol);
      const c = condenseSeries(series, 60);
      return { symbol, demoData: demo, ...c };
    },
    async toolNews(raw) {
      const symbol = cleanSymbol(raw);
      if (!symbol) return { error: 'bad symbol' };
      const items = await fetchCompanyNews(symbol);
      return items.map((n) => ({ headline: n.headline, source: n.source, date: newsDate(n.datetime, true) }));
    },
    async toolProfile(raw) {
      const symbol = cleanSymbol(raw);
      if (!symbol) return { error: 'bad symbol' };
      const p = await fetchProfile(symbol);
      if (!p) return null;
      return { name: p.name, exchange: p.exchange, industry: p.finnhubIndustry, marketCap: p.marketCapitalization ? fmtCompact(p.marketCapitalization * 1e6) : null, ipo: p.ipo ?? null };
    },
    async toolWatchlist() {
      return state.watchlist.map((symbol) => {
        const q = state.quotes.get(symbol);
        return { symbol, price: q ? round2(q.c) : null, dayChangePct: q ? round2(q.dp) : null };
      });
    },
    toolPortfolio() {
      const rows = state.positions.map((pos) => positionMetrics(pos, state.quotes.get(pos.symbol) ?? null));
      const t = portfolioTotals(rows);
      return {
        positions: rows.map((r) => ({ symbol: r.symbol, shares: r.shares, costBasis: round2(r.costBasis), value: round2(r.value), pl: round2(r.pl), plPct: round2(r.plPct) })),
        totals: { value: round2(t.value), cost: round2(t.cost), pl: round2(t.pl), plPct: round2(t.plPct), dayChange: round2(t.dayChange) },
      };
    },
    async toolRelations() {
      // make sure the watchlist series are hydrated (cache-first; bounded by queues)
      for (const symbol of state.watchlist) {
        if (!state.series.has(symbol)) {
          try { await fetchSeries(symbol); } catch { /* skip symbols without data */ }
        }
      }
      const snap = relationalSnapshot(buildSeriesMap(), 21, 21);
      if (!snap) return { error: 'not enough overlapping history across watchlist symbols' };
      return {
        window: 'recent 21 trading days vs the prior 21',
        wj: snap.wj,
        meaning: 'weighted-Jaccard similarity of the two correlation architectures: 1 = unchanged, lower = reorganizing',
        strongestPairs: snap.pairs.slice(0, 8),
        biggestShifts: snap.shifts.slice(0, 8),
      };
    },
  };
}

function verdictCard(result) {
  const { verdict, text, trace, usage } = result;
  const wrap = el('div', { class: 'verdict' });
  if (verdict && verdict.rating) {
    wrap.append(
      el('div', { class: 'verdict-head' },
        el('span', { class: `verdict-chip verdict-${verdict.rating.toLowerCase()}`, text: verdict.rating }),
        verdict.confidence != null ? el('span', { class: 'verdict-conf num', text: `${Math.round(verdict.confidence)}% confidence` }) : null,
      ),
      verdict.summary ? el('p', { class: 'verdict-summary', text: verdict.summary }) : null,
      verdict.reasons.length ? el('div', {},
        el('h4', { text: 'Why' }),
        el('ul', { class: 'verdict-list' }, ...verdict.reasons.map((r) => el('li', { text: r }))),
      ) : null,
      verdict.risks.length ? el('div', {},
        el('h4', { text: 'What would change the call' }),
        el('ul', { class: 'verdict-list risks' }, ...verdict.risks.map((r) => el('li', { text: r }))),
      ) : null,
    );
  } else {
    wrap.append(el('p', { class: 'verdict-summary', text: text || 'The analyst returned nothing readable.' }));
  }
  const price = MODEL_PRICES[state.model];
  const cost = price
    ? ` (~$${((usage.input_tokens * price.input + usage.output_tokens * price.output) / 1e6).toFixed(3)})`
    : '';
  wrap.append(el('p', { class: 'verdict-meta ref', text: `Evidence pulled: ${trace.length ? trace.join(' · ') : 'none'} · ${usage.input_tokens + usage.output_tokens} tokens${cost}` }));
  wrap.append(el('p', { class: 'verdict-disclaimer ref', text: 'AI-generated educational analysis — not financial advice. Markets can invalidate any thesis.' }));
  return wrap;
}

async function runAnalysis(mode, symbol, container, button) {
  if (!analystReady()) {
    openModal($('#settings'));
    $('#key-anthropic').focus();
    return;
  }
  if (state.analystBusy) return;
  state.analystBusy = true;
  if (button) button.disabled = true;
  const progress = el('p', { class: 'ref verdict-progress', role: 'status', text: 'Analyst warming up…' });
  container.replaceChildren(progress);
  try {
    const result = await runAnalyst({
      apiKey: state.keys.anthropic,
      model: state.model,
      mode, symbol,
      ctx: analystCtx(),
      onProgress: (label) => { progress.textContent = `Analyst: ${label}`; },
    });
    container.replaceChildren(verdictCard(result));
  } catch (err) {
    container.replaceChildren(el('p', { class: 'ref verdict-error', text: `Analysis failed: ${err.message}` }));
  } finally {
    state.analystBusy = false;
    if (button) button.disabled = false;
  }
}

// ---------- detail dialog ----------

async function openDetail(symbol) {
  state.detailSymbol = symbol;
  state.lastDetailSeries = null; // prevent the prior symbol's chart leaking into this dialog
  const dialog = $('#detail');
  const body = $('#detail-body');
  $('#detail-title').textContent = symbol;
  const q = state.quotes.get(symbol);

  const ranges = el('div', { class: 'ranges', role: 'group', 'aria-label': 'Chart range' },
    ...['1M', '3M', '1Y'].map((r) => el('button', {
      'data-range': r, 'aria-pressed': String(r === state.detailRange), text: r,
    })));
  const canvas = el('canvas', { id: 'chart', width: '660', height: '300' });
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', `Daily price chart for ${symbol}`);
  const note = el('p', { class: 'chart-note', text: '' });
  const analyzeBtn = el('button', { id: 'detail-analyze', 'data-analyze': symbol, text: analystReady() ? 'Ask the analyst' : 'Ask the analyst (add key)' });

  body.replaceChildren(
    el('div', { class: 'detail-price-row' },
      el('span', { class: 'price', text: q ? fmtMoney(q.c) : '…' }),
      el('span', { class: q ? deltaClass(q.d) : 'delta', text: q ? `${fmtMoney(q.d)} (${fmtPct(q.dp)}) today` : '' }),
      analyzeBtn,
    ),
    el('div', { id: 'detail-analysis' }),
    ranges, canvas, note,
    el('div', { class: 'profile', id: 'profile' }),
    el('div', { class: 'detail-news', id: 'detail-news' }),
  );

  openModal(dialog);

  // chart
  try {
    const { series, demo } = await fetchSeries(symbol);
    if (state.detailSymbol !== symbol) return;
    state.lastDetailSeries = series;
    requestAnimationFrame(() => {
      if (state.detailSymbol === symbol) drawChart(canvas, series, state.detailRange, symbol);
    });
    note.textContent = demo
      ? 'Demo chart — synthetic data. Add a Twelve Data key in Settings for real candles.'
      : isCrypto(symbol)
        ? 'Daily closes · CoinGecko (keyless free API).'
        : 'Daily candles · Twelve Data free tier (end-of-day class data).';
  } catch (err) {
    note.textContent = `Chart unavailable: ${err.message}`;
  }

  // profile + news (best effort)
  try {
    const p = await fetchProfile(symbol);
    if (state.detailSymbol !== symbol) return;
    if (p) {
      $('#profile').replaceChildren(
        stat('Name', p.name), stat('Exchange', p.exchange), stat('Industry', p.finnhubIndustry),
        stat('Market cap', p.marketCapitalization ? fmtCompact(p.marketCapitalization * 1e6) : '—'),
        stat('IPO', p.ipo), stat('Currency', p.currency),
      );
    } else if (!quotesLive()) {
      $('#profile').replaceChildren(stat('Profile', 'Demo mode — add a Finnhub key'));
    }
  } catch { /* profile is decoration */ }

  try {
    const items = await fetchCompanyNews(symbol);
    if (state.detailSymbol !== symbol || !items.length) return;
    const list = el('ul', { class: 'news' });
    list.replaceChildren(...items.map((n) => el('li', {},
      el('a', { href: safeUrl(n.url), target: '_blank', rel: 'noopener noreferrer', text: n.headline }),
      el('div', { class: 'news-meta', text: `${n.source ?? ''} · ${newsDate(n.datetime, true)}` }),
    )));
    $('#detail-news').replaceChildren(el('h4', { text: 'Recent news' }), list);
  } catch { /* news is decoration */ }
}

function stat(label, value) {
  return el('div', { class: 'stat', text: label }, el('b', { text: value ?? '—' }));
}

// ---------- data refresh ----------

function allSymbols() {
  return [...new Set([
    ...MARKET_STRIP.map((s) => s.symbol),
    ...state.watchlist,
    ...state.positions.map((p) => p.symbol),
  ])];
}

async function refreshQuotes(gen = state.bootGen) {
  const symbols = allSymbols();
  await Promise.allSettled(symbols.map(async (symbol) => {
    try {
      const q = await fetchQuote(symbol);
      if (gen !== state.bootGen) return; // a newer boot owns the state now
      state.quotes.set(symbol, q);
      state.stale.delete(symbol);
    } catch {
      if (gen === state.bootGen) state.stale.add(symbol);
    }
  }));
  if (gen !== state.bootGen) return;
  renderStrip();
  renderWatchlist();
  renderPortfolio();
  refreshStatusLine();
}

async function hydrateSparklines(gen = state.bootGen) {
  for (const symbol of state.watchlist) {
    if (gen !== state.bootGen) return;
    if (state.series.has(symbol)) continue;
    try {
      await fetchSeries(symbol);
      if (gen !== state.bootGen) return;
      renderWatchlist();
    } catch { /* sparkline is decoration */ }
  }
  if (gen === state.bootGen) renderRelations();
}

async function hydrateProfiles(gen = state.bootGen) {
  for (const symbol of state.watchlist) {
    if (gen !== state.bootGen) return;
    try {
      await fetchProfile(symbol);
      if (gen === state.bootGen) renderWatchlist(); // progressive reveal per symbol
    } catch { /* decoration */ }
  }
}

// ---------- search ----------

let searchAbort = 0;
function bindSearch() {
  const input = $('#add-symbol');
  const list = $('#search-results');
  let active = -1;
  let results = [];
  let debounce;

  const close = () => {
    clearTimeout(debounce); // a pending search must not re-open a dismissed list
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    active = -1;
  };

  const renderResults = () => {
    list.replaceChildren(...results.map((r, i) => el('li', {
      role: 'option', id: `sr-${i}`, tabindex: '-1',
      'data-pick': r.symbol,
      'aria-selected': String(i === active),
    },
      el('span', { class: 'sr-sym', text: r.symbol }),
      el('span', { class: 'sr-name', text: r.description }),
    )));
    list.hidden = results.length === 0;
    input.setAttribute('aria-expanded', String(results.length > 0));
    if (active >= 0) input.setAttribute('aria-activedescendant', `sr-${active}`);
    else input.removeAttribute('aria-activedescendant');
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    const q = input.value.trim();
    if (q.length < 1) { results = []; renderResults(); return; }
    debounce = setTimeout(async () => {
      const ticket = ++searchAbort;
      try {
        const r = await fetchSearch(q);
        if (ticket !== searchAbort) return;
        results = r; active = -1; renderResults();
      } catch { /* search is best-effort */ }
    }, 350);
  });

  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, results.length - 1); renderResults(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = active <= 0 ? -1 : active - 1; renderResults(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); addSymbol(results[active].symbol); close(); input.value = ''; }
    else if (e.key === 'Escape') { close(); }
    else if (e.key === 'Tab') { close(); } // don't trap; just reset expanded state
  });

  list.addEventListener('click', (e) => {
    const opt = e.target.closest('[data-pick]');
    if (!opt) return;
    addSymbol(opt.dataset.pick);
    input.value = '';
    close();
  });

  document.addEventListener('click', (e) => {
    if (!list.hidden && !e.target.closest('.add-form')) close();
  });

  $('#add-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const symbol = cleanSymbol(input.value);
    if (symbol) { addSymbol(symbol); input.value = ''; close(); }
  });
}

function addSymbol(raw) {
  const symbol = cleanSymbol(raw);
  if (!symbol || state.watchlist.includes(symbol)) return;
  state.watchlist.push(symbol);
  store.set('watchlist', state.watchlist);
  renderWatchlist();
  refreshQuotes();
  hydrateSparklines();
  hydrateProfiles();
}

// ---------- events ----------

function bindEvents() {
  $('#grid').addEventListener('click', (e) => {
    const detailBtn = e.target.closest('[data-detail]');
    if (detailBtn) { openDetail(detailBtn.dataset.detail); return; }
    const removeBtn = e.target.closest('[data-remove]');
    if (removeBtn) {
      state.watchlist = state.watchlist.filter((s) => s !== removeBtn.dataset.remove);
      store.set('watchlist', state.watchlist);
      renderWatchlist();
      renderRelations();
    }
  });

  const detail = $('#detail');
  wireDialog(detail);
  detail.addEventListener('close', () => { state.detailSymbol = null; });
  detail.addEventListener('click', (e) => {
    const rangeBtn = e.target.closest('[data-range]');
    if (rangeBtn && state.lastDetailSeries) {
      state.detailRange = rangeBtn.dataset.range;
      detail.querySelectorAll('.ranges button').forEach((b) =>
        b.setAttribute('aria-pressed', String(b.dataset.range === state.detailRange)));
      drawChart($('#chart'), state.lastDetailSeries, state.detailRange);
      return;
    }
    const analyzeBtn = e.target.closest('[data-analyze]');
    if (analyzeBtn) {
      runAnalysis('symbol', analyzeBtn.dataset.analyze, $('#detail-analysis'), analyzeBtn);
    }
  });
  $('#detail-close').addEventListener('click', () => detail.close());

  $('#position-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const symbol = cleanSymbol(form.symbol.value);
    const shares = Number(form.shares.value);
    const costBasis = Number(form.costBasis.value);
    if (!symbol || !(shares > 0) || !(costBasis >= 0)) return;
    state.positions.push({ id: `p${posSeq++}`, symbol, shares, costBasis });
    store.set('positions', state.positions);
    form.reset();
    renderPortfolio();
    refreshQuotes();
  });

  $('#portfolio-body').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-remove-pos]');
    if (!btn) return;
    state.positions = state.positions.filter((p) => p.id !== btn.dataset.removePos);
    store.set('positions', state.positions);
    renderPortfolio();
  });

  $('#portfolio-analyze').addEventListener('click', (e) => {
    runAnalysis('portfolio', null, $('#portfolio-analysis'), e.currentTarget);
  });

  $('#relations-refresh').addEventListener('click', () => renderRelations());

  const settings = $('#settings');
  wireDialog(settings);
  const openSettings = () => {
    $('#key-finnhub').value = state.keys.finnhub || '';
    $('#key-twelvedata').value = state.keys.twelvedata || '';
    $('#key-anthropic').value = state.keys.anthropic || '';
    $('#model-select').value = state.model;
    openModal(settings);
  };
  $('#settings-open').addEventListener('click', openSettings);
  $('#banner-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', () => settings.close());
  $('#key-show').addEventListener('change', (e) => {
    const type = e.target.checked ? 'text' : 'password';
    $('#key-finnhub').type = type;
    $('#key-twelvedata').type = type;
    $('#key-anthropic').type = type;
  });
  $('#settings-form').addEventListener('submit', (e) => {
    e.preventDefault();
    state.keys = {
      finnhub: $('#key-finnhub').value.trim(),
      twelvedata: $('#key-twelvedata').value.trim(),
      anthropic: $('#key-anthropic').value.trim(),
    };
    state.model = $('#model-select').value;
    store.set('keys', state.keys);
    store.set('model', state.model);
    settings.close();
    boot(); // re-init with new keys
  });
  $('#clear-data').addEventListener('click', () => {
    store.clearAll();
    location.reload();
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshQuotes();
  });
}

// ---------- boot ----------

async function boot() {
  const gen = ++state.bootGen; // invalidates any in-flight sweeps from a prior boot
  $('#demo-banner').hidden = quotesLive();
  state.quotes.clear();
  state.series.clear();
  state.stale.clear();
  renderStrip();
  renderWatchlist();
  renderPortfolio();
  renderRelations();
  refreshStatusLine();

  refreshQuotes(gen);
  hydrateSparklines(gen);
  hydrateProfiles(gen);
  fetchGeneralNews().then((items) => { if (gen === state.bootGen) renderNews(items); })
    .catch((err) => console.warn('[stock-tracker] news failed:', err));

  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (!document.hidden) refreshQuotes();
  }, QUOTE_REFRESH_MS);
}

function populateModelSelect() {
  $('#model-select').replaceChildren(...ANALYST_MODELS.map((m) =>
    el('option', { value: m.id, text: m.label })));
  $('#model-select').value = state.model;
}

populateModelSelect();
bindSearch();
bindEvents();
boot();
