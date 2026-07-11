/**
 * Single-thread CPU BatchEvaluator (BRIEF §11): word-wise AND over the
 * selector-bitset atlas into reusable scratch, statistics via the SAME
 * kernels the exhaustive oracle's bitset path uses
 * (src/targets/stats.ts / emm.ts) — qualities computed from these stats are
 * bit-identical to the oracle's by construction.
 *
 * Tuple batches reuse AND-prefixes across consecutive candidates (apriori
 * emits levels in lexicographic tuple order, so ℓ−1 of ℓ words-per-row ANDs
 * are usually shared). Covers are never stored per candidate — one scratch
 * row per prefix depth (BRIEF §9, §22-A12: recompute over cache at depth ≤ 3;
 * measured against caching in M6, see docs/design.md).
 *
 * FUSED final level (the P1 hot path): for binary/FI targets and numeric
 * sum-family plans, the deepest AND (and the whole of extension batches) is
 * fused with counting/summing — the final cover is never written. Counts are
 * integers (order-free); the fused numeric kernel visits rows in the same
 * ascending order as the materialized path, so all statistics stay
 * bit-identical (the §6.1 dual-path crosscheck and §6.2 gates verify).
 */

import type { SelectorAtlas } from "../../bitset/atlas.js";
import { andCount, andInto, fusedBinaryCounts, orCount, orInto } from "../../bitset/bitset.js";
import { emmStatsFromBits } from "../../targets/emm.js";
import type { NumericStatsPlan } from "../../targets/stats.js";
import {
  binaryStatsFromBits,
  numericStatsFromBits,
  numericStatsFromCombinedBits,
  sizeFromBits,
} from "../../targets/stats.js";
import type { PreparedTarget } from "../../targets/types.js";
import type { BatchEvaluator, StatsBatch } from "../types.js";

export function allocBatch(
  count: number,
  prepared: PreparedTarget,
  plan: NumericStatsPlan | null,
): StatsBatch {
  const numeric = prepared.kind === "numeric";
  const emm = prepared.kind === "emm";
  return {
    count,
    size: new Uint32Array(count),
    positives: prepared.kind === "binary" ? new Uint32Array(count) : null,
    sum: numeric ? new Float64Array(count) : null,
    excessSum: numeric && plan?.needExcess ? new Float64Array(count) : null,
    tailCount: numeric && plan?.needTail ? new Uint32Array(count) : null,
    tailExtreme: numeric && plan?.needTail ? new Float64Array(count) : null,
    median: numeric && plan?.needMedian ? new Float64Array(count) : null,
    std: numeric && plan?.needStd ? new Float64Array(count) : null,
    orderEstimate: numeric && plan?.needOrder ? new Float64Array(count) : null,
    emmSlope: emm ? new Float64Array(count) : null,
    emmIntercept: emm ? new Float64Array(count) : null,
    emmSgLikelihood: emm ? new Float64Array(count) : null,
    emmComplementLikelihood: emm ? new Float64Array(count) : null,
  };
}

type FusedKind = "binary" | "fi" | "numeric" | null;

export class CpuEvaluator implements BatchEvaluator {
  readonly name = "cpu";
  readonly screening = false;
  private readonly atlas: SelectorAtlas;
  private readonly prepared: PreparedTarget;
  private readonly plan: NumericStatsPlan | null;
  /** Non-null: final-level evaluation fuses AND/OR with statistics. */
  private readonly fused: FusedKind;
  /** Per-depth prefix covers for tuple batches + one extension scratch. */
  private readonly prefixScratch: Uint32Array[] = [];
  private readonly extScratch: Uint32Array;
  private readonly countsScratch = new Uint32Array(2);

  constructor(atlas: SelectorAtlas, prepared: PreparedTarget, plan: NumericStatsPlan | null) {
    this.atlas = atlas;
    this.prepared = prepared;
    this.plan = plan;
    this.extScratch = new Uint32Array(atlas.wordsPerRow);
    switch (prepared.kind) {
      case "binary":
        this.fused = "binary";
        break;
      case "fi":
        this.fused = "fi";
        break;
      case "numeric":
        this.fused =
          plan !== null && !plan.needMedian && !plan.needOrder && !plan.needStd ? "numeric" : null;
        break;
      default:
        this.fused = null;
    }
  }

  private statsInto(batch: StatsBatch, i: number, cover: Uint32Array): void {
    const prepared = this.prepared;
    switch (prepared.kind) {
      case "binary": {
        const s = binaryStatsFromBits(prepared, cover);
        batch.size[i] = s.size;
        batch.positives![i] = s.positives;
        break;
      }
      case "numeric": {
        const s = numericStatsFromBits(prepared, cover, this.plan!);
        batch.size[i] = s.size;
        batch.sum![i] = s.sum;
        if (batch.excessSum) batch.excessSum[i] = s.excessSum;
        if (batch.tailCount) {
          batch.tailCount[i] = s.tailCount;
          batch.tailExtreme![i] = s.tailExtreme;
        }
        if (batch.median) batch.median[i] = s.median;
        if (batch.std) batch.std[i] = s.std;
        if (batch.orderEstimate) batch.orderEstimate[i] = s.orderEstimate;
        break;
      }
      case "fi":
        batch.size[i] = sizeFromBits(cover);
        break;
      case "emm": {
        const s = emmStatsFromBits(prepared, cover);
        batch.size[i] = s.size;
        batch.emmSlope![i] = s.slope;
        batch.emmIntercept![i] = s.intercept;
        batch.emmSgLikelihood![i] = s.sgLikelihood;
        batch.emmComplementLikelihood![i] = s.complementLikelihood;
        break;
      }
    }
  }

