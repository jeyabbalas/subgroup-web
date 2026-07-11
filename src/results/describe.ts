/**
 * Ad-hoc description statistics (BRIEF §5.2: Conjunction / Disjunction / DNF
 * are "evaluable and stat-computable like the reference's
 * subgroup_description module"): the full §5 stats table of the task
 * target for ANY cover-bearing description, via the row-scan path.
 */

import type { DataTable } from "../table/table.js";
import { emmStatsFromMask, emmStatsTable } from "../targets/emm.js";
import { prepareTarget } from "../targets/prepare.js";
import {
  binaryStatsFromMask,
  binaryStatsTable,
  fiStatsTable,
  gatherValuesFromMask,
  numericStatsTable,
  sizeFromMask,
} from "../targets/stats.js";
import type { Target } from "../targets/types.js";

export interface CoverDescription {
  covers(table: DataTable): Uint8Array;
  readonly depth?: number;
}

/** Stats table for any description (Conjunction, Disjunction, DNF, custom). */
export function describeStats(
  table: DataTable,
  target: Target,
  description: CoverDescription,
): Record<string, number> {
  const prepared = prepareTarget(table, target);
  const mask = description.covers(table);
  switch (prepared.kind) {
    case "binary":
      return binaryStatsTable(prepared, binaryStatsFromMask(prepared, mask));
    case "numeric":
      return numericStatsTable(prepared, gatherValuesFromMask(prepared, mask));
    case "fi":
      return fiStatsTable(prepared, { size: sizeFromMask(mask), depth: description.depth ?? 0 });
    case "emm":
      return emmStatsTable(prepared, emmStatsFromMask(prepared, mask));
  }
}
