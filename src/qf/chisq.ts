/**
 * chiSquared quality function (spec §6.2; BRIEF §22-A6).
 *
 * 2×2 contingency (subgroup, complement) × (positive, negative), **no Yates
 * continuity correction** — pinned from the reference's
 * `scipy.stats.chi2_contingency(..., correction=False)`
 * (binary_target.py:358-364). The statistic is computed like scipy: expected
 * cell = rowSum·colSum/N, χ² = Σ (obs − exp)²/exp in row-major cell order.
 *
 * stat 'chi2' → statistic; 'pValue' → dof-1 upper tail probability
 * Q(1/2, χ²/2) via the in-house incomplete gamma (spec §6.10). Directional
 * variants negate the value when the subgroup deviates the wrong way
 * (binary_target.py:365-373). Guard: n < minInstances or N − n < minInstances
 * → −inf; additionally n = 0 or n = N → −inf (spec §6.2; the reference would
 * crash inside scipy for minInstances = 0).
 */

import { ValidationError } from "../errors.js";
import type { PreparedBinary } from "../targets/types.js";
import { chi2TailProbability } from "../util/math.js";
import type { BinaryQF } from "./types.js";

export interface ChiSquaredOptions {
  direction?: "both" | "positive" | "negative";
  minInstances?: number;
  stat?: "chi2" | "pValue";
}

/** 0 < P < N or the 2×2 table is degenerate (spec §6.2 task-setup rule). */
function assertNonDegenerate(P: number, N: number): void {
  if (P <= 0 || P >= N) {
    throw new ValidationError(
      "chiSquared: the dataset must contain both positives and negatives " +
        `(P = ${P}, N = ${N}); the 2×2 table is degenerate otherwise`,
    );
  }
}

export function chiSquared(options: ChiSquaredOptions = {}): BinaryQF {
  const direction = options.direction ?? "both";
  const minInstances = options.minInstances ?? 5;
  const stat = options.stat ?? "chi2";
  if (!["both", "positive", "negative"].includes(direction)) {
    throw new ValidationError(`chiSquared: invalid direction ${JSON.stringify(direction)}`);
  }
  if (stat !== "chi2" && stat !== "pValue") {
    throw new ValidationError(`chiSquared: invalid stat ${JSON.stringify(stat)}`);
  }
  return {
    kind: "binary",
    name: `chiSquared(${direction},${minInstances},${stat})`,
    pruningSafe: false, // no optimistic estimate (reference TODO agrees)
    validateTarget(c) {
      assertNonDegenerate(c.positives, c.n);
    },
    evaluate(size, positives, c) {
      const N = c.n;
      const P = c.positives;
      // Backstop for direct evaluate() callers; prepareTask rejects
      // degenerate targets before any search starts.
      assertNonDegenerate(P, N);
      if (size < minInstances || N - size < minInstances) return Number.NEGATIVE_INFINITY;
      if (size === 0 || size === N) return Number.NEGATIVE_INFINITY;

      // Observed 2×2: rows = (positive, negative), cols = (subgroup, complement)
      const a = positives;
      const b = P - positives;
      const cNeg = size - positives;
      const d = N - size - (P - positives);
      // scipy expected-frequency form (outer(rowSums, colSums)/N), row-major
      // accumulation order
      const col1 = size;
      const col2 = N - size;
      let x = 0;
      const cells = [
        [a, (P * col1) / N],
        [b, (P * col2) / N],
        [cNeg, ((N - P) * col1) / N],
        [d, ((N - P) * col2) / N],
      ] as const;
      for (const [obs, exp] of cells) {
        const diff = obs - exp;
        x += (diff * diff) / exp;
      }
      const value = stat === "chi2" ? x : chi2TailProbability(x, 1);
      if (direction === "both") return value;
      const pSg = positives / size;
      const p0 = P / N;
      if (direction === "positive") return pSg > p0 ? value : -value;
      return pSg < p0 ? value : -value;
    },
  };
}
