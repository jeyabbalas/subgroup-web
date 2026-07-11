/**
 * Search results (BRIEF §5.4): ordered entries with description, quality,
 * full statistics table, optimistic estimate (when the QF defines one), and
 * on-demand covers (recomputed from the atlas — no per-candidate cover
 * storage, BRIEF §9). Serialization + post-filters land in M5.
 */

import { Bitset } from "../bitset/bitset.js";
import { Conjunction } from "../desc/conjunction.js";
import { CoverEvalContext } from "../qf/context.js";
import type { PreparedTask } from "../search/task.js";
import type { TopKItem } from "../search/topk.js";
import { emmStatsFromBits, emmStatsTable } from "../targets/emm.js";
import {
  binaryStatsFromBits,
  binaryStatsTable,
  fiStatsTable,
  gatherValuesFromBits,
  numericStatsTable,
  sizeFromBits,
} from "../targets/stats.js";

export interface ResultEntry {
  readonly description: Conjunction;
  readonly quality: number;
  /** Full statistic table of the task's target (spec §5). */
  readonly stats: Readonly<Record<string, number>>;
  readonly optimisticEstimate?: number;
  /** Row indices covered by the description (ascending). */
  cover(): Uint32Array;
}

export class SubgroupResults {
  readonly entries: readonly ResultEntry[];
  /** Search diagnostics for reports/progress consumers. */
  readonly candidatesEvaluated: number;
  readonly candidatesPruned: number;

  constructor(entries: readonly ResultEntry[], evaluated: number, pruned: number) {
    this.entries = entries;
    this.candidatesEvaluated = evaluated;
    this.candidatesPruned = pruned;
  }

  /** Plain-object rows: quality, description string, then all stats fields. */
  toRows(): Record<string, unknown>[] {
    return this.entries.map((e) => ({
      quality: e.quality,
      description: e.description.toString("display"),
      ...e.stats,
    }));
  }
}

/** Materialize final entries from retained top-k items (shared by engines). */
export function buildResults(
  task: PreparedTask,
  items: readonly TopKItem[],
  evaluated: number,
  pruned: number,
): SubgroupResults {
  const { atlas, prepared, qf } = task;
  const w = atlas.wordsPerRow;
  const descCtx = new CoverEvalContext(task.table, prepared);
  const entries: ResultEntry[] = items.map((item) => {
    const selectors = Array.from(item.tuple, (i) => task.selectors[i]!);
    const description = new Conjunction(selectors);
    const coverWords = new Uint32Array(w);
    atlas.coverInto(Array.from(item.tuple), coverWords);

    let stats: Record<string, number>;
    let oe: number | undefined;
    switch (prepared.kind) {
      case "binary": {
        const s = binaryStatsFromBits(prepared, coverWords);
        stats = binaryStatsTable(prepared, s);
        if (qf.kind === "binary" && qf.optimisticEstimate) {
          oe = qf.optimisticEstimate(s.size, s.positives, prepared);
        }
        break;
      }
      case "numeric": {
        const gathered = gatherValuesFromBits(prepared, coverWords);
        stats = numericStatsTable(prepared, gathered);
        if (qf.kind === "numeric" && qf.optimisticEstimate) {
          oe = descCtx.optimisticEstimate(qf, description);
        }
        break;
      }
      case "fi": {
        stats = fiStatsTable(prepared, {
          size: sizeFromBits(coverWords),
          depth: description.depth,
        });
        if (qf.kind === "fi" && qf.optimisticEstimate) {
          oe = qf.optimisticEstimate({ size: stats.size_sg!, depth: description.depth }, prepared);
        }
        break;
      }
      case "emm": {
        stats = emmStatsTable(prepared, emmStatsFromBits(prepared, coverWords));
        break;
      }
    }
    if (qf.kind === "description" && qf.optimisticEstimate) {
      oe = qf.optimisticEstimate(description, descCtx);
    }

    const entry: ResultEntry = {
      description,
      quality: item.quality,
      stats,
      ...(oe !== undefined ? { optimisticEstimate: oe } : {}),
      cover(): Uint32Array {
        return new Bitset(task.table.nRows, coverWords).toIndices();
      },
    };
    return entry;
  });
  return new SubgroupResults(entries, evaluated, pruned);
}
