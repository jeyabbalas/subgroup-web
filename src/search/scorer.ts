/**
 * Central batch scoring (BRIEF §7/§11): quality and optimistic estimate per
 * candidate, computed in f64 from a StatsBatch through the task's QF. All
 * engines and backends share this one code path, so a given candidate's
 * quality is bit-identical everywhere on CPU.
 *
 * Stats-level QFs read the batch's SoA fields. Description-level QFs
 * (generalization-aware, combined) evaluate through the cached
 * CoverEvalContext — the reference-shaped mask path (their aggregates need
 * generalization statistics, BRIEF §22-A10); the bitset batch still supplies
 * `size` for constraints.
 */

import type { StatsBatch } from "../backends/types.js";
import { emmStatsAt, numericStatsAt } from "../backends/types.js";
import { Conjunction } from "../desc/conjunction.js";
import { ValidationError } from "../errors.js";
import type { CoverEvalContext } from "../qf/context.js";
import type { PreparedTask } from "./task.js";

export interface BatchScorer {
  /** True when scoring needs candidate descriptions (description-level QF). */
  readonly usesContext: boolean;
  /**
   * Fill `qualityOut` (and `oeOut` unless null) for every candidate in the
   * batch. `arity` is the candidates' depth (FI qualities depend on it);
   * `tupleAt` materializes candidate i's ascending selector ids — consulted
   * only when `usesContext`.
   */
  scoreBatch(
    batch: StatsBatch,
    arity: number,
    tupleAt: (i: number) => ArrayLike<number>,
    qualityOut: Float64Array,
    oeOut: Float64Array | null,
  ): void;
}

/**
 * Estimate value used when a QF exposes no optimistic estimate: +inf (never
 * prunable). Exact engines additionally consult `qf.pruningSafe` before
 * using any estimate for pruning (spec §6 admissibility).
 */
export function makeScorer(task: PreparedTask, ctx: CoverEvalContext): BatchScorer {
  const qf = task.qf;
  const prepared = task.prepared;

  if (qf.kind === "description") {
    return {
      usesContext: true,
      scoreBatch(batch, _arity, tupleAt, qualityOut, oeOut) {
        for (let i = 0; i < batch.count; i++) {
          const ids = tupleAt(i);
          const selectors = Array.from(ids as ArrayLike<number>, (id) => task.selectors[id]!);
          const desc = new Conjunction(selectors);
          qualityOut[i] = qf.evaluate(desc, ctx);
          if (oeOut) {
            oeOut[i] = qf.optimisticEstimate
              ? qf.optimisticEstimate(desc, ctx)
              : Number.POSITIVE_INFINITY;
          }
        }
      },
    };
  }

  switch (qf.kind) {
    case "binary": {
      if (prepared.kind !== "binary") {
        throw new ValidationError("binary QF needs a binary target");
      }
      const oeFn = qf.optimisticEstimate?.bind(qf);
      return {
        usesContext: false,
        scoreBatch(batch, _arity, _tupleAt, qualityOut, oeOut) {
          const positives = batch.positives!;
          for (let i = 0; i < batch.count; i++) {
            qualityOut[i] = qf.evaluate(batch.size[i]!, positives[i]!, prepared);
            if (oeOut) {
              oeOut[i] = oeFn
                ? oeFn(batch.size[i]!, positives[i]!, prepared)
                : Number.POSITIVE_INFINITY;
            }
          }
        },
      };
    }
    case "numeric": {
      if (prepared.kind !== "numeric") {
        throw new ValidationError("numeric QF needs a numeric target");
      }
      const oeFn = qf.optimisticEstimate?.bind(qf);
      return {
        usesContext: false,
        scoreBatch(batch, _arity, _tupleAt, qualityOut, oeOut) {
          for (let i = 0; i < batch.count; i++) {
            const s = numericStatsAt(batch, i);
            qualityOut[i] = qf.evaluate(s, prepared);
            if (oeOut) oeOut[i] = oeFn ? oeFn(s, prepared) : Number.POSITIVE_INFINITY;
          }
        },
      };
    }
    case "fi": {
      if (prepared.kind !== "fi") {
        throw new ValidationError("fi QF needs a frequentItemset target");
      }
      const oeFn = qf.optimisticEstimate?.bind(qf);
      return {
        usesContext: false,
        scoreBatch(batch, arity, _tupleAt, qualityOut, oeOut) {
          for (let i = 0; i < batch.count; i++) {
            const s = { size: batch.size[i]!, depth: arity };
            qualityOut[i] = qf.evaluate(s, prepared);
            if (oeOut) oeOut[i] = oeFn ? oeFn(s, prepared) : Number.POSITIVE_INFINITY;
          }
        },
      };
    }
    case "emm": {
      if (prepared.kind !== "emm") {
        throw new ValidationError("emm QF needs an emm target");
      }
      return {
        usesContext: false,
        scoreBatch(batch, _arity, _tupleAt, qualityOut, oeOut) {
          for (let i = 0; i < batch.count; i++) {
            qualityOut[i] = qf.evaluate(emmStatsAt(batch, i), prepared);
            if (oeOut) oeOut[i] = Number.POSITIVE_INFINITY;
          }
        },
      };
    }
  }
}
