/**
 * Shared matrix-cell → task materialization for the exactness and
 * differential runners (BRIEF §6.4). Cell specs use the same JSON shape as
 * test/matrix.json so cells can move freely between the exactness-only list
 * and the reference-fixture matrix.
 */
import {
  allSelectors,
  type Constraint,
  minSupport,
  negated,
  nominalSelectors,
  type QF,
  type Selector,
  type SubgroupTask,
  type Target,
} from "../../src/index.js";
import { loadDataset } from "./datasets.js";
import { makeQF, makeTarget, type QfSpec, type TargetSpec } from "./qf.js";

export interface SpaceSpec {
  ignore?: string[];
  nbins?: number;
  intervalsOnly?: boolean;
  negations?: boolean;
  nominalOnly?: boolean;
}

export interface ConstraintSpec {
  type: "minSupport";
  count: number;
}

export interface CellSpec {
  id: string;
  dataset: string;
  target: TargetSpec;
  space: SpaceSpec;
  qf: QfSpec;
  algorithm?: string;
  depth: number;
  k: number;
  minQuality?: number;
  constraints?: ConstraintSpec[];
}

export function buildSpace(table: ReturnType<typeof loadDataset>, spec: SpaceSpec): Selector[] {
  const base = spec.nominalOnly
    ? nominalSelectors(table, { ignore: spec.ignore ?? [] })
    : allSelectors(table, {
        ignore: spec.ignore ?? [],
        bins: spec.nbins ?? 5,
        intervalsOnly: spec.intervalsOnly ?? true,
      });
  return spec.negations ? [...base, ...base.map((s) => negated(s))] : base;
}

export function buildConstraints(specs: readonly ConstraintSpec[] | undefined): Constraint[] {
  return (specs ?? []).map((c) => minSupport(c.count));
}

/** Materialize a cell as a ready-to-run SubgroupTask (fresh per call). */
export function buildTask(cell: CellSpec): SubgroupTask & { target: Target; qf: QF } {
  const table = loadDataset(cell.dataset);
  return {
    table,
    target: makeTarget(cell.target),
    searchSpace: buildSpace(table, cell.space),
    qf: makeQF(cell.qf, cell.depth),
    resultSetSize: cell.k,
    depth: cell.depth,
    minQuality: cell.minQuality ?? Number.NEGATIVE_INFINITY,
    constraints: buildConstraints(cell.constraints),
  };
}
