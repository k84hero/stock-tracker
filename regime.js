// regime.js — portfolio relational price-regime layer. Pure; reuses lib.js primitives.
// Ports gpu-price-tracker/scraper/wj.js's per-unit + rolling layer to stock-tracker's live
// DAILY bars. WJ-as-design-language: the signal is in how the holdings' correlation architecture
// reorganizes, not any single price. SIMILARITY convention: 1 = identical architecture (stable),
// 0 = fully reorganized. Per-symbol/portfolio reorg = 1 − signed (row|global) weighted-Jaccard.
// Correlations are computed on RETURNS, Spearman (rank), so price flukes don't dominate.
// NOTE: lib.js's weightedJaccard is UNSIGNED and 2D-array-shaped; the regime layer needs SIGNED
// WJ on id-keyed matrices, so it carries its own — but reuses spearman/toReturns/alignSeries.
import { spearman, toReturns, alignSeries } from './lib.js';

const round3 = (n) => (n == null ? null : Math.round(n * 1000) / 1000);
const round2 = (n) => Math.round(n * 100) / 100;
function isConstant(a) { for (let i = 1; i < a.length; i++) if (a[i] !== a[0]) return false; return true; }

// Pairwise Spearman matrix (nested object, id-keyed) over the length-`winLen` slice [s, s+winLen)
// of aligned returns. retBySym: { id: number[] } all same length. A pair is null if either slice
// is constant (degenerate — avoids a fake sign on a zero-variance series). Diagonal = 1.
// Precondition: every id in `ids` exists in `retBySym` with at least `s + winLen` returns
// (the caller, rollingRegime, filters ids to satisfy this).
export function corrMatrix(retBySym, ids, s, winLen) {
  const slice = {};
  for (const id of ids) slice[id] = retBySym[id].slice(s, s + winLen);
  const M = {};
  for (const i of ids) {
    M[i] = {};
    for (const j of ids) {
      if (i === j) { M[i][j] = 1; continue; }
      const xi = slice[i], xj = slice[j];
      M[i][j] = isConstant(xi) || isConstant(xj) ? null : spearman(xi, xj);
    }
  }
  return M;
}

// Weighted Jaccard SIMILARITY over the shared (non-null) upper-triangle pairs.
// unsigned: Σ min(|a|,|b|) / Σ max(|a|,|b|). signed: a sign flip contributes 0 to the numerator.
export function weightedJaccard(m1, m2, ids, { signed = false } = {}) {
  let num = 0, den = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = m1[ids[i]]?.[ids[j]], b = m2[ids[i]]?.[ids[j]];
      if (a == null || b == null) continue;
      den += Math.max(Math.abs(a), Math.abs(b));
      num += signed && Math.sign(a) !== Math.sign(b) ? 0 : Math.min(Math.abs(a), Math.abs(b));
    }
  }
  return den === 0 ? null : num / den;
}

// ---------- per-symbol decomposition ----------
// WJ similarity restricted to ONE symbol's correlation row (its partners). Per-unit decomposition.
export function rowWj(m1, m2, id, ids, { signed = false } = {}) {
  let num = 0, den = 0;
  for (const j of ids) {
    if (j === id) continue;
    const a = m1[id]?.[j], b = m2[id]?.[j];
    if (a == null || b == null) continue;
    den += Math.max(Math.abs(a), Math.abs(b));
    num += signed && Math.sign(a) !== Math.sign(b) ? 0 : Math.min(Math.abs(a), Math.abs(b));
  }
  return den === 0 ? null : num / den;
}

// Fraction of a symbol's partners that preserved correlation sign between windows. null if none shared.
export function signCoherence(m1, m2, id, ids) {
  let same = 0, total = 0;
  for (const j of ids) {
    if (j === id) continue;
    const a = m1[id]?.[j], b = m2[id]?.[j];
    if (a == null || b == null) continue;
    total++;
    if (Math.sign(a) === Math.sign(b)) same++;
  }
  return total === 0 ? null : same / total;
}

// A symbol's partners ranked by how much they decoupled (sign flip dominates, then |r| drop).
// Returns partner ids above a small threshold, most-decoupled first.
export function decouplingPartners(mPrev, mNow, id, ids) {
  const scored = [];
  for (const j of ids) {
    if (j === id) continue;
    const a = mPrev[id]?.[j], b = mNow[id]?.[j];
    if (a == null || b == null) continue;
    const flip = Math.sign(a) !== Math.sign(b) ? 1 : 0;
    const drop = Math.abs(a) - Math.abs(b); // positive = coupling weakened
    scored.push({ j, score: flip * 2 + Math.max(0, drop) });
  }
  return scored.filter((s) => s.score > 0.15).sort((p, q) => q.score - p.score).map((s) => s.j);
}
// Reorg → {regime, confidence}. Identical bands to gpu-tracker wj.js (deliberate parity).
export function regimeState(reorg) {
  if (reorg == null) return { regime: 'unknown', confidence: 'unknown' };
  if (reorg < 0.34) return { regime: 'stable', confidence: 'high' };
  if (reorg < 0.67) return { regime: 'elevated', confidence: 'med' };
  return { regime: 'reorganizing', confidence: 'low' };
}

