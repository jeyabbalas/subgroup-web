/**
 * patternTree (spec §7.10; BRIEF §5.4/§22-A9) — the exact FP-growth-style
 * engine replacing the reference's experimental GpGrowth. Builds a frequency-
 * ordered prefix tree of per-row selector sets with MERGEABLE integer target
 * statistics on every node (size; binary: positives), then mines conditional
 * trees recursively, depth-capped at task.depth. Every support > 0 member of
 * C(S, d) is visited exactly once, with statistics identical to a direct
 * cover count (integer sums are order-independent — qualities are
 * bit-identical to the oracle's).
 *
 * Applicability (typed errors; documented restriction like dfsNumeric's):
 * - binary and frequent-itemset targets with stats-level QFs. The
 *   reference's GpGrowth hooks (`gp_*`) exist for exactly StandardQF /
 *   CountQF / AreaQF — numeric targets have none, and its EMM support
 *   materializes cover arrays, defeating pure merging; f64 tree-order merges
 *   would additionally break the §7 bit-identical-quality guarantee.
 * - FI targets additionally require minQuality ≥ 0 or effective
 *   minSupport ≥ 1: zero-cover candidates (quality 0, eligible when θ < 0)
 *   are members of C(S, d) that the tree never materializes. Binary targets
 *   need no guard (empty covers evaluate NaN, never §3.3-members).
 *
 * Pruning (§3.4 + monotone constraints, `pruningSafe`-gated) cuts
 * conditional-tree recursion; `pruning: false` mines every support > 0
 * itemset (identical results — the pruning-identity gate; the full-space
 * evaluation-count identity of enumeration engines is inapplicable here by
 * design: the tree visits only support > 0 itemsets).
 */

import { ValidationError } from "../errors.js";
import { buildResults, type SubgroupResults } from "../results/result.js";
import { type SearchOptions, SearchRun } from "./engine.js";
import { prepareTask, type SubgroupTask } from "./task.js";

interface FpNode {
  item: number;
  size: number;
  positives: number;
  parent: FpNode | null;
  children: Map<number, FpNode>;
  /** Chain to the next node holding the same item (header list). */
  link: FpNode | null;
}

/** One minable item at the current conditional level. */
interface CondItem {
  item: number;
  /** Support / positives of (current prefix) ∪ {item}. */
  size: number;
  positives: number;
  /** Header chain of `item` inside the current (conditional) tree. */
  head: FpNode | null;
}

