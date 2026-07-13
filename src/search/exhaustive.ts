/**
 * The exhaustive oracle (spec §7.2; BRIEF §6.1): a no-pruning enumerator of
 * the canonical candidate space C(S, d) with dual cross-checked statistics
 * paths. This is the ground truth every exact algorithm's §6.2 gate compares
 * against — deliberately simple, evaluation logic favoring obviousness over
 * speed everywhere except the enumeration loop itself.
 *
 * Dual paths per candidate:
 *   (1) bitset: word-wise AND over the selector atlas + SWAR popcounts;
 *   (2) row-scan: independent cover from column scans
 *       (src/desc/cover.ts) + byte-mask statistics.
 * Counts must agree exactly; f64 aggregates gather the identical multiset in
 * identical order, so equality is asserted exactly too (tighter than the
 * spec's rel ≤ 1e-12 allowance). Cross-check coverage: every candidate when
 * |C| ≤ `fullCrossCheckLimit`, else every 64th candidate (deterministic
 * stride) plus every retained result.
 */

import { andInto, orInto } from "../bitset/bitset.js";
import { Conjunction, Disjunction } from "../desc/conjunction.js";
import { conjunctionCover, disjunctionCover } from "../desc/cover.js";
import { AbortedError, ValidationError } from "../errors.js";
import { CoverEvalContext } from "../qf/context.js";
import { buildResults, type SubgroupResults, tupleDescription } from "../results/result.js";
import { emmStatsFromBits, emmStatsFromMask } from "../targets/emm.js";
import {
  binaryStatsFromBits,
  binaryStatsFromMask,
  numericStatsFromBits,
  numericStatsFromMask,
  sizeFromBits,
  sizeFromMask,
} from "../targets/stats.js";
import { type PreparedTask, prepareTask, type SubgroupTask } from "./task.js";
import { TopK } from "./topk.js";

export interface ExhaustiveOptions {
  /**
   * Dual-path verification coverage. 'auto' (default): full when the space
   * has ≤ fullCrossCheckLimit candidates, else strided sampling.
   */
  crossCheck?: "full" | "sampled" | "off" | "auto";
  fullCrossCheckLimit?: number;
  /** Candidates per event-loop yield / abort / progress check. */
  batchSize?: number;
  /**
   * Description form of the candidate space: index tuples over S read as
   * conjunctions (default) or as disjunctions — the generalizingBFS space
   * D(S, d) (spec §7.11). Description-level QFs require 'conjunction'.
   */
  form?: "conjunction" | "disjunction";
}

export interface CrossCheckReport {
  mode: "full" | "sampled" | "off";
  checked: number;
  total: number;
}

/** Total candidate count |C(S, d)| = Σ_{k=1..d} C(|S|, k). */
export function candidateSpaceSize(nSelectors: number, depth: number): number {
  let total = 0;
  let comb = 1;
  for (let k = 1; k <= Math.min(depth, nSelectors); k++) {
    comb = (comb * (nSelectors - k + 1)) / k;
    total += comb;
  }
  return Math.round(total);
}

interface EvaluatorState {
  readonly task: PreparedTask;
  readonly descCtx: CoverEvalContext;
  readonly form: "conjunction" | "disjunction";
  conj: Conjunction | Disjunction | null;
}

/** Evaluate the candidate on the bitset path: [quality, size]. */
function evaluateBits(
  state: EvaluatorState,
  coverWords: Uint32Array,
  depth: number,
): [number, number] {
  const { task } = state;
  const prep = task.prepared;
  const qf = task.qf;
  switch (qf.kind) {
    case "binary": {
      if (prep.kind !== "binary") throw new ValidationError("binary QF needs a binary target");
      const s = binaryStatsFromBits(prep, coverWords);
      return [qf.evaluate(s.size, s.positives, prep), s.size];
    }
    case "numeric": {
      if (prep.kind !== "numeric") throw new ValidationError("numeric QF needs a numeric target");
      const s = numericStatsFromBits(prep, coverWords, qf.plan);
      return [qf.evaluate(s, prep), s.size];
    }
    case "fi": {
      if (prep.kind !== "fi") throw new ValidationError("fi QF needs a frequentItemset target");
      const size = sizeFromBits(coverWords);
      return [qf.evaluate({ size, depth }, prep), size];
    }
    case "emm": {
      if (prep.kind !== "emm") throw new ValidationError("emm QF needs an emm target");
      const s = emmStatsFromBits(prep, coverWords);
      return [qf.evaluate(s, prep), s.size];
    }
    case "description": {
      // Description-level QFs (GA, combined) evaluate through the cached
      // context (mask path); the size still comes from the bitset cover.
      const size = sizeFromBits(coverWords);
      return [qf.evaluate(state.conj as Conjunction, state.descCtx), size];
    }
  }
}

