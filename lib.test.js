import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fmtMoney, fmtPct, fmtCompact,
  positionMetrics, portfolioTotals,
  parseTimeSeries, sliceRange, seriesExtent, scaleY, buildSparkPoints,
  genDemoSeries, demoQuote,
  nextDelay, seriesCacheFresh,
  condenseSeries, parseVerdict,
  alignSeries, spearman, correlationMatrix, weightedJaccard, relationalSnapshot,
} from './lib.js';

// ---------- formatters ----------

test('fmtMoney formats positive, negative, null', () => {
  assert.equal(fmtMoney(1234.5), '$1,234.50');
  assert.equal(fmtMoney(-0.4), '-$0.40');
  assert.equal(fmtMoney(0), '$0.00');
  assert.equal(fmtMoney(null), '—');
  assert.equal(fmtMoney(undefined), '—');
  assert.equal(fmtMoney(NaN), '—');
});

test('fmtPct signs and rounds to 2 places', () => {
  assert.equal(fmtPct(1.234), '+1.23%');
  assert.equal(fmtPct(-0.456), '-0.46%');
  assert.equal(fmtPct(0), '0.00%');
  assert.equal(fmtPct(null), '—');
});

test('fmtCompact scales K/M/B/T', () => {
  assert.equal(fmtCompact(950), '950');
  assert.equal(fmtCompact(1_500), '1.5K');
  assert.equal(fmtCompact(2_300_000), '2.3M');
  assert.equal(fmtCompact(4_560_000_000), '4.56B');
  assert.equal(fmtCompact(2_950_000_000_000), '2.95T');
  assert.equal(fmtCompact(null), '—');
});

// ---------- portfolio math ----------

const QUOTE = { c: 110, d: 2, dp: 1.85, pc: 108 }; // current 110, +2 on the day

test('positionMetrics computes value/cost/PL/day change', () => {
  const m = positionMetrics({ symbol: 'TST', shares: 10, costBasis: 100 }, QUOTE);
  assert.equal(m.value, 1100);
  assert.equal(m.cost, 1000);
  assert.equal(m.pl, 100);
  assert.ok(Math.abs(m.plPct - 10) < 1e-9);
  assert.equal(m.dayChange, 20);
});

test('positionMetrics handles missing quote gracefully', () => {
  const m = positionMetrics({ symbol: 'TST', shares: 10, costBasis: 100 }, null);
  assert.equal(m.value, null);
  assert.equal(m.cost, 1000);
  assert.equal(m.pl, null);
  assert.equal(m.plPct, null);
  assert.equal(m.dayChange, null);
});

test('positionMetrics zero cost basis yields null plPct, not Infinity', () => {
  const m = positionMetrics({ symbol: 'TST', shares: 5, costBasis: 0 }, QUOTE);
  assert.equal(m.plPct, null);
});

test('portfolioTotals sums rows and ignores null values', () => {
  const rows = [
    positionMetrics({ symbol: 'A', shares: 10, costBasis: 100 }, QUOTE),  // value 1100
    positionMetrics({ symbol: 'B', shares: 2, costBasis: 50 }, { c: 40, d: -1, dp: -2.4, pc: 41 }), // value 80
    positionMetrics({ symbol: 'C', shares: 1, costBasis: 10 }, null),     // no quote
  ];
  const t = portfolioTotals(rows);
  assert.equal(t.value, 1180);
  assert.equal(t.cost, 1110);      // 1000 + 100 + 10
  assert.equal(t.pl, 80);          // (1100-1000) + (80-100); C excluded from pl
  assert.equal(t.dayChange, 18);   // 20 + (-2)
  assert.ok(t.plPct !== null);
});

test('portfolioTotals of empty list is all null/zero', () => {
  const t = portfolioTotals([]);
  assert.equal(t.value, 0);
  assert.equal(t.cost, 0);
  assert.equal(t.pl, 0);
  assert.equal(t.plPct, null);
});

// ---------- series ----------

