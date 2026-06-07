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
