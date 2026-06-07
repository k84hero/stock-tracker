import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  corrMatrix, weightedJaccard, rowWj, signCoherence,
  decouplingPartners, regimeState, recentVol, rollingRegime,
} from './regime.js';

// retBySym: aligned daily-return arrays (all same length, indices = shared dates).
const ret3 = {
  a: [0.1, -0.1, 0.1, -0.1, 0.1, -0.1],
  b: [0.1, -0.1, 0.1, -0.1, 0.1, -0.1],
  c: [-0.1, 0.1, -0.1, 0.1, -0.1, 0.1],
};

test('corrMatrix: diagonal 1, a~b perfectly +, a~c perfectly -', () => {
  const M = corrMatrix(ret3, ['a', 'b', 'c'], 0, 6);
  assert.equal(M.a.a, 1);
  assert.equal(M.a.b, 1);
  assert.equal(M.a.c, -1);
});

test('corrMatrix: a constant slice yields null pairs (not a fake 0)', () => {
  const M = corrMatrix({ a: [0.05, 0.05, 0.05], b: [0.1, -0.1, 0.1] }, ['a', 'b'], 0, 3);
  assert.equal(M.a.b, null);
  assert.equal(M.b.a, null);
});

test('corrMatrix: matrix is symmetric (M.b.c === M.c.b)', () => {
  const M = corrMatrix(ret3, ['a', 'b', 'c'], 0, 6);
  assert.equal(M.b.c, M.c.b);
  assert.equal(M.a.c, M.c.a);
});

const ids = ['a', 'b', 'c'];
const m1 = { a: { a: 1, b: 0.8, c: 0.8 }, b: { a: 0.8, b: 1, c: 0.8 }, c: { a: 0.8, b: 0.8, c: 1 } };
const m2 = { a: { a: 1, b: -0.8, c: -0.8 }, b: { a: -0.8, b: 1, c: -0.8 }, c: { a: -0.8, b: -0.8, c: 1 } };

test('weightedJaccard: unsigned blind to sign (1.0), signed catches inversion (0)', () => {
  assert.equal(weightedJaccard(m1, m2, ids, { signed: false }), 1);
  assert.equal(weightedJaccard(m1, m2, ids, { signed: true }), 0);
  assert.equal(weightedJaccard(m1, m1, ids, { signed: true }), 1);
});

test('weightedJaccard: no shared pairs → null', () => {
  const na = { a: { b: null }, b: { a: null } };
  assert.equal(weightedJaccard(na, na, ['a', 'b'], { signed: true }), null);
});

test('rowWj isolates one symbol; signCoherence counts sign-preserving partners', () => {
  assert.equal(rowWj(m1, m2, 'a', ids, { signed: true }), 0);
  assert.equal(rowWj(m1, m1, 'a', ids, { signed: true }), 1);
  assert.equal(signCoherence(m1, m2, 'a', ids), 0);
  assert.equal(signCoherence(m1, m1, 'a', ids), 1);
});

test('decouplingPartners: sign-flipped partner ranks first, stable partner excluded', () => {
  const mPrev = { a: { b: 0.8, c: 0.7 }, b: { a: 0.8 }, c: { a: 0.7 } };
  const mNow = { a: { b: -0.8, c: 0.68 }, b: { a: -0.8 }, c: { a: 0.68 } };
  assert.deepEqual(decouplingPartners(mPrev, mNow, 'a', ['a', 'b', 'c']), ['b']);
});

test('regimeState: bands + confidence mapping (0.34 / 0.67 edges)', () => {
  assert.deepEqual(regimeState(0.1), { regime: 'stable', confidence: 'high' });
  assert.deepEqual(regimeState(0.33), { regime: 'stable', confidence: 'high' });
  assert.deepEqual(regimeState(0.34), { regime: 'elevated', confidence: 'med' });
  assert.deepEqual(regimeState(0.5), { regime: 'elevated', confidence: 'med' });
  assert.deepEqual(regimeState(0.67), { regime: 'reorganizing', confidence: 'low' });
  assert.deepEqual(regimeState(0.8), { regime: 'reorganizing', confidence: 'low' });
  assert.deepEqual(regimeState(null), { regime: 'unknown', confidence: 'unknown' });
});

test('recentVol: stdev of last n returns; <2 → null', () => {
  assert.ok(Math.abs(recentVol([0.1, -0.1, 0.1, -0.1], 4) - 0.1) < 1e-9);
  assert.equal(recentVol([0.1], 4), null);
});

// Build a synthetic OHLC-ish series: [{t, c}] is all rollingRegime needs (it reads close `c`).
const mkSeries = (closes, startDay = 1) =>
  closes.map((c, i) => ({ t: `2026-01-${String(startDay + i).padStart(2, '0')}`, c }));

test('rollingRegime: <3 holdings → not-ok, reason holdings', () => {
  const out = rollingRegime({ A: mkSeries([1, 2, 3]), B: mkSeries([1, 2, 3]) }, ['A', 'B'], { minHoldings: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'holdings');
});

test('rollingRegime: too little history → not-ok, reason history', () => {
  const s = mkSeries([10, 11, 12, 13, 14]); // 4 returns = exactly window → only 1 window, <2 needed
  const out = rollingRegime({ A: s, B: s, C: s }, ['A', 'B', 'C'], { window: 4, step: 1, minOverlap: 3, minHoldings: 3 });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'history');
});

test('rollingRegime: detects reorganization when A inverts vs B,C in the last window', () => {
  // 11 closes → 10 returns. window 4, step 2 → windows at returns [0..4),[2..6),[4..8),[6..10): 4 windows.
  const up = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];          // steady up: all-positive returns
  const aClose = [10, 11, 12, 13, 14, 15, 16, 15, 17, 16, 18];      // last stretch whips → inverts vs B,C
  const seriesMap = { A: mkSeries(aClose), B: mkSeries(up), C: mkSeries(up) };
  const weights = { A: 100, B: 100, C: 100 };
  const out = rollingRegime(seriesMap, ['A', 'B', 'C'], { window: 4, step: 2, minOverlap: 4, minHoldings: 3, weights });

  assert.equal(out.ok, true);
  assert.ok(out.trajectory.length >= 1);
  assert.ok(out.hero.reorg >= 0 && out.hero.reorg <= 1);
  assert.ok(['stable', 'elevated', 'reorganizing'].includes(out.hero.regime));
  assert.ok(out.perSymbol.A.reorg >= out.perSymbol.B.reorg);
  assert.ok(Array.isArray(out.perSymbol.A.decoupling_from));
  assert.equal(out.weightedStress != null, true);
  assert.equal(out.ids.length, 3);
  assert.equal(out.matrixLatest.ids.length, 3);
});

test('rollingRegime: weightedStress is null when no weights given', () => {
  const up = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
  const out = rollingRegime({ A: mkSeries(up), B: mkSeries(up), C: mkSeries(up) },
    ['A', 'B', 'C'], { window: 4, step: 2, minOverlap: 4, minHoldings: 3 });
  assert.equal(out.ok, true);
  assert.equal(out.weightedStress, null);
});