/** Row-scan path evaluation for the cross-check: [quality, size]. */
function evaluateMask(state: EvaluatorState, depth: number): [number, number] {
  const { task } = state;
  const prep = task.prepared;
  const qf = task.qf;
  const mask =
    state.form === "disjunction"
      ? disjunctionCover(task.table, state.conj!.selectors)
      : conjunctionCover(task.table, state.conj!.selectors);
  switch (qf.kind) {
    case "binary": {
      const s = binaryStatsFromMask(prep as never, mask);
      return [qf.evaluate(s.size, s.positives, prep as never), s.size];
    }
    case "numeric": {
      const s = numericStatsFromMask(prep as never, mask, qf.plan);
      return [qf.evaluate(s, prep as never), s.size];
    }
    case "fi": {
      const size = sizeFromMask(mask);
      return [qf.evaluate({ size, depth }, prep as never), size];
    }
    case "emm": {
      const s = emmStatsFromMask(prep as never, mask);
      return [qf.evaluate(s, prep as never), s.size];
    }
    case "description": {
      // The context itself is mask-based; re-evaluating adds nothing beyond
      // the size cross-check. (Description QFs are conjunction-only; the
      // disjunction form rejects them at task setup.)
      return [qf.evaluate(state.conj as Conjunction, state.descCtx), sizeFromMask(mask)];
    }
  }
}

/**
 * Cross-path quality agreement. Counts are integer-exact; binary/FI/EMM use
 * identical arithmetic on both paths (exact equality); numeric plans differ —
 * the bitset path accumulates `sum` naively in ascending row order (the
 * shared decision arithmetic, BRIEF §7) while the row-scan path uses pairwise
 * summation — by at most ~n·eps on the aggregates (spec §7.2, rel ≤ 1e-12 of
 * the aggregate scale — NOT of the quality, which can be a catastrophically
 * cancelled near-zero).
 */
function qualitiesAgree(a: number, b: number, aggScale: number): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  return Math.abs(a - b) <= 1e-12 * aggScale;
}

/**
 * Run the exhaustive oracle. Returns §3.3's top-k over C(S, depth) plus the
 * cross-check report on the results object (via `crossCheckReport`).
 */