const TD_RESPONSE = {
  status: 'ok',
  meta: { symbol: 'TST', interval: '1day' },
  values: [ // Twelve Data returns newest first, numbers as strings
    { datetime: '2026-06-04', open: '101.0', high: '103.0', low: '100.0', close: '102.5', volume: '1200' },
    { datetime: '2026-06-03', open: '99.0', high: '101.5', low: '98.5', close: '101.0', volume: '1100' },
    { datetime: '2026-06-02', open: '98.0', high: '99.5', low: '97.0', close: '99.0', volume: '1000' },
  ],
};

test('parseTimeSeries converts strings and reverses to chronological', () => {
  const s = parseTimeSeries(TD_RESPONSE);
  assert.equal(s.length, 3);
  assert.equal(s[0].t, '2026-06-02');
  assert.equal(s[2].t, '2026-06-04');
  assert.equal(typeof s[0].c, 'number');
  assert.equal(s[2].c, 102.5);
  assert.equal(s[0].v, 1000);
});

test('parseTimeSeries returns [] on error payloads', () => {
  assert.deepEqual(parseTimeSeries({ status: 'error', message: 'limit' }), []);
  assert.deepEqual(parseTimeSeries(null), []);
  assert.deepEqual(parseTimeSeries({}), []);
});

test('sliceRange takes trading-day windows from the end', () => {
  const series = Array.from({ length: 300 }, (_, i) => ({ t: `d${i}`, c: i }));
  assert.equal(sliceRange(series, '1M').length, 21);
  assert.equal(sliceRange(series, '3M').length, 63);
  assert.equal(sliceRange(series, '1Y').length, 252);
  assert.equal(sliceRange(series, '1M').at(-1).c, 299); // keeps the latest bar
  assert.equal(sliceRange(series.slice(0, 10), '1Y').length, 10); // shorter than window
});

test('seriesExtent spans lows and highs', () => {
  const s = parseTimeSeries(TD_RESPONSE);
  const { min, max } = seriesExtent(s);
  assert.equal(min, 97.0);
  assert.equal(max, 103.0);
});

test('scaleY maps value range to pixel range (inverted)', () => {
  // min=0 max=100 in a 100px-high box, no padding: value 0 → y=100, value 100 → y=0
  assert.equal(scaleY(0, 0, 100, 100, 0), 100);
  assert.equal(scaleY(100, 0, 100, 100, 0), 0);
  assert.equal(scaleY(50, 0, 100, 100, 0), 50);
  // degenerate flat range centers
  assert.equal(scaleY(5, 5, 5, 100, 0), 50);
});

test('buildSparkPoints emits one x,y pair per close', () => {
  const s = parseTimeSeries(TD_RESPONSE);
  const pts = buildSparkPoints(s, 60, 20);
  const pairs = pts.split(' ');
  assert.equal(pairs.length, 3);
  assert.match(pairs[0], /^0(\.\d+)?,\d+(\.\d+)?$/);
  const lastX = Number(pairs[2].split(',')[0]);
  assert.equal(lastX, 60);
});

// ---------- demo data ----------

test('genDemoSeries is deterministic per symbol and plausible', () => {
  const a1 = genDemoSeries('AAPL', 260);
  const a2 = genDemoSeries('AAPL', 260);
  const b = genDemoSeries('MSFT', 260);
  assert.deepEqual(a1, a2);
  assert.notDeepEqual(a1, b);
  assert.equal(a1.length, 260);
  for (const bar of a1) {
    assert.ok(bar.l <= bar.o && bar.l <= bar.c && bar.l <= bar.h);
    assert.ok(bar.h >= bar.o && bar.h >= bar.c);
    assert.ok(bar.l > 0);
  }
  // chronological dates
  assert.ok(a1[0].t < a1[1].t);
});

test('demoQuote derives quote fields from the last two bars', () => {
  const s = genDemoSeries('AAPL', 30);
  const q = demoQuote(s);
  const last = s.at(-1), prev = s.at(-2);
  assert.equal(q.c, last.c);
  assert.equal(q.pc, prev.c);
  assert.ok(Math.abs(q.d - (last.c - prev.c)) < 1e-9);
  assert.equal(q.h, last.h);
  assert.equal(q.l, last.l);
});

