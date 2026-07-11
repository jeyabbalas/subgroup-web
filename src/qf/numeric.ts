/**
 * Numeric-target quality functions (spec §6.3–6.5; BRIEF §22-A4).
 *
 * standardNumeric: q_a(sg) = n^a · (m − μ0) — absolute size power, pinned
 * from numeric_target.py:188-202. `invert: true` evaluates the QF on the
 * negated target (q = n^a · (μ0 − m)); the reference accepts the flag and
 * ignores it (ADJ-005).
 *
 * Estimators ('sum' default; 'average'/'max' → tail-max; 'order' → prefix
 * scan) and their admissibility ranges are specified in spec §6.3; the
 * n₊ = 0 closure returns 0 instead of the reference's −inf (ADJ-007 class:
 * reference over-pruning). standardNumericMedian uses the safe form
 * n^a·(T⁺max − med₀) for pruning (spec §6.4; the reference's own bound is
 * inadmissible for the median centroid).
 */

import { ValidationError } from "../errors.js";
import type { NumericCoverStats, NumericStatsPlan } from "../targets/stats.js";
import type { PreparedNumeric } from "../targets/types.js";
import type { NumericQF } from "./types.js";

export type NumericEstimator = "sum" | "average" | "max" | "order";

export interface StandardNumericOptions {
  invert?: boolean;
  estimator?: NumericEstimator;
}

function centroid0(c: PreparedNumeric, which: "mean" | "median"): number {
  return which === "mean" ? c.mean : c.median;
}

export function standardNumeric(a: number, options: StandardNumericOptions = {}): NumericQF {
  if (typeof a !== "number" || Number.isNaN(a)) {
    throw new ValidationError(`standardNumeric(a): a must be a number, got ${a}`);
  }
  const invert = options.invert ?? false;
  const estimator = options.estimator ?? "sum";
  const dir: 1 | -1 = invert ? -1 : 1;
  if (!["sum", "average", "max", "order"].includes(estimator)) {
    throw new ValidationError(`standardNumeric: invalid estimator ${JSON.stringify(estimator)}`);
  }
  const plan: NumericStatsPlan = {
    centroid: "mean",
    direction: dir,
    needStd: false,
    needMedian: false,
    needExcess: estimator === "sum",
    needTail: estimator === "average" || estimator === "max",
    needOrder: estimator === "order",
    orderA: a,
  };
  return {
    kind: "numeric",
    name: `standardNumeric(${a},${estimator}${invert ? ",invert" : ""})`,
    plan,
    // 'sum' and 'average'/'max' proven admissible for a ∈ [0,1]; 'order' for
    // any a ≥ 0 (spec §6.3).
    pruningSafe: estimator === "order" ? a >= 0 : a >= 0 && a <= 1,
    evaluate(s, c) {
      if (s.size === 0) return Number.NaN; // spec §5.5 (ADJ-004)
      const m = s.sum / s.size;
      return s.size ** a * (dir * (m - c.mean));
    },
    optimisticEstimate(s, c) {
      if (s.size === 0) return 0;
      switch (estimator) {
        case "sum":
          // Σ over cover of max(0, dir·(x − μ0)) — already ≥ 0.
          return s.excessSum;
        case "average":
        case "max":
          // n₊^a·(T⁺max − μ0) with the 0 closure at n₊ = 0 (spec §6.3).
          if (s.tailCount === 0) return 0;
          return s.tailCount ** a * s.tailExtreme;
        case "order":
          return s.orderEstimate;
      }
    },
  };
}

export interface StandardNumericMedianOptions {
  invert?: boolean;
  estimator?: "average" | "max";
}

/**
 * The reference's StandardQFNumeric(a, centroid='median'):
 * q = n^a · (median_sg − median₀). Only tail-max estimation is available
 * (median + 'order' raises NotImplementedError in the reference too).
 */
export function standardNumericMedian(
  a: number,
  options: StandardNumericMedianOptions = {},
): NumericQF {
  if (typeof a !== "number" || Number.isNaN(a)) {
    throw new ValidationError(`standardNumericMedian(a): a must be a number, got ${a}`);
  }
  const invert = options.invert ?? false;
  const estimator = options.estimator ?? "average";
  const dir: 1 | -1 = invert ? -1 : 1;
  if (estimator !== "average" && estimator !== "max") {
    throw new ValidationError(
      `standardNumericMedian: estimator must be 'average'|'max', got ${JSON.stringify(estimator)}`,
    );
  }
  const plan: NumericStatsPlan = {
    centroid: "median",
    direction: dir,
    needStd: false,
    needMedian: true,
    needExcess: false,
    needTail: true,
    needOrder: false,
    orderA: a,
  };
  return {
    kind: "numeric",
    name: `standardNumericMedian(${a}${invert ? ",invert" : ""})`,
    pruningSafe: a >= 0, // safe form below is admissible for any a ≥ 0 (spec §6.4)
    plan,
    evaluate(s, c) {
      if (s.size === 0) return Number.NaN;
      return s.size ** a * (dir * (s.median - c.median));
    },
    optimisticEstimate(s, _c) {
      if (s.size === 0 || s.tailCount === 0) return 0;
      // Safe form: n_sg^a · (T⁺max − med₀) — dominates the reference's
      // n₊-based bound, which is inadmissible for medians (spec §6.4).
      return s.size ** a * s.tailExtreme;
    },
  };
}

export interface TscoreOptions {
  invert?: boolean;
}

/**
 * t(sg) = √n · (m − μ0) / s_sg (population s); 0 when s_sg = 0
 * (numeric_target.py:658-674); NaN when n = 0 (spec §5.5, ADJ-004).
 */
export function standardNumericTscore(options: TscoreOptions = {}): NumericQF {
  const invert = options.invert ?? false;
  const dir: 1 | -1 = invert ? -1 : 1;
  const plan: NumericStatsPlan = {
    centroid: "mean",
    direction: dir,
    needStd: true,
    needMedian: false,
    needExcess: false,
    needTail: false,
    needOrder: false,
    orderA: 1,
  };
  return {
    kind: "numeric",
    name: `standardNumericTscore(${invert ? "invert" : ""})`,
    plan,
    pruningSafe: false, // no bounded estimate (reference sets +inf)
    evaluate(s, c) {
      if (s.size === 0) return Number.NaN;
      const m = s.sum / s.size;
      if (s.std === 0) return 0;
      return (Math.sqrt(s.size) * (dir * (m - c.mean))) / s.std;
    },
  };
}
