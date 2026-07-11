/**
 * Shared search-run plumbing for the optimized exact engines (spec §7.4):
 * evaluator + scorer wiring, §3.3 membership gating, §3.4 pruning decisions,
 * abort/yield/progress protocol, and result materialization. Algorithms own
 * only their traversal logic.
 */

import { CpuEvaluator } from "../backends/cpu/evaluator.js";
import type { BatchEvaluator } from "../backends/types.js";
import { AbortedError } from "../errors.js";
import { CoverEvalContext } from "../qf/context.js";
import { buildResults, type SubgroupResults } from "../results/result.js";
import { type BatchScorer, makeScorer } from "./scorer.js";
import type { PreparedTask } from "./task.js";
import { TopK } from "./topk.js";

/** Options shared by the optimized engines (BRIEF §5.4). */
export interface SearchOptions {
  /**
   * Optimistic-estimate and monotone-constraint subtree pruning. Default on.
   * `false` forces full enumeration — results MUST be identical (the §6.2
   * pruning-identity gate); exposed for that audit and for diagnostics.
   */
  pruning?: boolean;
  /** Candidates per evaluation batch / yield-and-abort check. */
  batchSize?: number;
}

export class SearchRun {
  readonly task: PreparedTask;
  readonly evaluator: BatchEvaluator;
  readonly scorer: BatchScorer;
  readonly ctx: CoverEvalContext;
  readonly topk: TopK;
  readonly batchSize: number;
  /** Estimate-based pruning active (option + admissible estimate present). */
  readonly canPrune: boolean;
  /** Monotone-constraint subtree pruning active (same switch, §6.2 gate). */
  readonly constraintPrune: boolean;
  evaluated = 0;
  pruned = 0;
  private sinceYield = 0;

  constructor(task: PreparedTask, options: SearchOptions) {
    this.task = task;
    this.ctx = new CoverEvalContext(task.table, task.prepared);
    this.evaluator = new CpuEvaluator(
      task.atlas,
      task.prepared,
      task.qf.kind === "numeric" ? task.qf.plan : null,
    );
    this.scorer = makeScorer(task, this.ctx);
    this.topk = new TopK(task.k, task.minQuality);
    this.batchSize = options.batchSize ?? 4096;
    const pruningOn = options.pruning !== false;
    this.canPrune =
      pruningOn &&
      task.qf.pruningSafe &&
      (task.qf as { optimisticEstimate?: unknown }).optimisticEstimate !== undefined;
    this.constraintPrune = pruningOn;
  }

  /** §3.3 membership: all constraints must accept the candidate. */
  membershipOk(size: number): boolean {
    if (this.task.minSupportRows > 0 && size < this.task.minSupportRows) return false;
    for (const c of this.task.constraints) {
      if (!c.isSatisfied({ size })) return false;
    }
    return true;
  }

  /** Monotone constraints only — refinements of a violator stay violators. */
  monotoneOk(size: number): boolean {
    if (this.task.minSupportRows > 0 && size < this.task.minSupportRows) return false;
    for (const c of this.task.monotoneConstraints) {
      if (!c.isSatisfied({ size })) return false;
    }
    return true;
  }

  /**
   * §3.4: may refinements of a candidate with estimate `oe` be skipped?
   * (Callers additionally consult `monotoneOk` under `constraintPrune`.)
   */
  shouldPrune(oe: number): boolean {
    return this.canPrune && this.topk.shouldPrune(oe);
  }

  /** Count evaluated candidates; yield/abort/progress every batchSize. */
  async tick(count: number, layer: number): Promise<void> {
    this.evaluated += count;
    this.sinceYield += count;
    if (this.sinceYield >= this.batchSize) {
      this.sinceYield = 0;
      if (this.task.signal?.aborted) throw new AbortedError("search aborted");
      this.report(layer);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  report(layer: number): void {
    if (this.task.onProgress) {
      this.task.onProgress({
        layer,
        candidatesEvaluated: this.evaluated,
        candidatesPruned: this.pruned,
        bestQuality: this.topk.bestQuality(),
        bestDescription: null,
      });
    }
  }

  finish(): SubgroupResults {
    this.evaluator.dispose();
    return buildResults(this.task, this.topk.toArray(), this.evaluated, this.pruned);
  }
}
