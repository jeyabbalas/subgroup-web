/**
 * Shared search-run plumbing for the optimized exact engines (spec §7.4):
 * backend resolution (BRIEF §5.4: `backend`/`workers`/`device`), evaluator +
 * scorer wiring, §3.3 membership gating, §3.4 pruning decisions, the §12
 * GPU exactness band (screening admissions re-scored on CPU f64), the
 * abort/yield/progress protocol, and result materialization. Algorithms own
 * only their traversal logic.
 */

import { CpuEvaluator } from "../backends/cpu/evaluator.js";
import { WorkerPoolEvaluator, type WorkerPoolOptions } from "../backends/cpu/pool.js";
import { getGpuEvaluatorFactory } from "../backends/registry.js";
import type { BatchEvaluator } from "../backends/types.js";
import { orInto } from "../bitset/bitset.js";
import { AbortedError, BackendError } from "../errors.js";
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
  /**
   * Evaluation backend. 'cpu' (default) runs single-thread unless `workers`
   * is set; 'webgpu' requires `registerWebGpu()` from `subgroup-web/webgpu`
   * (falls back to CPU with a note when the task is outside GPU
   * applicability, docs/design.md §GPU); 'auto' picks WebGPU when registered
   * and applicable on large tasks, else CPU with workers on large tasks.
   * Results are bit-identical across all backends (BRIEF §6.2/§7).
   */
  backend?: "auto" | "cpu" | "webgpu";
  /** Worker-pool parallel CPU evaluation (BRIEF §11). */
  workers?: boolean | number | WorkerPoolOptions;
  /** Injected GPUDevice (browser-managed or Node Dawn; BRIEF §13). */
  device?: GPUDevice;
}

/** Rows × selectors above which 'auto' reaches for workers/GPU. */
const AUTO_HEAVY_CELLS = 1 << 24;

export interface BackendInfo {
  /** Resolved evaluator name (cpu, cpu-workers(n), webgpu(...)). */
  name: string;
  /** Non-null when a requested backend fell back (reason). */
  note: string | null;
  /** §12 band statistics (GPU screening runs only). */
  band: { screened: number; rescored: number } | null;
}

async function resolveEvaluator(
  task: PreparedTask,
  options: SearchOptions,
): Promise<{ evaluator: BatchEvaluator; note: string | null }> {
  const requested = options.backend ?? "cpu";
  const heavy = task.table.nRows * task.selectors.length >= AUTO_HEAVY_CELLS;

  if (requested === "webgpu" || requested === "auto") {
    const factory = getGpuEvaluatorFactory();
    if (factory === null) {
      if (requested === "webgpu") {
        throw new BackendError(
          "backend 'webgpu' requested but no GPU factory is registered — " +
            "import { registerWebGpu } from 'subgroup-web/webgpu' and call it first",
        );
      }
    } else if (requested === "webgpu" || heavy) {
      const req: Parameters<typeof factory>[0] = {
        atlas: task.atlas,
        prepared: task.prepared,
        plan: task.qf.kind === "numeric" ? task.qf.plan : null,
      };
      if (options.device !== undefined) req.device = options.device;
      const gpu = await factory(req);
      if (gpu !== null) return { evaluator: gpu, note: null };
      if (requested === "webgpu") {
        return {
          evaluator: await cpuEvaluator(task, options),
          note: "webgpu requested but task outside GPU applicability — CPU fallback (design.md)",
        };
      }
    }
  }

  const wantWorkers =
    options.workers !== undefined && options.workers !== false
      ? true
      : requested === "auto" && heavy;
  if (wantWorkers) {
    return { evaluator: await workerEvaluator(task, options), note: null };
  }
  return { evaluator: await cpuEvaluator(task, options), note: null };
}

async function cpuEvaluator(task: PreparedTask, options: SearchOptions): Promise<BatchEvaluator> {
  if (options.workers !== undefined && options.workers !== false) {
    return workerEvaluator(task, options);
  }
  return new CpuEvaluator(
    task.atlas,
    task.prepared,
    task.qf.kind === "numeric" ? task.qf.plan : null,
  );
}

