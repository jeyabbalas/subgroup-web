/**
 * Best-first search on optimistic estimates (spec §7.4; BRIEF §5.4).
 *
 * Frontier of expandable nodes ordered estimate-descending (ties: depth
 * ascending → tuple lexicographic ascending — a total order, so the pop
 * sequence is deterministic). Expanding a node batch-evaluates all its
 * extensions; every candidate is therefore evaluated exactly once, at its
 * unique (depth−1)-prefix parent. When the QF's estimate is admissible
 * (`pruningSafe`), the search TERMINATES the moment the frontier's best
 * estimate fails §3.4 — every remaining node's estimate is ≤ it (the §3.4
 * predicate is monotone in the estimate), which is best-first's whole
 * advantage. Without an admissible estimate the frontier degrades to a
 * deterministic full traversal (no early stop, no push gating) and exactness
 * is unconditional.
 */

import type { SubgroupResults } from "../results/result.js";
import { type SearchOptions, SearchRun } from "./engine.js";
import { BinaryHeap } from "./heap.js";
import { prepareTask, type SubgroupTask } from "./task.js";

interface BfNode {
  oe: number;
  /** Ascending selector ids (owned copy). */
  tuple: Uint16Array;
}

/** oe desc → depth asc → lex asc; total order (tuples are unique). */
function compareNodes(a: BfNode, b: BfNode): number {
  if (a.oe !== b.oe) return a.oe > b.oe ? -1 : 1;
  if (a.tuple.length !== b.tuple.length) return a.tuple.length - b.tuple.length;
  for (let i = 0; i < a.tuple.length; i++) {
    const d = a.tuple[i]! - b.tuple[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

export async function bestFirst(
  taskSpec: SubgroupTask,
  options: SearchOptions = {},
): Promise<SubgroupResults> {
  const task = prepareTask(taskSpec);
  const run = new SearchRun(task, options);
  const nSel = task.selectors.length;
  const w = task.atlas.wordsPerRow;
  const frontier = new BinaryHeap<BfNode>(compareNodes);
  const coverScratch = new Uint32Array(w);
  const tupleScratch = new Uint16Array(task.depth);

  /**
   * Evaluate all extensions of `prefix` (ids > its last, or all ids for the
   * empty prefix), add them to the top-k, and push expandable children.
   */
  const expand = async (prefix: Uint16Array | null): Promise<void> => {
    const prefixLen = prefix === null ? 0 : prefix.length;
    const extStart = prefix === null ? 0 : prefix[prefixLen - 1]! + 1;
    const extCount = nSel - extStart;
    if (extCount <= 0) return;
    let parent: Uint32Array | null = null;
    if (prefix !== null) {
      task.atlas.coverInto(Array.from(prefix), coverScratch);
      parent = coverScratch;
    }
    const childDepth = prefixLen + 1;
    const children = new Uint16Array(extCount);
    for (let j = 0; j < extCount; j++) children[j] = extStart + j;
    const expandable = childDepth < task.depth;
    const needOe = run.canPrune && expandable;

    for (let start = 0; start < extCount; start += run.batchSize) {
      const bCount = Math.min(run.batchSize, extCount - start);
      const batch = await run.evaluator.evaluateExtensions(
        parent,
        children.subarray(start, start + bCount),
      );
      const quality = new Float64Array(bCount);
      const oe = needOe ? new Float64Array(bCount) : null;
      run.scorer.scoreBatch(
        batch,
        childDepth,
        (i) => {
          for (let d = 0; d < prefixLen; d++) tupleScratch[d] = prefix![d]!;
          tupleScratch[prefixLen] = children[start + i]!;
          return tupleScratch.subarray(0, childDepth);
        },
        quality,
        oe,
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
          const monoOk = run.constraintPrune ? run.monotoneOk(batch.size[i]!) : true;
          const childOe = oe ? oe[i]! : Number.POSITIVE_INFINITY;
          if (monoOk && !(run.canPrune && run.topk.shouldPrune(childOe))) {
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
    if (run.canPrune && run.topk.shouldPrune(node.oe)) {
      // Frontier is estimate-sorted: every remaining subtree is prunable.
      run.pruned += frontier.size + 1;
      break;
    }
    await expand(node.tuple);
  }

  run.report(task.depth);
  return run.finish();
}
