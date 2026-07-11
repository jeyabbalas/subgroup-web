/**
 * The backend abstraction (BRIEF §10): a `BatchEvaluator` turns batches of
 * candidate conjunctions into per-candidate statistics. It is the ONLY seam
 * between search logic and execution substrate — search algorithms are
 * backend-agnostic and exact; backends only accelerate statistics.
 *
 * Two batch shapes (both appear in BRIEF §10):
 * - tuple batches: flattened ascending selector-id tuples (apriori levels,
 *   worker sharding, GPU dispatches);
 * - extension batches: one parent cover + a list of extension selector ids
 *   (dfs / best-first node expansion).
 *
 * Backends return **statistics only** — never qualities. Quality and
 * optimistic-estimate computation happens centrally in f64 through the
 * task's QF (src/search/scorer.ts), which keeps ranking deterministic and
 * bit-identical across backends (BRIEF §7, §11).
 */

import type { EmmCoverStats } from "../targets/emm.js";
import type { NumericCoverStats } from "../targets/stats.js";

/**
 * Struct-of-arrays per-candidate statistics. `size` is always present;
 * target-specific fields are non-null exactly when the task's target/plan
 * needs them (the evaluator is constructed per task and knows which).
 * Typed arrays keep batches transferable to and from workers (M6).
 */
export interface StatsBatch {
  count: number;
  size: Uint32Array;
  /** Binary target. */
  positives: Uint32Array | null;
  /** Numeric target (per the QF's NumericStatsPlan; NaN where not planned). */
  sum: Float64Array | null;
  excessSum: Float64Array | null;
  tailCount: Uint32Array | null;
  tailExtreme: Float64Array | null;
  median: Float64Array | null;
  std: Float64Array | null;
  orderEstimate: Float64Array | null;
  /** EMM target (slope/intercept/mean likelihoods, spec §5.4/§6.7). */
  emmSlope: Float64Array | null;
  emmIntercept: Float64Array | null;
  emmSgLikelihood: Float64Array | null;
  emmComplementLikelihood: Float64Array | null;
  /**
   * Present iff the batch's numeric sums are GPU f32 SCREENING values
   * (BRIEF §12/§22-A7): per-candidate conservative absolute error bounds on
   * `sum` and `excessSum`. Scoring turns these into quality/estimate UPPER
   * bounds; decisions near a boundary are re-scored on CPU f64 (engine.ts).
   * Absent (undefined) on exact batches — every CPU batch, and GPU
   * binary/FI batches (integer-exact counts).
   */
  screening?: {
    sumEps: Float64Array;
    excessEps: Float64Array;
  };
}

/** View of candidate i's numeric stats as the QF-facing struct. */
export function numericStatsAt(batch: StatsBatch, i: number): NumericCoverStats {
  return {
    size: batch.size[i]!,
    sum: batch.sum![i]!,
    std: batch.std ? batch.std[i]! : Number.NaN,
    median: batch.median ? batch.median[i]! : Number.NaN,
    excessSum: batch.excessSum ? batch.excessSum[i]! : 0,
    tailCount: batch.tailCount ? batch.tailCount[i]! : 0,
    tailExtreme: batch.tailExtreme ? batch.tailExtreme[i]! : Number.NEGATIVE_INFINITY,
    orderEstimate: batch.orderEstimate ? batch.orderEstimate[i]! : Number.NEGATIVE_INFINITY,
  };
}

/** View of candidate i's EMM stats as the QF-facing struct. */
export function emmStatsAt(batch: StatsBatch, i: number): EmmCoverStats {
  return {
    size: batch.size[i]!,
    slope: batch.emmSlope![i]!,
    intercept: batch.emmIntercept![i]!,
    sgLikelihood: batch.emmSgLikelihood![i]!,
    complementLikelihood: batch.emmComplementLikelihood![i]!,
  };
}

export interface BatchEvaluator {
  readonly name: string;
  /**
   * True when this evaluator's numeric statistics are f32 screening values
   * needing the §12 exactness band (StatsBatch.screening). CPU evaluators
   * are always exact (false).
   */
  readonly screening: boolean;
  /**
   * Preferred engine batch size (candidates per evaluate call). GPU
   * evaluators pay one host sync per call, so they prefer large batches;
   * used when SearchOptions.batchSize is not set.
   */
  readonly preferredBatchSize?: number;
  /**
   * Statistics for `count` candidates given as flattened ascending
   * selector-id tuples (`arity` ids each). May resolve synchronously.
   */
  evaluateTuples(
    tuples: Uint16Array,
    arity: number,
    count: number,
  ): StatsBatch | Promise<StatsBatch>;
  /**
   * Statistics for the extensions of one parent: candidate j covers
   * parent ∘ selector(extensions[j]) where ∘ is `op` (default '∧';
   * '∨' serves the disjunction space of generalizingBFS, spec §7.11).
   * `parent = null` means the full table for 'and', the empty set for 'or'.
   */
  evaluateExtensions(
    parent: Uint32Array | null,
    extensions: ArrayLike<number>,
    op?: "and" | "or",
  ): StatsBatch | Promise<StatsBatch>;
  /** Release pooled resources (workers, GPU buffers). Idempotent. */
  dispose(): void;
}
