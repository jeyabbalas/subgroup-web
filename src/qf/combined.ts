/**
 * combined([{qf, weight}]) (spec §6.9).
 *
 * Weighted sum of member qualities; optimistic estimate = weighted sum of
 * member estimates, defined only when every member has one and all weights
 * are ≥ 0 (then admissible as a nonnegative combination of admissible
 * bounds). The reference's CombinedInterestingnessMeasure raises
 * NotImplementedError on construction in 0.9.0 (measures.py:46-57) — this
 * implements the documented intent of its dead code (ADJ-008).
 */

import { ValidationError } from "../errors.js";
import type { DescriptionQF, QF } from "./types.js";

export interface CombinedMember {
  qf: QF;
  weight?: number;
}

export function combined(members: readonly CombinedMember[]): DescriptionQF {
  if (members.length === 0) {
    throw new ValidationError("combined: needs at least one member QF");
  }
  const weights = members.map((m) => m.weight ?? 1);
  const qfs = members.map((m) => m.qf);
  const kinds = new Set(qfs.map((q) => q.kind));
  if (kinds.size > 1) {
    throw new ValidationError(
      `combined: member QFs must share one target kind, got ${[...kinds].join(", ")}`,
    );
  }
  const allEstimable = qfs.every((q) => q.kind !== "emm" && q.optimisticEstimate !== undefined);
  const allNonNegative = weights.every((w) => w >= 0);
  const membersPruningSafe = qfs.every((q) => q.pruningSafe);
  return {
    kind: "description",
    name: `combined(${qfs.map((q, i) => `${weights[i]}*${q.name}`).join("+")})`,
    pruningSafe: allEstimable && allNonNegative && membersPruningSafe,
    evaluate(desc, ctx) {
      let total = 0;
      for (let i = 0; i < qfs.length; i++) {
        total += weights[i]! * ctx.evaluate(qfs[i]!, desc);
      }
      return total;
    },
    optimisticEstimate(desc, ctx) {
      if (!allEstimable) return Number.POSITIVE_INFINITY;
      let total = 0;
      for (let i = 0; i < qfs.length; i++) {
        total += weights[i]! * ctx.optimisticEstimate(qfs[i]!, desc);
      }
      return total;
    },
  };
}
