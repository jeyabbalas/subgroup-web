/**
 * standard(a) family for binary targets (spec §6.1).
 *
 * q_a(sg) = (n/N)^a · (p/n − P/N); NaN when n = 0
 * (binary_target.py:488-510). Aliases: wracc = standard(1),
 * simpleBinomial = standard(0.5), lift = standard(0).
 *
 * Optimistic estimate (tight): (p/N)^a · (1 − P/N) — keep only the positives
 * (binary_target.py:545-565); admissible for a ∈ [0, 1] (spec §6.1 proof).
 * Generalization estimate: ((n + P − p)/N)^a · (1 − P/N)
 * (binary_target.py:567-588).
 */

import { ValidationError } from "../errors.js";
import type { PreparedBinary } from "../targets/types.js";
import type { BinaryQF } from "./types.js";

export function standard(a: number): BinaryQF {
  if (!(a >= 0)) throw new ValidationError(`standard(a): a must be >= 0, got ${a}`);
  return {
    kind: "binary",
    name: a === 1 ? "wracc" : a === 0.5 ? "simpleBinomial" : a === 0 ? "lift" : `standard(${a})`,
    // The closed-form bound is proven admissible for a ∈ [0, 1] (spec §6.1).
    pruningSafe: a <= 1,
    evaluate(size, positives, c) {
      if (size === 0) return Number.NaN;
      const pSg = positives / size;
      const p0 = c.positives / c.n;
      return (size / c.n) ** a * (pSg - p0);
    },
    optimisticEstimate(size, positives, c) {
      // Reference passes (p, p) through the same formula; p = 0 gives
      // NaN there (n = 0 branch) — spec: the bound is 0 (only empty/negative
      // refinements remain). Both behaviors never admit a candidate wrongly;
      // 0 keeps the estimate a total function.
      if (positives === 0) return 0;
      const p0 = c.positives / c.n;
      return (positives / c.n) ** a * (1 - p0);
    },
    generalizationEstimate(size, positives, c) {
      const grown = size + (c.positives - positives);
      if (grown === 0) return Number.NaN;
      const p0 = c.positives / c.n;
      return (grown / c.n) ** a * (1 - p0);
    },
  };
}

export function wracc(): BinaryQF {
  return standard(1);
}

export function lift(): BinaryQF {
  return standard(0);
}

export function simpleBinomial(): BinaryQF {
  return standard(0.5);
}
