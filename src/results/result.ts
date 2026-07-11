/**
 * Search results (BRIEF §5.4): ordered entries with description, quality,
 * full statistics table, optimistic estimate (when the QF defines one), and
 * on-demand covers (recomputed from the atlas — no per-candidate cover
 * storage, BRIEF §9). Serialization + post-filters land in M5.
 */

import { Bitset, orInto, wordsFor } from "../bitset/bitset.js";
import { Conjunction, Disjunction } from "../desc/conjunction.js";
import { CoverEvalContext } from "../qf/context.js";
import type { PreparedTask } from "../search/task.js";
import type { TopKItem } from "../search/topk.js";
import { emmStatsFromBits, emmStatsTable } from "../targets/emm.js";
import {
  binaryStatsFromBits,
  binaryStatsTable,
  fiStatsTable,
  gatherValuesFromBits,
  numericStatsFromBits,
  numericStatsTable,
  sizeFromBits,
} from "../targets/stats.js";

/** Search descriptions: conjunctions everywhere except generalizingBFS. */
export type Description = Conjunction | Disjunction;

export type DescriptionForm = "conjunction" | "disjunction";

export interface ResultEntry {
  readonly description: Description;
  readonly quality: number;
  /** Full statistic table of the task's target (spec §5). */
  readonly stats: Readonly<Record<string, number>>;
  readonly optimisticEstimate?: number;
  /** Row indices covered by the description (ascending). */
  cover(): Uint32Array;
}

/** Which backend evaluated the run, plus §12 band diagnostics (BRIEF §12). */
export interface ResultBackendInfo {
  readonly name: string;
  readonly note: string | null;
  readonly band: { readonly screened: number; readonly rescored: number } | null;
}

export class SubgroupResults {
  readonly entries: readonly ResultEntry[];
  /** Search diagnostics for reports/progress consumers. */
  readonly candidatesEvaluated: number;
  readonly candidatesPruned: number;
  /** Present on runs through the optimized engines (null on the oracle). */
  readonly backend: ResultBackendInfo | null;

  constructor(
    entries: readonly ResultEntry[],
    evaluated: number,
    pruned: number,
    backend: ResultBackendInfo | null = null,
  ) {
    this.entries = entries;
    this.candidatesEvaluated = evaluated;
    this.candidatesPruned = pruned;
    this.backend = backend;
  }

  /** Plain-object rows: quality, description string, then all stats fields. */
  toRows(): Record<string, unknown>[] {
    return this.entries.map((e) => ({
      quality: e.quality,
      description: e.description.toString("display"),
      ...e.stats,
    }));
  }

  /** RFC-4180 CSV of `toRows()` (quality, description, stats columns). */
  toCSV(): string {
    const rows = this.toRows();
    const columns = rows.length > 0 ? Object.keys(rows[0]!) : ["quality", "description"];
    const escapeField = (v: unknown): string => {
      const s = String(v);
      return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
    };
    const lines = [columns.map(escapeField).join(",")];
    for (const row of rows) {
      lines.push(columns.map((c) => escapeField(row[c])).join(","));
    }
    return `${lines.join("\n")}\n`;
  }
}

/**
 * Materialize final entries from retained top-k items (shared by engines).
 *
 * Covers are computed LAZILY: binary/FI items admitted with `aux` statistics
 * (TopKItem.aux) produce their statistic tables without ever touching the
 * atlas — the GPU codes-mode fast path never builds CPU bitsets at all
 * (BRIEF §8 P2, §12). `cover()` still materializes on demand.
 */
export function buildResults(
  task: PreparedTask,
  items: readonly TopKItem[],
  evaluated: number,
  pruned: number,
  form: DescriptionForm = "conjunction",
  backend: ResultBackendInfo | null = null,
): SubgroupResults {
  const { prepared, qf } = task;
  const w = wordsFor(task.table.nRows);
  const descCtx = new CoverEvalContext(task.table, prepared);
  const entries: ResultEntry[] = items.map((item) => {
    const selectors = Array.from(item.tuple, (i) => task.selectors[i]!);
    const description: Description =
      form === "disjunction" ? new Disjunction(selectors) : new Conjunction(selectors);
    let coverWords: Uint32Array | null = null;
    const ensureCover = (): Uint32Array => {
      if (coverWords === null) {
        const atlas = task.atlas; // lazy build on first touch
        coverWords = new Uint32Array(w);
        if (form === "disjunction") {
          for (const i of item.tuple) {
            orInto(coverWords, 0, coverWords, 0, atlas.bits, atlas.offset(i), w);
          }
        } else {
          atlas.coverInto(Array.from(item.tuple), coverWords);
        }
      }
      return coverWords;
    };

    let stats: Record<string, number>;
    let oe: number | undefined;
    switch (prepared.kind) {
      case "binary": {
        const s =
          item.aux !== undefined && item.aux.positives !== undefined
            ? { size: item.aux.size, positives: item.aux.positives }
            : binaryStatsFromBits(prepared, ensureCover());
        stats = binaryStatsTable(prepared, s);
        if (qf.kind === "binary" && qf.optimisticEstimate) {
          oe = qf.optimisticEstimate(s.size, s.positives, prepared);
        }
        break;
      }
      case "numeric": {
        const gathered = gatherValuesFromBits(prepared, ensureCover());
        stats = numericStatsTable(prepared, gathered);
        if (qf.kind === "numeric" && qf.optimisticEstimate) {
          oe = qf.optimisticEstimate(
            numericStatsFromBits(prepared, ensureCover(), qf.plan),
            prepared,
          );
        }
        break;
      }
      case "fi": {
        const size = item.aux !== undefined ? item.aux.size : sizeFromBits(ensureCover());
        stats = fiStatsTable(prepared, { size, depth: description.depth });
        if (qf.kind === "fi" && qf.optimisticEstimate) {
          oe = qf.optimisticEstimate({ size, depth: description.depth }, prepared);
        }
        break;
      }
      case "emm": {
        stats = emmStatsTable(prepared, emmStatsFromBits(prepared, ensureCover()));
        break;
      }
    }
    if (qf.kind === "description" && qf.optimisticEstimate && description instanceof Conjunction) {
      oe = qf.optimisticEstimate(description, descCtx);
    }

    const entry: ResultEntry = {
      description,
      quality: item.quality,
      stats,
      ...(oe !== undefined ? { optimisticEstimate: oe } : {}),
      cover(): Uint32Array {
        return new Bitset(task.table.nRows, ensureCover()).toIndices();
      },
    };
    return entry;
  });
  return new SubgroupResults(entries, evaluated, pruned, backend);
}
