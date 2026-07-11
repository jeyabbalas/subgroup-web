/**
 * dfsNumeric (spec §7.9; BRIEF §22-A5) — the reference's DFSNumeric role:
 * DFS specialized to the standardNumeric(a) mean-centroid family, pruning
 * with the ORDER estimate (spec §6.3: sort the cover's working values
 * descending, oe = max_j j^a·(mean of top j − μ0)) regardless of the QF's
 * configured estimator — exactly what DFSNumeric's per-node cumulative-mean
 * scan computes (algorithms.py:773-871).
 *
 * Applicability (typed error otherwise, mirroring the reference's
 * RuntimeError): the task QF must be standardNumeric(a) (mean centroid;
 * `invert` supported through the working-value direction). Estimate pruning
 * additionally requires a ≥ 0 (spec §6.3 admissibility of the order bound);
 * for a < 0 the walk still runs, un-pruned and exact.
 *
 * Divergences from the reference, both adjudicated: the reference admits the
 * empty conjunction as a candidate (ADJ-002 — our space §3.1 excludes it)
 * and skips size-0 subtrees pre-membership (harmless there: every
 * refinement of an empty cover is empty, quality NaN — we keep the plain
 * §7.6 walk so pruning-off runs still enumerate the full space).
 *
 * Quality values are bit-identical to every other engine: the order plan's
 * gather path computes `sum` with the shared streaming ascending-row
 * accumulation, and evaluation goes through the very same qf.evaluate.
 */

import { ValidationError } from "../errors.js";
import type { NumericQF } from "../qf/types.js";
import type { SubgroupResults } from "../results/result.js";
import type { NumericStatsPlan } from "../targets/stats.js";
import { dfs } from "./dfs.js";
import type { SearchOptions } from "./engine.js";
import type { SubgroupTask } from "./task.js";

export async function dfsNumeric(
  taskSpec: SubgroupTask,
  options: SearchOptions = {},
): Promise<SubgroupResults> {
  const qf = taskSpec.qf;
  if (qf.kind !== "numeric" || qf.standard === undefined) {
    throw new ValidationError(
      `dfsNumeric requires the standardNumeric(a) quality-function family ` +
        `(got ${qf.kind === "numeric" ? qf.name : qf.kind}); use dfs() or apriori() ` +
        `for other quality functions`,
    );
  }
  const { a, dir } = qf.standard;
  const orderPlan: NumericStatsPlan = {
    centroid: "mean",
    direction: dir,
    needStd: false,
    needMedian: false,
    needExcess: false,
    needTail: false,
    needOrder: true,
    orderA: a,
  };
  const orderQF: NumericQF = {
    kind: "numeric",
    name: `${qf.name}@dfsNumeric`,
    plan: orderPlan,
    standard: qf.standard,
    pruningSafe: a >= 0,
    evaluate: qf.evaluate,
    optimisticEstimate(s) {
      return s.size === 0 ? 0 : s.orderEstimate;
    },
  };
  return dfs({ ...taskSpec, qf: orderQF }, options);
}
