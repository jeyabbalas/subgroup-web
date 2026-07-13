/**
 * Quality-function interfaces (spec §6).
 *
 * Stats-level QFs are pure functions of per-subgroup statistics + prepared
 * (constant) target statistics — the shape backends batch over. Description-
 * level QFs (generalization-aware, combined) additionally see the description
 * and an evaluation context that caches statistics of generalizations
 * (BRIEF §22-A10).
 *
 * `pruningSafe` marks optimistic estimates proven admissible (spec §6:
 * admissibility proofs/citations per QF); exact algorithms only prune when it
 * is true. Estimates that exist but are not admissible for the configured
 * parameters (e.g. numeric 'sum' with a > 1) keep pruningSafe = false.
 */

import type { Conjunction } from "../desc/conjunction.js";
import type { EmmCoverStats } from "../targets/emm.js";
import type {
  BinaryCoverStats,
  FiCoverStats,
  NumericCoverStats,
  NumericStatsPlan,
} from "../targets/stats.js";
import type { PreparedBinary, PreparedEMM, PreparedFI, PreparedNumeric } from "../targets/types.js";

export interface BinaryQF {
  readonly kind: "binary";
  readonly name: string;
  readonly pruningSafe: boolean;
  /**
   * `generalizationEstimate` is proven admissible over COVER-GROWING
   * refinements (the disjunction space of generalizingBFS; spec §7.11 proof).
   */
  readonly generalizationPruningSafe?: boolean;
  /**
   * Reject targets this QF cannot score (throw a ValidationError) — called
   * once by prepareTask right after target preparation, so degenerate tasks
   * fail at setup instead of mid-search (spec §6.2: chiSquared needs
   * 0 < P < N).
   */
  validateTarget?(c: PreparedBinary): void;
  evaluate(size: number, positives: number, c: PreparedBinary): number;
  optimisticEstimate?(size: number, positives: number, c: PreparedBinary): number;
  /** Reference `optimistic_generalisation` (generalizingBFS; spec §6.1). */
  generalizationEstimate?(size: number, positives: number, c: PreparedBinary): number;
}

export interface NumericQF {
  readonly kind: "numeric";
  readonly name: string;
  readonly plan: NumericStatsPlan;
  readonly pruningSafe: boolean;
  /**
   * Present exactly on the standardNumeric(a) mean-centroid family — the
   * applicability marker dfsNumeric requires (spec §7.9; the reference's
   * DFSNumeric raises unless the QF is a StandardQFNumeric).
   */
  readonly standard?: { a: number; dir: 1 | -1 };
  /** Task-setup target validation (see BinaryQF.validateTarget). */
  validateTarget?(c: PreparedNumeric): void;
  evaluate(s: NumericCoverStats, c: PreparedNumeric): number;
  optimisticEstimate?(s: NumericCoverStats, c: PreparedNumeric): number;
}

export interface FiQF {
  readonly kind: "fi";
  readonly name: string;
  readonly pruningSafe: boolean;
  /** Task-setup target validation (see BinaryQF.validateTarget). */
  validateTarget?(c: PreparedFI): void;
  evaluate(s: FiCoverStats, c: PreparedFI): number;
  optimisticEstimate?(s: FiCoverStats, c: PreparedFI): number;
}

export interface EmmQF {
  readonly kind: "emm";
  readonly name: string;
  readonly pruningSafe: boolean;
  /** Task-setup target validation (see BinaryQF.validateTarget). */
  validateTarget?(c: PreparedEMM): void;
  evaluate(s: EmmCoverStats, c: PreparedEMM): number;
}

/** Statistics resolver for description-level QFs; caches by canonical key. */
export interface EvalContext {
  readonly nRows: number;
  binaryStats(desc: Conjunction): BinaryCoverStats;
  numericStats(desc: Conjunction, plan: NumericStatsPlan): NumericCoverStats;
  fiStats(desc: Conjunction): FiCoverStats;
  emmStats(desc: Conjunction): EmmCoverStats;
  evaluate(qf: QF, desc: Conjunction): number;
  optimisticEstimate(qf: QF, desc: Conjunction): number;
}

export interface DescriptionQF {
  readonly kind: "description";
  readonly name: string;
  readonly pruningSafe: boolean;
  evaluate(desc: Conjunction, ctx: EvalContext): number;
  optimisticEstimate?(desc: Conjunction, ctx: EvalContext): number;
}

export type StatsQF = BinaryQF | NumericQF | FiQF | EmmQF;
export type QF = StatsQF | DescriptionQF;