  /** Fused final-level statistics: cover = prefix op row(id), never stored. */
  private fusedStatsInto(
    batch: StatsBatch,
    i: number,
    prefix: Uint32Array | null,
    prefixOff: number,
    id: number,
    op: "and" | "or",
  ): void {
    const atlas = this.atlas;
    const w = atlas.wordsPerRow;
    const rowOff = atlas.offset(id);
    switch (this.fused) {
      case "binary": {
        const prep = this.prepared as Extract<PreparedTarget, { kind: "binary" }>;
        fusedBinaryCounts(
          this.countsScratch,
          prefix,
          prefixOff,
          atlas.bits,
          rowOff,
          prep.positivesBits,
          0,
          w,
          op,
        );
        batch.size[i] = this.countsScratch[0]!;
        batch.positives![i] = this.countsScratch[1]!;
        break;
      }
      case "fi": {
        batch.size[i] =
          prefix === null
            ? andCount(atlas.bits, rowOff, atlas.bits, rowOff, w)
            : op === "and"
              ? andCount(prefix, prefixOff, atlas.bits, rowOff, w)
              : orCount(prefix, prefixOff, atlas.bits, rowOff, w);
        break;
      }
      case "numeric": {
        const prep = this.prepared as Extract<PreparedTarget, { kind: "numeric" }>;
        const s = numericStatsFromCombinedBits(
          prep,
          this.plan!,
          prefix,
          prefixOff,
          atlas.bits,
          rowOff,
          w,
          op,
        );
        batch.size[i] = s.size;
        batch.sum![i] = s.sum;
        if (batch.excessSum) batch.excessSum[i] = s.excessSum;
        if (batch.tailCount) {
          batch.tailCount[i] = s.tailCount;
          batch.tailExtreme![i] = s.tailExtreme;
        }
        break;
      }
      case null:
        throw new Error("fusedStatsInto called without a fused kind");
    }
  }

  /**
   * Statistics of ONE explicit cover (the §12 exactness-band re-scoring
   * path, and generalizingBFS OR-tuple re-scores). Identical kernels to the
   * batch paths — the resulting quality is bit-identical to a pure-CPU run.
   */
  evaluateCover(cover: Uint32Array): StatsBatch {
    const batch = allocBatch(1, this.prepared, this.plan);
    this.statsInto(batch, 0, cover);
    return batch;
  }

  evaluateTuples(tuples: Uint16Array, arity: number, count: number): StatsBatch {
    const atlas = this.atlas;
    const w = atlas.wordsPerRow;
    while (this.prefixScratch.length < arity) {
      this.prefixScratch.push(new Uint32Array(w));
    }
    const scratch = this.prefixScratch;
    const batch = allocBatch(count, this.prepared, this.plan);
    const fused = this.fused !== null;
    // Depths that must be materialized as prefixes: all but the last when
    // the final level is fused.
    const prefixDepth = fused ? arity - 1 : arity;
    // prev[d] = selector id at depth d of the previous tuple (for prefix reuse)
    let prevValid = 0;
    const prev = new Int32Array(arity).fill(-1);
    for (let c = 0; c < count; c++) {
      const base = c * arity;
      // Longest shared materialized prefix with the previous tuple.
      let shared = 0;
      while (shared < prevValid && tuples[base + shared] === prev[shared]) shared++;
      for (let d = shared; d < prefixDepth; d++) {
        const id = tuples[base + d]!;
        const dst = scratch[d]!;
        if (d === 0) {
          dst.set(atlas.row(id));
        } else {
          andInto(dst, 0, scratch[d - 1]!, 0, atlas.bits, atlas.offset(id), w);
        }
        prev[d] = id;
      }
      prevValid = prefixDepth;
      if (fused) {
        const prefix = arity === 1 ? null : scratch[arity - 2]!;
        this.fusedStatsInto(batch, c, prefix, 0, tuples[base + arity - 1]!, "and");
      } else {
        this.statsInto(batch, c, scratch[arity - 1]!);
      }
    }
    return batch;
  }

  evaluateExtensions(
    parent: Uint32Array | null,
    extensions: ArrayLike<number>,
    op: "and" | "or" = "and",
  ): StatsBatch {
    const atlas = this.atlas;
    const w = atlas.wordsPerRow;
    const count = extensions.length;
    const batch = allocBatch(count, this.prepared, this.plan);
    if (this.fused !== null) {
      // Fused: candidate stats straight from parent op row — no cover write.
      // parent = null means cover = row alone under BOTH ops (∧ with the
      // full table, ∨ with the empty set).
      for (let j = 0; j < count; j++) {
        this.fusedStatsInto(batch, j, parent, 0, extensions[j] as number, op);
      }
      return batch;
    }
    const dst = this.extScratch;
    for (let j = 0; j < count; j++) {
      const id = extensions[j] as number;
      if (parent === null) {
        dst.set(atlas.row(id));
      } else if (op === "and") {
        andInto(dst, 0, parent, 0, atlas.bits, atlas.offset(id), w);
      } else {
        orInto(dst, 0, parent, 0, atlas.bits, atlas.offset(id), w);
      }
      this.statsInto(batch, j, dst);
    }
    return batch;
  }

  dispose(): void {
    // Nothing pooled on the single-thread path.
  }
}
