/**
 * generalizingBFS (spec §7.11) — exact top-k over the DISJUNCTION space
 * D(S, d) = { disjunctions of 1..depth distinct selectors }, the
 * generalization counterpart of §3.1 (the reference's GeneralisingBFS
 * explores Disjunctions via StaticGeneralizationOperator,
 * algorithms.py:424-489).
 *
 * The reference implementation is experimental (`pragma: no cover`): it
 * prunes with the SUBSET-cover optimistic estimate divided by a 1.1^depth
 * fudge — inadmissible over cover-GROWING refinements in both directions —
 * and prints diagnostics. subgroup-web replaces it with a best-first walk
 * pruned by the qf's `generalizationEstimate` (reference
 * `optimistic_generalisation`: grow the cover by every remaining positive),
 * proven admissible for cover-growing refinements when
 * `generalizationPruningSafe` (standard(a), a ∈ [0,1]; spec §7.11 proof) —
 * exactness holds unconditionally, pruning engages only when safe.
 *
 * Structure mirrors §7.7 bestFirst with two deliberate differences:
 * - covers are OR-chains (child cover = parent ∨ row(s));
 * - monotone-constraint subtree pruning is DISABLED even when pruning is on:
 *   `isMonotone` is defined over conjunction refinement (shrinking covers);
 *   under disjunction refinement sizes grow, so a minSupport violator's
 *   refinements may satisfy it. Constraints still gate membership (§3.3).
 *
 * Description-level QFs (GA, combined) are rejected: their generalization
 * semantics are defined over conjunctions.
 */

import { orInto } from "../bitset/bitset.js";
import { ValidationError } from "../errors.js";
import { buildResults, type SubgroupResults } from "../results/result.js";
import { type SearchOptions, SearchRun } from "./engine.js";
import { BinaryHeap } from "./heap.js";
import { prepareTask, type SubgroupTask } from "./task.js";

interface GbfsNode {
  oe: number;
  tuple: Uint16Array;
}

/** oe desc → depth asc → lex asc (total order over unique tuples). */
function compareNodes(a: GbfsNode, b: GbfsNode): number {
  if (a.oe !== b.oe) return a.oe > b.oe ? -1 : 1;
  if (a.tuple.length !== b.tuple.length) return a.tuple.length - b.tuple.length;
  for (let i = 0; i < a.tuple.length; i++) {
    const d = a.tuple[i]! - b.tuple[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

export async function generalizingBFS(
  taskSpec: SubgroupTask,
  options: SearchOptions = {},
): Promise<SubgroupResults> {
  const task = prepareTask(taskSpec);
  const qf = task.qf;
  if (qf.kind === "description") {
    throw new ValidationError(
      "generalizingBFS explores disjunctions; description-level QFs (generalization-aware, " +
        "combined) are defined over conjunctions — use apriori()/dfs() (spec §7.11)",
    );
  }
  const run = new SearchRun(task, options);
  const nSel = task.selectors.length;
  const w = task.atlas.wordsPerRow;
  const prep = task.prepared;
  const canPrune =
    options.pruning !== false &&
    qf.kind === "binary" &&
    qf.generalizationEstimate !== undefined &&
    qf.generalizationPruningSafe === true;

  const frontier = new BinaryHeap<GbfsNode>(compareNodes);
  const coverScratch = new Uint32Array(w);
  const tupleScratch = new Uint16Array(task.depth);

  const orCoverInto = (tuple: ArrayLike<number>, dst: Uint32Array): void => {
    dst.fill(0);
    for (let i = 0; i < tuple.length; i++) {
      orInto(dst, 0, dst, 0, task.atlas.bits, task.atlas.offset(tuple[i] as number), w);
    }
  };

  const expand = async (prefix: Uint16Array | null): Promise<void> => {
    const prefixLen = prefix === null ? 0 : prefix.length;
    const extStart = prefix === null ? 0 : prefix[prefixLen - 1]! + 1;
    const extCount = nSel - extStart;
    if (extCount <= 0) return;
    let parent: Uint32Array | null = null;
    if (prefix !== null) {
      orCoverInto(prefix, coverScratch);
      parent = coverScratch;
    }
    const childDepth = prefixLen + 1;
    const children = new Uint16Array(extCount);
    for (let j = 0; j < extCount; j++) children[j] = extStart + j;
    const expandable = childDepth < task.depth;

    for (let start = 0; start < extCount; start += run.batchSize) {
      const bCount = Math.min(run.batchSize, extCount - start);
      const batch = await run.evaluator.evaluateExtensions(
        parent,
        children.subarray(start, start + bCount),
        "or",
      );
      const quality = new Float64Array(bCount);
      run.scorer.scoreBatch(
        batch,
        childDepth,
        (i) => {
          for (let d = 0; d < prefixLen; d++) tupleScratch[d] = prefix![d]!;
          tupleScratch[prefixLen] = children[start + i]!;
          return tupleScratch.subarray(0, childDepth);
        },
        quality,
        null,
      );
      for (let i = 0; i < bCount; i++) {
        const id = children[start + i]!;
        for (let d = 0; d < prefixLen; d++) tupleScratch[d] = prefix![d]!;
        tupleScratch[prefixLen] = id;
        const tuple = tupleScratch.subarray(0, childDepth);
        if (run.membershipOk(batch.size[i]!)) {
          run.topk.add(quality[i]!, tuple);
        }
        if (expandable && id < nSel - 1) {
          let childOe = Number.POSITIVE_INFINITY;
          if (canPrune && qf.kind === "binary" && prep.kind === "binary") {
            childOe = qf.generalizationEstimate!(batch.size[i]!, batch.positives![i]!, prep);
          }
          if (!(canPrune && run.topk.shouldPrune(childOe))) {
            frontier.push({ oe: childOe, tuple: Uint16Array.from(tuple) });
          } else {
            run.pruned++;
          }
        }
      }
      await run.tick(bCount, childDepth);
    }
  };

  await expand(null);
  for (;;) {
    const node = frontier.pop();
    if (node === undefined) break;
    if (canPrune && run.topk.shouldPrune(node.oe)) {
      run.pruned += frontier.size + 1;
      break;
    }
    await expand(node.tuple);
  }

  run.report(task.depth);
  run.evaluator.dispose();
  return buildResults(task, run.topk.toArray(), run.evaluated, run.pruned, "disjunction");
}
