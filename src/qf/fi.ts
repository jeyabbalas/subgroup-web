/**
 * FI-target quality functions (spec §6.6).
 *
 * count: q = n, oe = n (fi_target.py:180-214). area: q = n · depth
 * (fi_target.py:217-237); the reference exposes no estimate for area — the
 * spec adds the admissible oe = n · maxDepth (refinements have size ≤ n,
 * depth ≤ task depth); the pruning-identity gate proves results unaffected.
 */

import type { FiQF } from "./types.js";

export function count(): FiQF {
  return {
    kind: "fi",
    name: "count",
    pruningSafe: true,
    evaluate(s) {
      return s.size;
    },
    optimisticEstimate(s) {
      return s.size;
    },
  };
}

export function area(maxDepth = Number.POSITIVE_INFINITY): FiQF {
  return {
    kind: "fi",
    name: "area",
    pruningSafe: Number.isFinite(maxDepth),
    evaluate(s) {
      return s.size * s.depth;
    },
    optimisticEstimate(s) {
      return s.size * maxDepth;
    },
  };
}
