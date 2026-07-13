/**
 * beamSearch (spec §7.8; BRIEF §5.4/§22-A13) — heuristic but FULLY
 * specified; deterministic and testable against its own spec.
 *
 * Semantics pinned from the reference (algorithms.py:490-573) with the
 * §3.2 canonical order replacing its heap artifacts:
 *
 * - width w = options.width (default 20); `adaptive: true` ⇒ w = k
 *   (reference `beam_width_adaptive`); w < k is an error (reference raises).
 * - The beam is a capacity-w §3.2-ordered candidate pool over MIXED depths;
 *   membership = §3.3 (quality > θ strict, all constraints) — the reference
 *   seeds the empty conjunction into its beam; our space (§3.1, ADJ-002)
 *   excludes it, so the empty description is expansion root only.
 * - Iteration i = 1..depth: snapshot the beam in §3.2 order; expand every
 *   snapshot member of depth < task.depth not yet expanded (the reference's
 *   `visited` flag, keyed here by canonical description). Expansion of M
 *   offers M ∪ {s} for every selector s ∉ M in canonical id order — same-
 *   attribute children included (the space is C(S, d)). Each description is
 *   evaluated at most once per run (canonical-key dedup; the reference
 *   re-evaluates and dedups against current beam content only — re-entry
 *   after displacement is a heap artifact we deliberately drop).
 * - Stop after `depth` iterations, or early when an iteration expands
 *   nothing (then the beam is a fixed point).
 * - Result = first k of the final beam under §3.2. (Since the beam always
 *   retains the best w ≥ k offered candidates under §3.2, this equals the
 *   first k of ALL offered candidates.)
 *
 * Greedy caveat (inherent to beam search, documented): expansion proceeds
 * only through beam members, so a candidate whose every parent fails θ or
 * falls off the beam is never generated. Exactness holds only in the
 * degenerate w ≥ |C(S,d)| case (diagnostic gate).
 */

import { ValidationError } from "../errors.js";
import { buildResults, type SubgroupResults } from "../results/result.js";
import { type SearchOptions, SearchRun } from "./engine.js";
import { type PreparedTask, prepareTask, type SubgroupTask } from "./task.js";
import { TopK, type TopKItem } from "./topk.js";

export interface BeamSearchOptions extends SearchOptions {
  /** Beam width w (candidates retained per §3.2 across all depths). */
  width?: number;
  /** Reference `beam_width_adaptive`: use w = resultSetSize. */
  adaptive?: boolean;
}

function tupleKey(tuple: ArrayLike<number>): string {
  let key = "";
  for (let i = 0; i < tuple.length; i++) key += `${tuple[i]},`;
  return key;
}

export async function beamSearch(
  taskSpec: SubgroupTask,
  options: BeamSearchOptions = {},
): Promise<SubgroupResults> {
  const task = prepareTask(taskSpec);
  const width = options.adaptive ? task.k : (options.width ?? 20);
  if (!Number.isInteger(width) || width < 1) {
    throw new ValidationError(`beamSearch: width must be a positive integer, got ${width}`);
  }
  if (width < task.k) {
    throw new ValidationError(
      `beamSearch: width (${width}) must be >= resultSetSize (${task.k}) — the reference ` +
        `raises here too`,
    );
  }
  const run = await SearchRun.create(task, options);
  try {
    return await beamRun(task, run, width);
  } finally {
    run.dispose();
  }
}

async function beamRun(
  task: PreparedTask,
  run: SearchRun,
  width: number,
): Promise<SubgroupResults> {
  const nSel = task.selectors.length;
  const beam = new TopK(width, task.minQuality);
  // Progress reads best-so-far from the beam — run.topk stays empty here.
  run.progressTopk = beam;
  const offered = new Set<string>();
  const expanded = new Set<string>();
  const coverScratch = new Uint32Array(task.atlas.wordsPerRow);
  const childScratch = new Uint16Array(task.depth);

  /** Expand `prefix` (null = root): offer every non-offered child. */
  const expand = async (prefix: Uint16Array | null): Promise<void> => {
    const prefixLen = prefix === null ? 0 : prefix.length;
    const childDepth = prefixLen + 1;
    let parent: Uint32Array | null = null;
    if (prefix !== null) {
      task.atlas.coverInto(Array.from(prefix), coverScratch);
      parent = coverScratch;
    }
    // Children: all selectors ∉ prefix whose description is new this run.
    const extIds: number[] = [];
    const childTuples: Uint16Array[] = [];
    for (let s = 0; s < nSel; s++) {
      if (prefix !== null && prefix.includes(s)) continue;
      // Sorted-insert s into the prefix.
      let w = 0;
      for (let d = 0; d < prefixLen; d++) {
        if (prefix![d]! < s) childScratch[w++] = prefix![d]!;
      }
      childScratch[w++] = s;
      for (let d = 0; d < prefixLen; d++) {
        if (prefix![d]! > s) childScratch[w++] = prefix![d]!;
      }
      const tuple = childScratch.slice(0, childDepth);
      const key = tupleKey(tuple);
      if (offered.has(key)) continue;
      offered.add(key);
      extIds.push(s);
      childTuples.push(tuple);
    }
    for (let start = 0; start < extIds.length; start += run.batchSize) {
      const bCount = Math.min(run.batchSize, extIds.length - start);
      const batch = await run.evaluator.evaluateExtensions(
        parent,
        extIds.slice(start, start + bCount),
      );
      const quality = new Float64Array(bCount);
      run.scorer.scoreBatch(batch, childDepth, (i) => childTuples[start + i]!, quality, null);
      for (let i = 0; i < bCount; i++) {
        if (run.membershipOk(batch.size[i]!)) {
          run.admitInto(beam, quality[i]!, childTuples[start + i]!, run.auxFor(batch, i));
        }
      }
      await run.tick(bCount, childDepth);
    }
  };

  await expand(null);
  for (let iteration = 2; iteration <= task.depth; iteration++) {
    const snapshot: readonly TopKItem[] = beam.toArray().slice();
    let expansions = 0;
    for (const member of snapshot) {
      if (member.tuple.length >= task.depth) continue;
      const key = tupleKey(member.tuple);
      if (expanded.has(key)) continue;
      expanded.add(key);
      expansions++;
      await expand(member.tuple);
    }
    if (expansions === 0) break;
  }

  run.report(task.depth);
  // First k of the beam; SearchRun.finish() would rebuild from its own topk,
  // so materialize directly.
  const items = beam.toArray().slice(0, task.k);
  run.dispose();
  return buildResults(task, items, run.evaluated, run.pruned, "conjunction", run.backendInfo());
}
