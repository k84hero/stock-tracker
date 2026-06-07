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

// Pairwise Spearman matrix (nested object, id-keyed) over the window slice [s, s+window) of
// aligned returns. retBySym: { id: number[] } all same length. A pair is null if either slice is
// constant (degenerate — avoids a fake sign on a zero-variance series). Diagonal = 1.
export function corrMatrix(retBySym, ids, s, window) {
  const slice = {};
  for (const id of ids) slice[id] = retBySym[id].slice(s, s + window);
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

// --- placeholders replaced in later tasks (Task 4: rowWj/signCoherence/decouplingPartners;
// Task 5: regimeState/recentVol; Task 6: rollingRegime). Kept so regime.test.js can load. ---
export function rowWj() { throw new Error('not implemented (Task 4)'); }
export function signCoherence() { throw new Error('not implemented (Task 4)'); }
export function decouplingPartners() { throw new Error('not implemented (Task 4)'); }
export function regimeState() { throw new Error('not implemented (Task 5)'); }
export function recentVol() { throw new Error('not implemented (Task 5)'); }
export function rollingRegime() { throw new Error('not implemented (Task 6)'); }