// ---------- scheduler + cache ----------

test('nextDelay is 0 under the limit, waits when at the limit', () => {
  const now = 100_000;
  assert.equal(nextDelay([], 5, now), 0);
  assert.equal(nextDelay([now - 1000, now - 2000], 5, now), 0);
  // 5 calls within the last minute, oldest at now-50s → wait until it ages out (+10s + grace)
  const stamps = [now - 50_000, now - 40_000, now - 30_000, now - 20_000, now - 10_000];
  const d = nextDelay(stamps, 5, now);
  assert.ok(d >= 10_000 && d <= 11_500, `expected ~10s, got ${d}`);
  // stale stamps outside the window are ignored
  assert.equal(nextDelay([now - 61_000, now - 90_000], 2, now), 0);
});

// ---------- WJ relational layer ----------

const mkSeries = (closes, startDay = 1) =>
  closes.map((c, i) => ({ t: `2026-05-${String(startDay + i).padStart(2, '0')}`, o: c, h: c, l: c, c, v: 0 }));

test('alignSeries intersects dates across symbols, chronological', () => {
  const map = {
    A: mkSeries([1, 2, 3, 4, 5], 1),        // days 1-5
    B: mkSeries([10, 20, 30, 40], 2),       // days 2-5
  };
  const { dates, closesBySym } = alignSeries(map);
  assert.deepEqual(dates, ['2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05']);
  assert.deepEqual(closesBySym.A, [2, 3, 4, 5]);
  assert.deepEqual(closesBySym.B, [10, 20, 30, 40]);
});

test('spearman: monotonic up = 1, monotonic down = -1, constant = 0', () => {
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [10, 100, 1000, 10000, 100000]) - 1) < 1e-9);
  assert.ok(Math.abs(spearman([1, 2, 3, 4, 5], [5, 4, 3, 2, 1]) + 1) < 1e-9);
  assert.equal(spearman([1, 1, 1, 1], [1, 2, 3, 4]), 0); // zero variance → 0, not NaN
});

test('correlationMatrix is symmetric with unit diagonal over returns', () => {
  const A = [100, 101, 103, 102, 105, 108, 107, 110];
  const C = [100];
  for (let i = 1; i < A.length; i++) {
    const r = A[i] / A[i - 1] - 1;
    C.push(C[i - 1] * (1 - r)); // exact return inversion → Spearman -1
  }
  const closes = {
    A,
    B: A.map((v) => v * 0.5 + 3), // affine of A → identical return ranks → r = 1... not exactly; same shape
    C,
  };
  const { syms, m } = correlationMatrix(closes);
  assert.deepEqual(syms, ['A', 'B', 'C']);
  assert.equal(m[0][0], 1);
  assert.ok(Math.abs(m[0][1] - m[1][0]) < 1e-12);
  assert.ok(m[0][1] > 0.9, `A-B should be ~1, got ${m[0][1]}`);
  assert.ok(m[0][2] < -0.9, `A-C should be ~-1, got ${m[0][2]}`);
});

test('weightedJaccard: identical matrices = 1, orthogonal magnitudes < 1', () => {
  const m1 = [[1, 0.8, 0.2], [0.8, 1, -0.4], [0.2, -0.4, 1]];
  assert.equal(weightedJaccard(m1, m1), 1);
  const m2 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]; // all relationships gone
  assert.equal(weightedJaccard(m1, m2), 0);
  const m3 = [[1, 0.4, 0.1], [0.4, 1, -0.2], [0.1, -0.2, 1]]; // halved magnitudes
  const wj = weightedJaccard(m1, m3);
  assert.ok(wj > 0.4 && wj < 0.6, `expected ~0.5, got ${wj}`);
});