async function workerEvaluator(
  task: PreparedTask,
  options: SearchOptions,
): Promise<BatchEvaluator> {
  const w = options.workers;
  const poolOptions: WorkerPoolOptions =
    typeof w === "number" ? { count: w } : typeof w === "object" && w !== null ? w : {};
  return WorkerPoolEvaluator.create(
    task.atlas,
    task.prepared,
    task.qf.kind === "numeric" ? task.qf.plan : null,
    poolOptions,
  );
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
  /** Cover composition of this engine's descriptions ('or' = generalizingBFS). */
  readonly descriptionOp: "and" | "or";
  evaluated = 0;
  pruned = 0;
  /** §12 band statistics: screening admissions offered / re-scored on CPU. */
  screenedAdmissions = 0;
  rescoredAdmissions = 0;
  private backendNote: string | null;
  private sinceYield = 0;
  private disposed = false;
  /** Exact re-scoring path (non-null iff evaluator.screening). */
  private readonly rescorer: CpuEvaluator | null;
  private readonly rescoreCover: Uint32Array | null;
  private readonly rescoreQuality: Float64Array;

  private constructor(
    task: PreparedTask,
    options: SearchOptions,
    evaluator: BatchEvaluator,
    note: string | null,
    descriptionOp: "and" | "or",
  ) {
    this.task = task;
    this.ctx = new CoverEvalContext(task.table, task.prepared);
    this.evaluator = evaluator;
    this.backendNote = note;
    this.descriptionOp = descriptionOp;
    this.scorer = makeScorer(task, this.ctx);
    this.topk = new TopK(task.k, task.minQuality);
    this.batchSize = options.batchSize ?? 4096;
    const pruningOn = options.pruning !== false;
    this.canPrune =
      pruningOn &&
      task.qf.pruningSafe &&
      (task.qf as { optimisticEstimate?: unknown }).optimisticEstimate !== undefined;
    this.constraintPrune = pruningOn;
    if (evaluator.screening) {
      this.rescorer = new CpuEvaluator(
        task.atlas,
        task.prepared,
        task.qf.kind === "numeric" ? task.qf.plan : null,
      );
      this.rescoreCover = new Uint32Array(task.atlas.wordsPerRow);
    } else {
      this.rescorer = null;
      this.rescoreCover = null;
    }
    this.rescoreQuality = new Float64Array(1);
  }

  /** Resolve the backend per options and construct the run. */
  static async create(
    task: PreparedTask,
    options: SearchOptions,
    descriptionOp: "and" | "or" = "and",
  ): Promise<SearchRun> {
    const { evaluator, note } = await resolveEvaluator(task, options);
    return new SearchRun(task, options, evaluator, note, descriptionOp);
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
   * Under GPU screening, `oe` is an UPPER bound (scorer.ts) — pruning stays
   * conservative, hence exact (design.md §GPU-band).
   */
  shouldPrune(oe: number): boolean {
    return this.canPrune && this.topk.shouldPrune(oe);
  }

  /**
   * Offer a candidate to the run's top-k. Under an exact evaluator this is
   * `topk.add`. Under GPU screening (§12), `quality` is an upper bound: a
   * candidate that could enter is re-scored on CPU f64 through the identical
   * kernel + QF path FIRST, so every retained quality — and hence every
   * decision threshold — is exact and bit-identical to a pure-CPU run; a
   * candidate whose upper bound cannot enter is dropped (its exact quality
   * is ≤ the bound, so the drop is sound).
   */
  admit(quality: number, tuple: ArrayLike<number>): boolean {
    return this.admitInto(this.topk, quality, tuple);
  }

  /** `admit` against a caller-owned TopK (beamSearch's width-w pool). */
  admitInto(topk: TopK, quality: number, tuple: ArrayLike<number>): boolean {
    let q = quality;
    if (this.rescorer !== null) {
      this.screenedAdmissions++;
      if (!topk.couldAdmit(q, tuple)) return false;
      q = this.rescoreExact(tuple);
      this.rescoredAdmissions++;
    }
    return topk.add(q, tuple);
  }

  /** Exact f64 quality of a candidate via the CPU kernels (band re-score). */
  rescoreExact(tuple: ArrayLike<number>): number {
    const atlas = this.task.atlas;
    const cover = this.rescoreCover!;
    if (this.descriptionOp === "or") {
      cover.fill(0);
      for (let i = 0; i < tuple.length; i++) {
        orInto(cover, 0, cover, 0, atlas.bits, atlas.offset(tuple[i] as number), atlas.wordsPerRow);
      }
    } else {
      const ids: number[] = [];
      for (let i = 0; i < tuple.length; i++) ids.push(tuple[i] as number);
      atlas.coverInto(ids, cover);
    }
    const batch = this.rescorer!.evaluateCover(cover);
    this.scorer.scoreBatch(batch, tuple.length, () => tuple, this.rescoreQuality, null);
    return this.rescoreQuality[0]!;
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

  backendInfo(): BackendInfo {
    return {
      name: this.evaluator.name,
      note: this.backendNote,
      band:
        this.rescorer !== null
          ? { screened: this.screenedAdmissions, rescored: this.rescoredAdmissions }
          : null,
    };
  }

  /** Release evaluator resources (workers, GPU buffers). Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.evaluator.dispose();
  }

  finish(): SubgroupResults {
    this.dispose();
    return buildResults(
      this.task,
      this.topk.toArray(),
      this.evaluated,
      this.pruned,
      "conjunction",
      this.backendInfo(),
    );
  }
}
