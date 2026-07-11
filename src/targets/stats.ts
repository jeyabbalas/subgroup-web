/**
 * Per-subgroup (cover-level) statistics, dual-path, plus the full
 * statistic-table computations (spec §5.1–5.3, §5.5).
 *
 * Cover representations:
 * - mask: Uint8Array 0/1 per row — the row-scan spec path;
 * - bits: Uint32Array words (32 rows/word, tail-masked) — the bitset path.
 * The exhaustive oracle cross-checks the two on every fixture (BRIEF §6.1).
 */

import { andCount, countRange, forEachSetBit } from "../bitset/bitset.js";
import { mean, medianInPlace, pairwiseSum, populationStd } from "../util/math.js";
import type { PreparedBinary, PreparedFI, PreparedNumeric } from "./types.js";

// ---------------------------------------------------------------------------
// Binary

export interface BinaryCoverStats {
  size: number;
  positives: number;
}

export function binaryStatsFromMask(prep: PreparedBinary, cover: Uint8Array): BinaryCoverStats {
  let size = 0;
  let positives = 0;
  const pm = prep.positivesMask;
  for (let i = 0; i < cover.length; i++) {
    if (cover[i] === 1) {
      size++;
      positives += pm[i]!;
    }
  }
  return { size, positives };
}

export function binaryStatsFromBits(prep: PreparedBinary, words: Uint32Array): BinaryCoverStats {
  const len = words.length;
  return {
    size: countRange(words, 0, len),
    positives: andCount(words, 0, prep.positivesBits, 0, len),
  };
}

/** The reference's 13-field binary statistics table (spec §5.1). */
export function binaryStatsTable(
  prep: PreparedBinary,
  s: BinaryCoverStats,
): Record<string, number> {
  const N = prep.n;
  const P = prep.positives;
  const n = s.size;
  const p = s.positives;
  return {
    size_sg: n,
    size_dataset: N,
    positives_sg: p,
    positives_dataset: P,
    size_complement: N - n,
    relative_size_sg: n / N,
    relative_size_complement: (N - n) / N,
    coverage_sg: p / P,
    coverage_complement: (P - p) / P,
    target_share_sg: p / n, // NaN when n = 0 (IEEE 0/0)
    target_share_complement: n === N ? Number.NaN : (P - p) / (N - n),
    target_share_dataset: P / N,
    lift: p / n / (P / N),
  };
}

// ---------------------------------------------------------------------------
// Numeric

/**
 * What a numeric QF needs per cover (its evaluation plan; spec §6.3-6.5).
 * `direction` is +1 for the standard QF, −1 for invert (works on −T).
 */
export interface NumericStatsPlan {
  /** Centroid the estimator tails are measured against ('mean' | 'median'). */
  centroid: "mean" | "median";
  direction: 1 | -1;
  /** Two-pass population std (tscore). */
  needStd: boolean;
  needMedian: boolean;
  /** Σ over cover of max(0, dir·(x − c0)) — 'sum' estimator. */
  needExcess: boolean;
  /** Tail count/extreme past the centroid — 'average'/'max' estimators. */
  needTail: boolean;
  /** Prefix-scan best (order estimator); requires `orderA`. */
  needOrder: boolean;
  orderA: number;
}

export const BASIC_NUMERIC_PLAN: NumericStatsPlan = {
  centroid: "mean",
  direction: 1,
  needStd: false,
  needMedian: false,
  needExcess: false,
  needTail: false,
  needOrder: false,
  orderA: 1,
};

export interface NumericCoverStats {
  size: number;
  sum: number;
  /** Population std (two-pass, like np.std); NaN unless planned. */
  std: number;
  median: number;
  excessSum: number;
  tailCount: number;
  tailExtreme: number;
  orderEstimate: number;
}

function centroidOf(prep: PreparedNumeric, plan: NumericStatsPlan): number {
  return plan.centroid === "mean" ? prep.mean : prep.median;
}

/** Gather subgroup target values (mask path). */
export function gatherValuesFromMask(prep: PreparedNumeric, cover: Uint8Array): Float64Array {
  let size = 0;
  for (let i = 0; i < cover.length; i++) size += cover[i]!;
  const out = new Float64Array(size);
  let k = 0;
  for (let i = 0; i < cover.length; i++) {
    if (cover[i] === 1) out[k++] = prep.values[i]!;
  }
  return out;
}