export async function exhaustive(
  taskSpec: SubgroupTask,
  options: ExhaustiveOptions = {},
): Promise<SubgroupResults & { crossCheckReport: CrossCheckReport }> {
  const task = prepareTask(taskSpec);
  const form = options.form ?? "conjunction";
  if (form === "disjunction" && task.qf.kind === "description") {
    throw new ValidationError(
      "exhaustive over the disjunction space does not support description-level QFs " +
        "(generalization semantics are defined over conjunctions; spec §7.11)",
    );
  }
  const nSel = task.selectors.length;
  const total = candidateSpaceSize(nSel, task.depth);
  const fullLimit = options.fullCrossCheckLimit ?? 300_000;
  const mode: "full" | "sampled" | "off" =
    options.crossCheck === undefined || options.crossCheck === "auto"
      ? total <= fullLimit
        ? "full"
        : "sampled"
      : options.crossCheck;
  const batchSize = options.batchSize ?? 8192;

  const topk = new TopK(task.k, task.minQuality);
  // Aggregate scale for the dual-path tolerance: numeric qualities are
  // bounded by n^a·(spread) ≤ n·(max|T| + |centroid|); other targets compare
  // exactly (aggScale 0).
  let aggScale = 0;
  if (task.prepared.kind === "numeric") {
    const prepN = task.prepared;
    const maxAbs = Math.max(Math.abs(prepN.min), Math.abs(prepN.max));
    aggScale = prepN.n * (maxAbs + Math.abs(prepN.mean) + Math.abs(prepN.median) + 1);
  }
  const w = task.atlas.wordsPerRow;
  const descCtx = new CoverEvalContext(task.table, task.prepared);
  const state: EvaluatorState = { task, descCtx, form, conj: null };
  const needConj = task.qf.kind === "description";

  // Per-level AND-prefix scratch covers (level i holds the cover of the
  // current (i+1)-selector prefix).
  const scratch: Uint32Array[] = [];
  for (let i = 0; i < task.depth; i++) scratch.push(new Uint32Array(w));

  const tuple = new Uint16Array(task.depth);
  let evaluated = 0;
  let checked = 0;
  let sinceYield = 0;

  const maybeReport = (layerDepth: number): void => {
    if (task.onProgress) {
      const best = topk.toArray()[0];
      task.onProgress({
        layer: layerDepth,
        candidatesEvaluated: evaluated,
        candidatesPruned: 0,
        bestQuality: topk.bestQuality(),
        bestDescription:
          best === undefined
            ? null
            : tupleDescription(task.selectors, best.tuple, form).toString("display"),
      });
    }
  };

  const buildConj = (depth: number): Conjunction | Disjunction => {
    const selectors: import("../desc/selector.js").Selector[] = [];
    for (let i = 0; i < depth; i++) selectors.push(task.selectors[tuple[i]!]!);
    return form === "disjunction" ? new Disjunction(selectors) : new Conjunction(selectors);
  };

  const processCandidate = (depth: number, coverWords: Uint32Array): void => {
    const doCheck = mode === "full" || (mode === "sampled" && evaluated % 64 === 0);
    state.conj = needConj || doCheck ? buildConj(depth) : null;
    const [quality, size] = evaluateBits(state, coverWords, depth);
    evaluated++;

    if (doCheck) {
      const [maskQuality, maskSize] = evaluateMask(state, depth);
      checked++;
      if (maskSize !== size || !qualitiesAgree(maskQuality, quality, aggScale)) {
        throw new ValidationError(
          `dual-path cross-check failed at ${state.conj!.toString("display")}: ` +
            `bitset (q=${quality}, n=${size}) vs row-scan (q=${maskQuality}, n=${maskSize})`,
        );
      }
    }

    // Constraints gate membership (spec §7.3).
    if (task.minSupportRows > 0 && size < task.minSupportRows) return;
    for (const c of task.constraints) {
      if (!c.isSatisfied({ size })) return;
    }
    topk.add(quality, tuple.subarray(0, depth));
  };

  // Iterative combinations enumeration with AND-prefix covers (spec §7.1).
  let level = 0;
  tuple[0] = 0;
  const idx = new Int32Array(task.depth);
  idx[0] = -1;
  while (level >= 0) {
    idx[level] = idx[level]! + 1;
    const i = idx[level]!;
    if (i > nSel - 1) {
      level--;
      continue;
    }
    tuple[level] = i;
    // cover(level) = cover(level−1) ∘ row(i), ∘ per the space form
    const target = scratch[level]!;
    if (level === 0) {
      target.set(task.atlas.row(i));
    } else if (form === "disjunction") {
      orInto(target, 0, scratch[level - 1]!, 0, task.atlas.bits, task.atlas.offset(i), w);
    } else {
      andInto(target, 0, scratch[level - 1]!, 0, task.atlas.bits, task.atlas.offset(i), w);
    }
    processCandidate(level + 1, target);

    sinceYield++;
    if (sinceYield >= batchSize) {
      sinceYield = 0;
      if (task.signal?.aborted) {
        throw new AbortedError("exhaustive search aborted");
      }
      maybeReport(level + 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    if (level + 1 < task.depth && i < nSel - 1) {
      level++;
      idx[level] = i;
    }
  }
  maybeReport(task.depth);

  // Sampled mode additionally re-verifies every retained result on the
  // row-scan path (spec §7.2).
  if (mode === "sampled") {
    for (const item of topk.toArray()) {
      const depth = item.tuple.length;
      for (let i = 0; i < depth; i++) tuple[i] = item.tuple[i]!;
      state.conj = buildConj(depth);
      const [maskQuality] = evaluateMask(state, depth);
      checked++;
      if (!qualitiesAgree(maskQuality, item.quality, aggScale)) {
        throw new ValidationError(
          `dual-path cross-check failed on retained result ` +
            `${state.conj.toString("display")}: bitset q=${item.quality} vs ` +
            `row-scan q=${maskQuality}`,
        );
      }
    }
  }

  const results = buildResults(task, topk.toArray(), evaluated, 0, form) as SubgroupResults & {
    crossCheckReport: CrossCheckReport;
  };
  results.crossCheckReport = { mode, checked, total: evaluated };
  return results;
}
