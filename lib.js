// lib.js — pure logic for Stock Tracker. No DOM, no fetch, no globals.
// Tested by lib.test.js (node --test).

// ---------- formatters ----------

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);

export function fmtMoney(n, currency = 'USD') {
  if (!isNum(n)) return '—';
  const abs = Math.abs(n).toLocaleString('en-US', {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
  return n < 0 ? `-${abs}` : abs;
}

export function fmtPct(n) {
  if (!isNum(n)) return '—';
  const fixed = n.toFixed(2);
  if (n > 0 && fixed !== '0.00') return `+${fixed}%`;
  return `${fixed}%`;
}

export function fmtCompact(n) {
  if (!isNum(n)) return '—';
  const abs = Math.abs(n);
  const tiers = [
    [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K'],
  ];
  for (const [div, suffix] of tiers) {
    if (abs >= div) {
      const v = n / div;
      // up to 2 decimals, trimmed (1.5K not 1.50K, 2.95T stays)
      const s = v.toFixed(2).replace(/\.?0+$/, '');
      return `${s}${suffix}`;
    }
  }
  return String(n);
}

// ---------- portfolio math ----------

// pos: {symbol, shares, costBasis(per share)} · quote: {c,d,dp,pc} or null
export function positionMetrics(pos, quote) {
  const shares = Number(pos.shares) || 0;
  const basis = Number(pos.costBasis) || 0;
  const cost = shares * basis;
  if (!quote || !isNum(quote.c)) {
    return { symbol: pos.symbol, shares, costBasis: basis, value: null, cost, pl: null, plPct: null, dayChange: null };
  }
  const value = shares * quote.c;
  const pl = value - cost;
  const plPct = cost > 0 ? (pl / cost) * 100 : null;
  const dayChange = isNum(quote.d) ? shares * quote.d : null;
  return { symbol: pos.symbol, shares, costBasis: basis, value, cost, pl, plPct, dayChange };
}

export function portfolioTotals(rows) {
  const t = { value: 0, cost: 0, pl: 0, plPct: null, dayChange: 0 };
  let pricedCost = 0;
  for (const r of rows) {
    t.cost += r.cost;
    if (isNum(r.value)) { t.value += r.value; pricedCost += r.cost; }
    if (isNum(r.pl)) t.pl += r.pl;
    if (isNum(r.dayChange)) t.dayChange += r.dayChange;
  }
  t.plPct = pricedCost > 0 ? (t.pl / pricedCost) * 100 : null;
  return t;
}

// ---------- series (Twelve Data shape) ----------

// {status:'ok', values:[{datetime,open,high,low,close,volume}...newest first]}
// → [{t,o,h,l,c,v}] chronological, numeric. [] on anything else.
export function parseTimeSeries(resp) {
  if (!resp || resp.status !== 'ok' || !Array.isArray(resp.values)) return [];
  const out = [];
  for (let i = resp.values.length - 1; i >= 0; i--) {
    const r = resp.values[i];
    out.push({
      t: r.datetime,
      o: Number(r.open), h: Number(r.high), l: Number(r.low), c: Number(r.close),
      v: Number(r.volume) || 0,
    });
  }
  return out;
}

const RANGE_BARS = { '1M': 21, '3M': 63, '1Y': 252 };

export function sliceRange(series, range) {
  const n = RANGE_BARS[range] ?? series.length;
  return series.slice(-n);
}

export function seriesExtent(series) {
  let min = Infinity, max = -Infinity;
  for (const b of series) {
    const lo = isNum(b.l) ? b.l : b.c;
    const hi = isNum(b.h) ? b.h : b.c;
    if (lo < min) min = lo;
    if (hi > max) max = hi;
  }
  return { min, max };
}

// Map a value into pixel y (0 = top). Flat ranges center.
export function scaleY(value, min, max, height, pad = 0) {
  const span = max - min;
  if (span <= 0) return height / 2;
  const usable = height - pad * 2;
  return pad + (1 - (value - min) / span) * usable;
}

// SVG polyline points string over closes.
export function buildSparkPoints(series, width, height) {
  if (!series.length) return '';
  const { min, max } = closesExtent(series);
  const stepX = series.length > 1 ? width / (series.length - 1) : 0;
  return series
    .map((b, i) => `${round2(i * stepX)},${round2(scaleY(b.c, min, max, height, 1))}`)
    .join(' ');
}

function closesExtent(series) {
  let min = Infinity, max = -Infinity;
  for (const b of series) { if (b.c < min) min = b.c; if (b.c > max) max = b.c; }
  return { min, max };
}

const round2 = (n) => Math.round(n * 100) / 100;

// ---------- demo data ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function symbolSeed(symbol) {
  let h = 2166136261;
  for (const ch of String(symbol)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Deterministic synthetic OHLCV: same symbol → same series. Weekdays only.
export function genDemoSeries(symbol, days = 260, endISO = '2026-06-05') {
  const rand = mulberry32(symbolSeed(symbol));
  let price = 40 + rand() * 360; // base price 40–400
  const drift = (rand() - 0.45) * 0.002; // slight per-symbol trend
  const vol = 0.008 + rand() * 0.014;    // daily volatility 0.8–2.2%

  // walk dates backwards to collect `days` weekdays, then build forward
  const dates = [];
  const d = new Date(`${endISO}T00:00:00Z`);
  while (dates.length < days) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  dates.reverse();

  const out = [];
  for (const t of dates) {
    const o = price;
    const ret = drift + (rand() * 2 - 1) * vol;
    const c = Math.max(1, o * (1 + ret));
    const hi = Math.max(o, c) * (1 + rand() * vol * 0.6);
    const lo = Math.min(o, c) * (1 - rand() * vol * 0.6);
    out.push({
      t,
      o: round2(o), h: round2(hi), l: round2(Math.max(0.5, lo)), c: round2(c),
      v: Math.round(2e5 + rand() * 8e6),
    });
    price = c;
  }
  return out;
}

export function demoQuote(series) {
  const last = series.at(-1), prev = series.at(-2) ?? last;
  const d = last.c - prev.c;
  return {
    c: last.c, d: round2(d),
    dp: prev.c > 0 ? round2((d / prev.c) * 100) : 0,
    h: last.h, l: last.l, o: last.o, pc: prev.c,
    t: Math.floor(new Date(`${last.t}T20:00:00Z`).getTime() / 1000),
  };
}

// ---------- WJ relational layer ----------
// WJ-as-design-language (Anthony's creative use of the framework, not Drake's
// research enforcement): the signal lives in the RELATIONSHIPS between symbols,
// not the symbols themselves. Individual stocks/coins are the fundamental units;
// the correlation architecture and how it reorganizes over time is the output.

// Intersect dates across symbols → aligned close arrays, chronological.
export function alignSeries(seriesMap) {
  const entries = Object.entries(seriesMap).filter(([, s]) => Array.isArray(s) && s.length);
  if (!entries.length) return { dates: [], closesBySym: {} };
  let common = null;
  for (const [, series] of entries) {
    const dates = new Set(series.map((b) => b.t));
    common = common ? new Set([...common].filter((d) => dates.has(d))) : dates;
  }
  const dates = [...common].sort();
  const closesBySym = {};
  for (const [sym, series] of entries) {
    const byDate = new Map(series.map((b) => [b.t, b.c]));
    closesBySym[sym] = dates.map((d) => byDate.get(d));
  }
  return { dates, closesBySym };
}

export function toReturns(closes) {
  const out = [];
  for (let i = 1; i < closes.length; i++) {
    out.push(closes[i - 1] > 0 ? (closes[i] - closes[i - 1]) / closes[i - 1] : 0);
  }
  return out;
}

function rankArray(values) {
  const idx = values.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]);
  const ranks = new Array(values.length);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    const avg = (i + j) / 2 + 1; // average rank for ties, 1-based
    for (let k = i; k <= j; k++) ranks[idx[k][1]] = avg;
    i = j + 1;
  }
  return ranks;
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0;
  for (let i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    cov += dx * dy; vx += dx * dx; vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

// Spearman rank correlation (robust default for the relational layer).
export function spearman(xs, ys) {
  if (xs.length !== ys.length || xs.length < 2) return 0;
  return pearson(rankArray(xs), rankArray(ys));
}

// Full pairwise Spearman matrix over per-symbol returns. ALL pairs, no
// pre-filtering — categories are findings, not inputs.
export function correlationMatrix(closesBySym) {
  const syms = Object.keys(closesBySym);
  const returns = syms.map((s) => toReturns(closesBySym[s]));
  const m = syms.map(() => new Array(syms.length).fill(0));
  for (let i = 0; i < syms.length; i++) {
    m[i][i] = 1;
    for (let j = i + 1; j < syms.length; j++) {
      const r = spearman(returns[i], returns[j]);
      m[i][j] = r;
      m[j][i] = r;
    }
  }
  return { syms, m };
}

// Weighted Jaccard similarity between two correlation architectures:
// sum(min(|a|,|b|)) / sum(max(|a|,|b|)) over the upper triangle.
// 1 = identical architecture, 0 = complete reorganization.
export function weightedJaccard(m1, m2) {
  let num = 0, den = 0;
  for (let i = 0; i < m1.length; i++) {
    for (let j = i + 1; j < m1.length; j++) {
      const a = Math.abs(m1[i][j]), b = Math.abs(m2[i][j]);
      num += Math.min(a, b);
      den += Math.max(a, b);
    }
  }
  if (den === 0) return 1; // two empty architectures are identical
  return num / den;
}

// Compare the recent correlation architecture against the prior window.
// Returns {syms, wj, pairs (recent, sorted by |r|), shifts (sorted by |delta|)}.
export function relationalSnapshot(seriesMap, recentBars = 21, priorBars = 21) {
  const { closesBySym } = alignSeries(seriesMap);
  const syms = Object.keys(closesBySym);
  const need = recentBars + priorBars + 1;
  if (syms.length < 3 || (closesBySym[syms[0]]?.length ?? 0) < need) return null;

  const slice = (from, to) => Object.fromEntries(syms.map((s) => [s, closesBySym[s].slice(from, to)]));
  const len = closesBySym[syms[0]].length;
  const recent = correlationMatrix(slice(len - recentBars - 1, len));
  const prior = correlationMatrix(slice(len - need, len - recentBars));

  const pairs = [];
  for (let i = 0; i < syms.length; i++) {
    for (let j = i + 1; j < syms.length; j++) {
      pairs.push({
        a: syms[i], b: syms[j],
        r: Math.round(recent.m[i][j] * 1000) / 1000,
        prior: Math.round(prior.m[i][j] * 1000) / 1000,
        delta: Math.round((recent.m[i][j] - prior.m[i][j]) * 1000) / 1000,
      });
    }
  }
  return {
    syms,
    wj: Math.round(weightedJaccard(recent.m, prior.m) * 1000) / 1000,
    pairs: [...pairs].sort((p, q) => Math.abs(q.r) - Math.abs(p.r)),
    shifts: [...pairs].sort((p, q) => Math.abs(q.delta) - Math.abs(p.delta)),
  };
}

// ---------- analyst helpers ----------

// Downsample a daily OHLCV series into a token-cheap shape for the analyst
// agent: ~target evenly-spaced closes + summary stats.
export function condenseSeries(series, target = 60) {
  if (!series.length) return null;
  const step = Math.max(1, Math.ceil(series.length / target));
  const closes = [];
  for (let i = 0; i < series.length; i += step) {
    closes.push({ t: series[i].t, c: series[i].c });
  }
  const last = series.at(-1);
  if (closes.at(-1).t !== last.t) closes.push({ t: last.t, c: last.c });
  const { min, max } = (() => {
    let lo = Infinity, hi = -Infinity;
    for (const b of series) { if (b.l < lo) lo = b.l; if (b.h > hi) hi = b.h; }
    return { min: lo, max: hi };
  })();
  const first = series[0];
  return {
    first: first.t,
    last: last.t,
    lastClose: last.c,
    changePct: first.c > 0 ? Math.round(((last.c - first.c) / first.c) * 10000) / 100 : 0,
    high52: max,
    low52: min,
    closes,
  };
}

const VALID_RATINGS = new Set(['BUY', 'HOLD', 'SELL']);

// Leniently extract the analyst verdict JSON from a model response.
// Returns {rating, confidence, summary, reasons, risks} or null.
export function parseVerdict(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const brace = text.indexOf('{');
  if (brace !== -1) candidates.push(text.slice(brace, text.lastIndexOf('}') + 1));
  for (const raw of candidates) {
    try {
      const obj = JSON.parse(raw);
      if (!obj || typeof obj !== 'object') continue;
      const rating = typeof obj.rating === 'string' && VALID_RATINGS.has(obj.rating.toUpperCase())
        ? obj.rating.toUpperCase() : null;
      const confidence = Number.isFinite(Number(obj.confidence))
        ? Math.min(100, Math.max(0, Number(obj.confidence))) : null;
      const cap = (s, n) => s.slice(0, n);
      return {
        rating,
        confidence,
        summary: typeof obj.summary === 'string' ? cap(obj.summary, 1200) : '',
        reasons: Array.isArray(obj.reasons) ? obj.reasons.filter((r) => typeof r === 'string').slice(0, 6).map((r) => cap(r, 400)) : [],
        risks: Array.isArray(obj.risks) ? obj.risks.filter((r) => typeof r === 'string').slice(0, 6).map((r) => cap(r, 400)) : [],
      };
    } catch { /* try next candidate */ }
  }
  return null;
}

// ---------- scheduler + cache ----------

const WINDOW_MS = 60_000;
const GRACE_MS = 250;

// timestamps: ms epochs of recent calls. Returns ms to wait before the next
// call keeps us at or under limitPerMin within a rolling 60s window.
export function nextDelay(timestamps, limitPerMin, now) {
  const recent = timestamps.filter((t) => now - t < WINDOW_MS).sort((a, b) => a - b);
  if (recent.length < limitPerMin) return 0;
  // wait until the oldest in-window call ages out
  const oldest = recent[recent.length - limitPerMin];
  return Math.max(0, oldest + WINDOW_MS - now) + GRACE_MS;
}

// Daily series cache is fresh until the UTC date rolls over.
export function seriesCacheFresh(savedAtMs, nowMs) {
  const day = (ms) => Math.floor(ms / 86_400_000);
  return day(savedAtMs) === day(nowMs);
}