function popcount(x: number): number {
  let v = x - ((x >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

export async function patternTree(
  taskSpec: SubgroupTask,
  options: SearchOptions = {},
): Promise<SubgroupResults> {
  const task = prepareTask(taskSpec);
  const prep = task.prepared;
  const qf = task.qf;
  if (prep.kind !== "binary" && prep.kind !== "fi") {
    throw new ValidationError(
      `patternTree supports binary and frequentItemset targets (got ${prep.kind}); its merge ` +
        `algebra is integer-exact only — use apriori()/dfs() for numeric or emm targets ` +
        `(spec §7.10)`,
    );
  }
  if (qf.kind !== "binary" && qf.kind !== "fi") {
    throw new ValidationError(
      `patternTree requires a stats-level binary or fi quality function (got ${qf.kind}); ` +
        `description-level QFs need generalization statistics the tree does not merge — ` +
        `use apriori()/dfs() (spec §7.10)`,
    );
  }
  if (prep.kind === "fi" && !(task.minQuality >= 0 || task.minSupportRows >= 1)) {
    throw new ValidationError(
      `patternTree on a frequentItemset target requires minQuality >= 0 or minSupport >= 1: ` +
        `zero-cover candidates (quality 0) are eligible under minQuality ${task.minQuality} ` +
        `but are never materialized by the tree — add minSupport(1) or use apriori() ` +
        `(spec §7.10)`,
    );
  }

  // CPU-native engine (docs/design.md §backend applicability): the FP-tree's
  // integer merge algebra IS its evaluator — backend/workers options have no
  // evaluation surface here and are not forwarded.
  const run = await SearchRun.create(task, {
    ...(options.pruning !== undefined ? { pruning: options.pruning } : {}),
    ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
  });
  const nSel = task.selectors.length;
  const atlas = task.atlas;
  const n = task.table.nRows;
  const positivesBits = prep.kind === "binary" ? prep.positivesBits : null;

  // Global per-selector aggregates from the atlas.
  const support = new Uint32Array(nSel);
  const itemPositives = new Uint32Array(nSel);
  for (let s = 0; s < nSel; s++) {
    let size = 0;
    let pos = 0;
    const off = atlas.offset(s);
    for (let w = 0; w < atlas.wordsPerRow; w++) {
      const word = atlas.bits[off + w]!;
      size += popcount(word);
      if (positivesBits) pos += popcount(word & positivesBits[w]!);
    }
    support[s] = size;
    itemPositives[s] = pos;
  }

  // f-list: support desc → id asc; support-0 selectors excluded (all their
  // candidates are empty-cover; see the applicability guards above).
  const fOrder = Array.from({ length: nSel }, (_, s) => s)
    .filter((s) => support[s]! > 0)
    .sort((a, b) => support[b]! - support[a]! || a - b);

  // Build the global tree: insert each row's satisfied selector set in
  // f-list order, accumulating (size, positives) along the path.
  const root: FpNode = {
    item: -1,
    size: 0,
    positives: 0,
    parent: null,
    children: new Map(),
    link: null,
  };
  const globalHeads = new Map<number, FpNode>();
  const rowItems: number[] = [];
  for (let r = 0; r < n; r++) {
    rowItems.length = 0;
    const w = r >>> 5;
    const bit = 1 << (r & 31);
    for (const s of fOrder) {
      if ((atlas.bits[atlas.offset(s) + w]! & bit) !== 0) rowItems.push(s);
    }
    if (rowItems.length === 0) continue;
    const isPositive = positivesBits !== null && (positivesBits[w]! & bit) !== 0 ? 1 : 0;
    let node = root;
    for (const s of rowItems) {
      let child = node.children.get(s);
      if (child === undefined) {
        child = {
          item: s,
          size: 0,
          positives: 0,
          parent: node,
          children: new Map(),
          link: globalHeads.get(s) ?? null,
        };
        globalHeads.set(s, child);
        node.children.set(s, child);
      }
      child.size += 1;
      child.positives += isPositive;
      node = child;
    }
  }

  const prefix: number[] = [];
  const sortedScratch = new Uint16Array(task.depth);

  /** Evaluate candidate = prefix ∪ {item}; returns its optimistic estimate. */
  const offer = (item: number, size: number, positives: number): number => {
    const depth = prefix.length + 1;
    for (let i = 0; i < prefix.length; i++) sortedScratch[i] = prefix[i]!;
    sortedScratch[depth - 1] = item;
    const tuple = sortedScratch.subarray(0, depth);
    tuple.sort();
    const quality =
      qf.kind === "binary"
        ? qf.evaluate(size, positives, prep as never)
        : qf.evaluate({ size, depth }, prep as never);
    if (run.membershipOk(size)) run.topk.add(quality, tuple);
    if (!run.canPrune) return Number.POSITIVE_INFINITY;
    if (qf.kind === "binary" && qf.optimisticEstimate) {
      return qf.optimisticEstimate(size, positives, prep as never);
    }
    if (qf.kind === "fi" && qf.optimisticEstimate) {
      return qf.optimisticEstimate({ size, depth }, prep as never);
    }
    return Number.POSITIVE_INFINITY;
  };

  /**
   * Mine one conditional level; `items` are f-rank ascending, processed in
   * reverse (least-frequent first, classic FP-growth; result-invariant since
   * the top-k is order-invariant).
   */
  const mine = async (items: CondItem[], prefixDepth: number): Promise<void> => {
    for (let idx = items.length - 1; idx >= 0; idx--) {
      const it = items[idx]!;
      const oe = offer(it.item, it.size, it.positives);
      await run.tick(1, prefixDepth + 1);
      if (prefixDepth + 1 >= task.depth) continue;
      if (run.constraintPrune) {
        if (!run.monotoneOk(it.size) || (run.canPrune && run.topk.shouldPrune(oe))) {
          run.pruned++;
          continue;
        }
      }
      // Conditional projection of `it`: every path above one of its nodes,
      // weighted by that node's (size, positives), inserted into a fresh
      // conditional tree (path item order — ascending f-rank — is preserved
      // from the parent tree, so insertion order is consistent).
      const condRoot: FpNode = {
        item: -1,
        size: 0,
        positives: 0,
        parent: null,
        children: new Map(),
        link: null,
      };
      const condHeads = new Map<number, FpNode>();
      const condAgg = new Map<number, { size: number; positives: number }>();
      const pathItems: number[] = [];
      for (let node = it.head; node !== null; node = node.link) {
        pathItems.length = 0;
        for (let p = node.parent; p !== null && p.item !== -1; p = p.parent) {
          pathItems.push(p.item);
        }
        if (pathItems.length === 0) continue;
        pathItems.reverse();
        let cnode = condRoot;
        for (const s of pathItems) {
          let child = cnode.children.get(s);
          if (child === undefined) {
            child = {
              item: s,
              size: 0,
              positives: 0,
              parent: cnode,
              children: new Map(),
              link: condHeads.get(s) ?? null,
            };
            condHeads.set(s, child);
            cnode.children.set(s, child);
          }
          child.size += node.size;
          child.positives += node.positives;
          cnode = child;
          const a = condAgg.get(s);
          if (a === undefined) {
            condAgg.set(s, { size: node.size, positives: node.positives });
          } else {
            a.size += node.size;
            a.positives += node.positives;
          }
        }
      }
      const condItems: CondItem[] = [];
      for (const s of fOrder) {
        const a = condAgg.get(s);
        if (a !== undefined && a.size > 0) {
          condItems.push({
            item: s,
            size: a.size,
            positives: a.positives,
            head: condHeads.get(s) ?? null,
          });
        }
      }
      if (condItems.length > 0) {
        prefix.push(it.item);
        await mine(condItems, prefixDepth + 1);
        prefix.pop();
      }
    }
  };

  const rootItems: CondItem[] = fOrder.map((s) => ({
    item: s,
    size: support[s]!,
    positives: itemPositives[s]!,
    head: globalHeads.get(s) ?? null,
  }));
  await mine(rootItems, 0);

  run.report(task.depth);
  run.dispose();
  return buildResults(task, run.topk.toArray(), run.evaluated, run.pruned);
}