// Population stdev of the last n returns (numbers). null if <2.
export function recentVol(rets, n) {
  const tail = (rets || []).slice(-n);
  if (tail.length < 2) return null;
  const mean = tail.reduce((s, x) => s + x, 0) / tail.length;
  const v = tail.reduce((s, x) => s + (x - mean) ** 2, 0) / tail.length;
  return Math.sqrt(v);
}

// Align the held subset to common dates and convert to daily returns. { retDates, ret:{id:number[]} }.
function alignReturns(seriesMap, ids) {
  const sub = {};
  for (const id of ids) if (Array.isArray(seriesMap[id]) && seriesMap[id].length) sub[id] = seriesMap[id];
  const { dates, closesBySym } = alignSeries(sub);
  const ret = {};
  for (const id of Object.keys(closesBySym)) ret[id] = toReturns(closesBySym[id]);
  return { retDates: dates.slice(1), ret }; // returns align to dates[1..]
}

// The orchestrator. seriesMap: { sym: [{t, c, ...}] }. holdingIds: symbols to span (HELD only).
// weights: { sym: marketValue } for the dollar-weighted stress (B). Options carry the config knobs.
// Returns { ok:false, reason } when under-powered, else the full regime payload.
export function rollingRegime(seriesMap, holdingIds, {
  window = 21, step = 5, minOverlap = 15, minHoldings = 3, weights = {},
} = {}) {
  const { retDates, ret } = alignReturns(seriesMap, holdingIds);
  const ids = holdingIds.filter((id) => Array.isArray(ret[id]) && ret[id].length >= window);
  const asof = retDates.at(-1) ?? null;
  if (ids.length < minHoldings) return { ok: false, reason: 'holdings', ids, asof };
  if (window < minOverlap) return { ok: false, reason: 'window', ids, asof };

  const L = retDates.length;
  const windows = [];
  for (let s = 0; s + window <= L; s += step) {
    windows.push({ asof: retDates[s + window - 1], M: corrMatrix(ret, ids, s, window) });
  }
  if (windows.length < 2) return { ok: false, reason: 'history', ids, asof };

  const trajectory = [];
  for (let k = 1; k < windows.length; k++) {
    const u = weightedJaccard(windows[k - 1].M, windows[k].M, ids, { signed: false });
    const sg = weightedJaccard(windows[k - 1].M, windows[k].M, ids, { signed: true });
    trajectory.push({
      date: windows[k].asof,
      reorg: sg == null ? null : round3(1 - sg),
      wj_signed: round3(sg),
      wj_unsigned: round3(u),
      gap: u != null && sg != null ? round3(u - sg) : null,
    });
  }

  const prev = windows.at(-2).M, now = windows.at(-1).M;
  const perSymbol = {};
  for (const id of ids) {
    const rwS = rowWj(prev, now, id, ids, { signed: true });
    const rwU = rowWj(prev, now, id, ids, { signed: false });
    const reorg = rwS == null ? null : 1 - rwS;
    perSymbol[id] = {
      ...regimeState(reorg),
      reorg: round3(reorg),
      sign_coherence: round3(signCoherence(prev, now, id, ids)),
      gap: rwU != null && rwS != null ? round3(rwU - rwS) : null,
      decoupling_from: decouplingPartners(prev, now, id, ids),
      vol: round3(recentVol(ret[id], window)),
    };
  }

  // A — hero: 1 − signed global WJ of the latest window pair (holdings architecture reorg).
  const heroSigned = weightedJaccard(prev, now, ids, { signed: true });
  const heroReorg = heroSigned == null ? null : 1 - heroSigned;
  const hero = { ...regimeState(heroReorg), reorg: round3(heroReorg) };

  // B — dollar-weighted per-symbol stress (position market value × per-symbol reorg).
  let wnum = 0, wden = 0;
  for (const id of ids) {
    const w = Number(weights[id]) || 0;
    const r = perSymbol[id].reorg;
    if (w > 0 && r != null) { wnum += w * r; wden += w; }
  }
  const weightedStress = wden > 0 ? round3(wnum / wden) : null;

  return {
    ok: true, asof: windows.at(-1).asof, ids, window, step, nWindows: windows.length,
    hero, weightedStress, trajectory, perSymbol,
    matrixLatest: { asof: windows.at(-1).asof, ids, r: ids.map((i) => ids.map((j) => round3(now[i]?.[j]))) },
  };
}