/** Gather subgroup target values (bitset path). */
export function gatherValuesFromBits(prep: PreparedNumeric, words: Uint32Array): Float64Array {
  const size = countRange(words, 0, words.length);
  const out = new Float64Array(size);
  let k = 0;
  forEachSetBit(words, 0, words.length, (row) => {
    out[k++] = prep.values[row]!;
  });
  return out;
}

function statsFromGathered(
  prep: PreparedNumeric,
  gathered: Float64Array,
  plan: NumericStatsPlan,
): NumericCoverStats {
  const n = gathered.length;
  const dir = plan.direction;
  const c0 = centroidOf(prep, plan);
  const sum = pairwiseSum(gathered);
  let std = Number.NaN;
  if (plan.needStd) std = populationStd(gathered);
  let excessSum = 0;
  let tailCount = 0;
  let tailExtreme = Number.NEGATIVE_INFINITY;
  if (plan.needExcess || plan.needTail) {
    // Working value w = dir·(x − c0); tail is w > 0. Summation order is the
    // gathered (ascending-row) order — deterministic.
    for (let i = 0; i < n; i++) {
      const w = dir * (gathered[i]! - c0);
      if (w > 0) {
        excessSum += w;
        tailCount++;
        if (w > tailExtreme) tailExtreme = w;
      }
    }
  }
  let median = Number.NaN;
  let orderEstimate = Number.NEGATIVE_INFINITY;
  if (plan.needOrder && n > 0) {
    // Sort working values descending = dir·x descending; prefix-scan best.
    const work = new Float64Array(n);
    for (let i = 0; i < n; i++) work[i] = dir * gathered[i]!;
    work.sort();
    // ascending; walk backwards for descending prefix
    let running = 0;
    const a = plan.orderA;
    const c0w = dir * c0;
    for (let j = 1; j <= n; j++) {
      running += work[n - j]!;
      const q = j ** a * (running / j - c0w);
      if (q > orderEstimate) orderEstimate = q;
    }
  }
  if (plan.needMedian) {
    // medianInPlace sorts; reuse gathered only if the caller allows — we copy.
    median = medianInPlace(Float64Array.from(gathered));
  }
  return { size: n, sum, std, median, excessSum, tailCount, tailExtreme, orderEstimate };
}

export function numericStatsFromMask(
  prep: PreparedNumeric,
  cover: Uint8Array,
  plan: NumericStatsPlan,
): NumericCoverStats {
  return statsFromGathered(prep, gatherValuesFromMask(prep, cover), plan);
}

export function numericStatsFromBits(
  prep: PreparedNumeric,
  words: Uint32Array,
  plan: NumericStatsPlan,
): NumericCoverStats {
  return statsFromGathered(prep, gatherValuesFromBits(prep, words), plan);
}

/** The reference's 14-field numeric statistics table (spec §5.2). */
export function numericStatsTable(
  prep: PreparedNumeric,
  gathered: Float64Array,
): Record<string, number> {
  const n = gathered.length;
  const meanSg = mean(gathered);
  const stdSg = populationStd(gathered);
  let minSg = Number.POSITIVE_INFINITY;
  let maxSg = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    const v = gathered[i]!;
    if (v < minSg) minSg = v;
    if (v > maxSg) maxSg = v;
  }
  if (n === 0) {
    minSg = Number.NaN;
    maxSg = Number.NaN;
  }
  const medianSg = medianInPlace(Float64Array.from(gathered));
  return {
    size_sg: n,
    size_dataset: prep.n,
    mean_sg: meanSg,
    mean_dataset: prep.mean,
    std_sg: stdSg,
    std_dataset: prep.std,
    median_sg: medianSg,
    median_dataset: prep.median,
    max_sg: maxSg,
    max_dataset: prep.max,
    min_sg: minSg,
    min_dataset: prep.min,
    mean_lift: meanSg / prep.mean,
    median_lift: medianSg / prep.median,
  };
}

// ---------------------------------------------------------------------------
// FI

export interface FiCoverStats {
  size: number;
  depth: number;
}

export function fiStatsTable(prep: PreparedFI, s: FiCoverStats): Record<string, number> {
  return { size_sg: s.size, size_dataset: prep.n };
}

export function sizeFromMask(cover: Uint8Array): number {
  let size = 0;
  for (let i = 0; i < cover.length; i++) size += cover[i]!;
  return size;
}

export function sizeFromBits(words: Uint32Array): number {
  return countRange(words, 0, words.length);
}
