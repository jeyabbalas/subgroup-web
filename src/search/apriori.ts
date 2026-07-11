/**
 * Apriori — level-wise exact search (spec §7.4; BRIEF §5.4).
 *
 * Level ℓ holds ascending selector-id tuples in lexicographic order. Each
 * level is evaluated in batches through the BatchEvaluator; candidates enter
 * the canonical top-k under §3.3 membership. After the WHOLE level is scored
 * (θ_now is then final for the level — deterministic and maximally tight),
 * survivors are selected: a candidate may be extended iff monotone
 * constraints hold and the §3.4 rule keeps its optimistic estimate
 * (estimate pruning only when `qf.pruningSafe`). Level ℓ+1 is the classic
 * join — pairs sharing an (ℓ−1)-prefix — followed by the all-subsets check
 * against the survivor set (complete: a candidate is generated unless some
 * ℓ-subset was culled, in which case it is that subset's refinement and
 * §3.4-skippable).
 */

import type { SubgroupResults } from "../results/result.js";
import { type SearchOptions, SearchRun } from "./engine.js";
import { type PreparedTask, prepareTask, type SubgroupTask } from "./task.js";

function tupleKey(tuples: Uint16Array, base: number, arity: number): string {
  let key = "";
  for (let d = 0; d < arity; d++) key += `${tuples[base + d]},`;
  return key;
}

export async function apriori(
  taskSpec: SubgroupTask,
  options: SearchOptions = {},
): Promise<SubgroupResults> {
  const task = prepareTask(taskSpec);
  const run = await SearchRun.create(task, options);
  try {
    return await aprioriRun(task, run);
  } finally {
    run.dispose();
  }
}

async function aprioriRun(task: PreparedTask, run: SearchRun): Promise<SubgroupResults> {
  const nSel = task.selectors.length;

  let arity = 1;
  let tuples = new Uint16Array(nSel);
  for (let i = 0; i < nSel; i++) tuples[i] = i;

  for (;;) {
    const count = tuples.length / arity;
    const quality = new Float64Array(count);
    const needOe = run.canPrune && arity < task.depth;
    const oe = needOe ? new Float64Array(count) : null;
    const sizes = new Uint32Array(count);

    for (let start = 0; start < count; start += run.batchSize) {
      const bCount = Math.min(run.batchSize, count - start);
      const slice = tuples.subarray(start * arity, (start + bCount) * arity);
      const batch = await run.evaluator.evaluateTuples(slice, arity, bCount);
      run.scorer.scoreBatch(
        batch,
        arity,
        (i) => slice.subarray(i * arity, (i + 1) * arity),
        quality.subarray(start, start + bCount),
        oe ? oe.subarray(start, start + bCount) : null,
      );
      sizes.set(batch.size, start);
      for (let i = 0; i < bCount; i++) {
        const gi = start + i;
        if (run.membershipOk(sizes[gi]!)) {
          run.admit(
            quality[gi]!,
            tuples.subarray(gi * arity, gi * arity + arity),
            run.auxFor(batch, i),
          );
        }
      }
      await run.tick(bCount, arity);
    }

    if (arity === task.depth) break;

    // Survivors under the level-final threshold (spec §7.4).
    const extendable: number[] = [];
    const survivorKeys = new Set<string>();
    for (let ci = 0; ci < count; ci++) {
      const monoOk = run.constraintPrune ? run.monotoneOk(sizes[ci]!) : true;
      const keep = monoOk && !(oe !== null && run.topk.shouldPrune(oe[ci]!));
      if (keep) {
        extendable.push(ci);
        survivorKeys.add(tupleKey(tuples, ci * arity, arity));
      } else {
        run.pruned++;
      }
    }

    // Join within equal-(arity−1)-prefix runs (extendable is lex-sorted).
    const next: number[] = [];
    const prefixLen = arity - 1;
    const samePrefix = (aBase: number, bBase: number): boolean => {
      for (let d = 0; d < prefixLen; d++) {
        if (tuples[aBase + d] !== tuples[bBase + d]) return false;
      }
      return true;
    };
    const subset = new Uint16Array(arity);
    let g0 = 0;
    while (g0 < extendable.length) {
      let g1 = g0 + 1;
      while (
        g1 < extendable.length &&
        samePrefix(extendable[g0]! * arity, extendable[g1]! * arity)
      ) {
        g1++;
      }
      for (let ai = g0; ai < g1; ai++) {
        const aBase = extendable[ai]! * arity;
        for (let bi = ai + 1; bi < g1; bi++) {
          const bLast = tuples[extendable[bi]! * arity + arity - 1]!;
          // Candidate = tuple(a) + [last(b)]; check the subsets that drop a
          // prefix position (dropping the last two positions gives a and b).
          let allSurvive = true;
          for (let drop = 0; drop < prefixLen && allSurvive; drop++) {
            let w = 0;
            for (let d = 0; d < arity; d++) {
              if (d !== drop) subset[w++] = tuples[aBase + d]!;
            }
            subset[w] = bLast;
            allSurvive = survivorKeys.has(tupleKey(subset, 0, arity));
          }
          if (allSurvive) {
            for (let d = 0; d < arity; d++) next.push(tuples[aBase + d]!);
            next.push(bLast);
          }
        }
      }
      g0 = g1;
    }

    if (next.length === 0) break;
    tuples = Uint16Array.from(next);
    arity++;
  }

  run.report(arity);
  return run.finish();
}