test('relationalSnapshot reports wj, strongest pairs, and biggest shifts', () => {
  // 50 bars: A & B move together throughout; C tracks A early then decouples.
  const n = 50;
  const a = [], b = [], c = [];
  let pa = 100;
  for (let i = 0; i < n; i++) {
    const step = (i % 2 === 0 ? 1 : -1) * (1 + (i % 5));
    pa += step;
    a.push(pa);
    b.push(pa * 0.5 + 3);
    c.push(i < n / 2 ? pa * 0.8 : 200 - pa + (i % 3)); // decouples/inverts late
  }
  const map = { A: mkSeries(a), B: mkSeries(b), C: mkSeries(c) };
  const snap = relationalSnapshot(map, 20, 20);
  assert.ok(snap.wj >= 0 && snap.wj <= 1);
  assert.equal(snap.syms.length, 3);
  const ab = snap.pairs.find((p) => p.a === 'A' && p.b === 'B');
  assert.ok(ab.r > 0.9, `A-B recent r should stay ~1, got ${ab.r}`);
  // the C pair shifts should outrank the stable A-B pair
  assert.ok(snap.shifts[0].a.includes('C') || snap.shifts[0].b.includes('C'));
  assert.ok(Math.abs(snap.shifts[0].delta) > Math.abs(ab.r - ab.prior));
});

test('relationalSnapshot returns null when fewer than 3 symbols align', () => {
  assert.equal(relationalSnapshot({ A: mkSeries([1, 2, 3]) }, 2, 2), null);
});

// ---------- analyst helpers ----------

test('condenseSeries downsamples to ~target points and reports stats', () => {
  const series = genDemoSeries('AAPL', 252);
  const c = condenseSeries(series, 60);
  assert.ok(c.closes.length <= 62 && c.closes.length >= 50, `got ${c.closes.length}`);
  assert.equal(c.first, series[0].t);
  assert.equal(c.last, series.at(-1).t);
  assert.equal(c.lastClose, series.at(-1).c);
  assert.ok(c.high52 >= c.lastClose * 0.5 && c.low52 > 0);
  assert.ok(typeof c.changePct === 'number');
  // closes keep chronological order
  const idx = c.closes.map((p) => p.t);
  assert.deepEqual(idx, [...idx].sort());
});

test('condenseSeries passes short series through untouched', () => {
  const series = genDemoSeries('MSFT', 10);
  const c = condenseSeries(series, 60);
  assert.equal(c.closes.length, 10);
});

test('parseVerdict extracts JSON from a fenced block', () => {
  const text = 'Here you go:\n```json\n{"rating":"HOLD","confidence":62,"summary":"s","reasons":["a"],"risks":["b"]}\n```\nDone.';
  const v = parseVerdict(text);
  assert.equal(v.rating, 'HOLD');
  assert.equal(v.confidence, 62);
  assert.deepEqual(v.reasons, ['a']);
});

test('parseVerdict handles bare JSON and clamps bad ratings to null', () => {
  const v = parseVerdict('{"rating":"buy","confidence":"88","summary":"s","reasons":[],"risks":[]}');
  assert.equal(v.rating, 'BUY');           // normalized to uppercase
  assert.equal(v.confidence, 88);          // numeric coercion
  const bad = parseVerdict('{"rating":"YOLO","confidence":50,"summary":"s"}');
  assert.equal(bad.rating, null);          // unknown rating → null, caller falls back
});

test('parseVerdict returns null on unparseable text', () => {
  assert.equal(parseVerdict('No JSON here at all.'), null);
  assert.equal(parseVerdict(''), null);
  assert.equal(parseVerdict(null), null);
});

test('seriesCacheFresh is true same UTC day, false across midnight', () => {
  const noon = Date.UTC(2026, 5, 5, 12, 0, 0);
  const evening = Date.UTC(2026, 5, 5, 22, 0, 0);
  const nextDay = Date.UTC(2026, 5, 6, 0, 30, 0);
  assert.equal(seriesCacheFresh(noon, evening), true);
  assert.equal(seriesCacheFresh(noon, nextDay), false);
  assert.equal(seriesCacheFresh(noon, noon), true);
});
