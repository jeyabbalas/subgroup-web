/**
 * EMM poly-regression sufficient statistics, fit, and likelihood
 * (spec §5.4, §6.7; BRIEF §22-A11).
 *
 * Sufficient statistics (n, Σx, Σy, Σxx, Σxy) are mergeable — the pattern-tree
 * engine (M5) merges them with the co-moment formula the reference uses in
 * `PolyRegression_ModelClass.gp_merge`. The fit is the degree-1 least-squares
 * closed form; degenerate inputs (n ≤ 2 or zero x-variance) yield NaN β
 * (ADJ-006: the reference returns numpy's minimum-norm solution on zero
 * variance instead of treating the model as unidentifiable).
 */

import { forEachSetBit } from "../bitset/bitset.js";
import { normPdf } from "../util/math.js";
import type { PreparedEMM } from "./types.js";

export interface EmmSufficientStats {
  n: number;
  sx: number;
  sy: number;
  sxx: number;
  sxy: number;
  syy: number;
}

export interface EmmFit {
  slope: number;
  intercept: number;
}

export interface EmmCoverStats {
  size: number;
  slope: number;
  intercept: number;
  /** Mean likelihood φ(residual) inside the cover (NaN when size = 0 or β NaN). */
  sgLikelihood: number;
  /** Mean likelihood over the complement (NaN when cover = all rows or β NaN). */
  complementLikelihood: number;
}

export function emmSufficientFromMask(prep: PreparedEMM, cover: Uint8Array): EmmSufficientStats {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < cover.length; i++) {
    if (cover[i] === 1) {
      const xv = prep.x[i]!;
      const yv = prep.y[i]!;
      n++;
      sx += xv;
      sy += yv;
      sxx += xv * xv;
      sxy += xv * yv;
      syy += yv * yv;
    }
  }
  return { n, sx, sy, sxx, sxy, syy };
}

export function emmSufficientFromBits(prep: PreparedEMM, words: Uint32Array): EmmSufficientStats {
  const s: EmmSufficientStats = { n: 0, sx: 0, sy: 0, sxx: 0, sxy: 0, syy: 0 };
  forEachSetBit(words, 0, words.length, (row) => {
    const xv = prep.x[row]!;
    const yv = prep.y[row]!;
    s.n++;
    s.sx += xv;
    s.sy += yv;
    s.sxx += xv * xv;
    s.sxy += xv * yv;
    s.syy += yv * yv;
  });
  return s;
}

/**
 * Degree-1 least-squares fit from sufficient statistics.
 * NaN β when n ≤ degree + 1 (= 2, reference model_target.py:286-287) or the
 * normal matrix is singular (zero x-variance; spec §5.4).
 */
export function emmFit(s: EmmSufficientStats): EmmFit {
  if (s.n <= 2) return { slope: Number.NaN, intercept: Number.NaN };
  const d = s.n * s.sxx - s.sx * s.sx;
  if (d === 0) return { slope: Number.NaN, intercept: Number.NaN };
  const slope = (s.n * s.sxy - s.sx * s.sy) / d;
  const intercept = s.sy / s.n - (slope * s.sx) / s.n;
  return { slope, intercept };
}

/**
 * Likelihood sums under a fit: Σ φ(residual) over the cover and over all rows
 * (the reference evaluates the pdf on every row, model_target.py:78-96).
 * Residual r_i = (slope·x_i + intercept) − y_i.
 */
export function emmCoverStats(
  prep: PreparedEMM,
  fit: EmmFit,
  inCover: (row: number) => boolean,
  size: number,
): EmmCoverStats {
  const n = prep.n;
  let sgSum = 0;
  let allSum = 0;
  for (let i = 0; i < n; i++) {
    const l = normPdf(fit.slope * prep.x[i]! + fit.intercept - prep.y[i]!);
    allSum += l;
    if (inCover(i)) sgSum += l;
  }
  const sgLikelihood = size > 0 ? sgSum / size : Number.NaN;
  const complementLikelihood = n - size > 0 ? (allSum - sgSum) / (n - size) : Number.NaN;
  return {
    size,
    slope: fit.slope,
    intercept: fit.intercept,
    sgLikelihood,
    complementLikelihood,
  };
}

export function emmStatsFromMask(prep: PreparedEMM, cover: Uint8Array): EmmCoverStats {
  const suff = emmSufficientFromMask(prep, cover);
  const fit = emmFit(suff);
  return emmCoverStats(prep, fit, (row) => cover[row] === 1, suff.n);
}

export function emmStatsFromBits(prep: PreparedEMM, words: Uint32Array): EmmCoverStats {
  const suff = emmSufficientFromBits(prep, words);
  const fit = emmFit(suff);
  return emmCoverStats(prep, fit, (row) => (words[row >>> 5]! & (1 << (row & 31))) !== 0, suff.n);
}

/**
 * Merge two disjoint sufficient-statistics vectors (pattern-tree algebra;
 * plain sums — the co-moment form is only needed for centered accumulators).
 */
export function emmMerge(a: EmmSufficientStats, b: EmmSufficientStats): EmmSufficientStats {
  return {
    n: a.n + b.n,
    sx: a.sx + b.sx,
    sy: a.sy + b.sy,
    sxx: a.sxx + b.sxx,
    sxy: a.sxy + b.sxy,
    syy: a.syy + b.syy,
  };
}

/** EMM statistics table exposed on results (spec §5.4). */
export function emmStatsTable(prep: PreparedEMM, s: EmmCoverStats): Record<string, number> {
  return {
    size_sg: s.size,
    size_dataset: prep.n,
    slope: s.slope,
    intercept: s.intercept,
    likelihood_sg: s.sgLikelihood,
    likelihood_complement: s.complementLikelihood,
  };
}
