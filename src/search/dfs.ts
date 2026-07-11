/**
 * DFS with bitset look-ahead (spec §7.4; BRIEF §5.4).
 *
 * Depth-first over the canonical prefix tree of C(S, d) in ascending
 * selector-id order. At each node ALL extensions are evaluated in one batch
 * against the node's cover (the look-ahead: children statistics — and their
 * top-k membership — land before any recursion), then the walk descends only
 * into children whose subtree survives §3.4 (estimate pruning when
 * `qf.pruningSafe`) and the monotone constraints. Covers live in one scratch
 * row per depth — recomputed AND-chains, never stored per candidate
 * (BRIEF §9/§22-A12).
 *
 * Depth-first order fills the top-k early, so θ_now is tight long before the
 * shallow layers finish — the classic argument for DFS pruning.
 */

import { andInto } from "../bitset/bitset.js";
import type { SubgroupResults } from "../results/result.js";
import { type SearchOptions, SearchRun } from "./engine.js";
import { type PreparedTask, prepareTask, type SubgroupTask } from "./task.js";

interface DfsFrame {
  /** Depth of this frame's children (= prefix length + 1). */
  childDepth: number;
  /** Extension ids evaluated at this node (ascending). */
  children: Uint16Array;
  quality: Float64Array;
  oe: Float64Array | null;
  sizes: Uint32Array;
  /** Next child index to consider for descent. */
  next: number;
}

export async function dfs(
  taskSpec: SubgroupTask,
  options: SearchOptions = {},
): Promise<SubgroupResults> {
  const task = prepareTask(taskSpec);
  const run = await SearchRun.create(task, options);
  try {
    return await dfsRun(task, run);
  } finally {
    run.dispose();
  }
}

async function dfsRun(task: PreparedTask, run: SearchRun): Promise<SubgroupResults> {
  const nSel = task.selectors.length;
  const w = task.atlas.wordsPerRow;

  // path[s] = selector id chosen at stack level s; covers[s] = its cover.
  const path = new Uint16Array(task.depth);
  const covers: Uint32Array[] = [];
  for (let s = 0; s < task.depth; s++) covers.push(new Uint32Array(w));
  const tupleScratch = new Uint16Array(task.depth);

  /** Evaluate all extensions of the prefix path[0..prefixLen); add to top-k. */
  const expand = async (prefixLen: number, extStart: number): Promise<DfsFrame | null> => {
    const extCount = nSel - extStart;
    if (extCount <= 0) return null;
    const children = new Uint16Array(extCount);
    for (let j = 0; j < extCount; j++) children[j] = extStart + j;
    const childDepth = prefixLen + 1;
    const parent = prefixLen === 0 ? null : covers[prefixLen - 1]!;
    const quality = new Float64Array(extCount);
    const needOe = run.canPrune && childDepth < task.depth;
    const oe = needOe ? new Float64Array(extCount) : null;
    const sizes = new Uint32Array(extCount);

    for (let start = 0; start < extCount; start += run.batchSize) {
      const bCount = Math.min(run.batchSize, extCount - start);
      const batch = await run.evaluator.evaluateExtensions(
        parent,
        children.subarray(start, start + bCount),
      );
      run.scorer.scoreBatch(
        batch,
        childDepth,
        (i) => {
          for (let d = 0; d < prefixLen; d++) tupleScratch[d] = path[d]!;
          tupleScratch[prefixLen] = children[start + i]!;
          return tupleScratch.subarray(0, childDepth);
        },
        quality.subarray(start, start + bCount),
        oe ? oe.subarray(start, start + bCount) : null,
      );
      sizes.set(batch.size, start);
      for (let i = 0; i < bCount; i++) {
        const gi = start + i;
        if (run.membershipOk(sizes[gi]!)) {
          for (let d = 0; d < prefixLen; d++) tupleScratch[d] = path[d]!;
          tupleScratch[prefixLen] = children[gi]!;
          run.admit(quality[gi]!, tupleScratch.subarray(0, childDepth), run.auxFor(batch, i));
        }
      }
      await run.tick(bCount, childDepth);
    }
    return { childDepth, children, quality, oe, sizes, next: 0 };
  };

  const root = await expand(0, 0);
  const stack: DfsFrame[] = root ? [root] : [];

  while (stack.length > 0) {
    const f = stack[stack.length - 1]!;
    if (f.childDepth >= task.depth || f.next >= f.children.length) {
      stack.pop();
      continue;
    }
    const j = f.next++;
    const id = f.children[j]!;
    if (id === nSel - 1) continue; // no extensions beyond the last selector

    const monoOk = run.constraintPrune ? run.monotoneOk(f.sizes[j]!) : true;
    if (!monoOk || (f.oe !== null && run.topk.shouldPrune(f.oe[j]!))) {
      run.pruned++;
      continue;
    }

    // Descend: child cover = parent cover ∧ row(id) at stack level s.
    const s = stack.length - 1; // frame depth index = prefix length
    path[s] = id;
    if (s === 0) {
      covers[0]!.set(task.atlas.row(id));
    } else {
      andInto(covers[s]!, 0, covers[s - 1]!, 0, task.atlas.bits, task.atlas.offset(id), w);
    }
    const frame = await expand(s + 1, id + 1);
    if (frame) stack.push(frame);
  }

  run.report(task.depth);
  return run.finish();
}
