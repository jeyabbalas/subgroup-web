/**
 * Generalization-aware quality functions (spec §6.8; BRIEF §22-A10).
 *
 * All three variants recurse over the immediate generalizations of a
 * description (drop one selector), memoized by canonical key — the reference
 * caches by repr the same way (measures.py:197-303).
 *
 * Python-semantics note: the reference aggregates with CPython `max`, whose
 * NaN handling is first-argument-sticky (max(nan, x) = nan, max(x, nan) = x).
 * `pyMax2` reproduces it exactly; NaN aggregates only arise from empty-cover
 * generalizations (degenerate spaces) and are pinned rather than smoothed.
 */

import { Conjunction } from "../desc/conjunction.js";
import { ValidationError } from "../errors.js";
import type { BinaryQF, DescriptionQF, EvalContext, NumericQF, QF } from "./types.js";

/** CPython max(a, b): b wins only when strictly greater — NaN is sticky-first. */
function pyMax2(a: number, b: number): number {
  return b > a ? b : a;
}

/**
 * Immediate generalizations in the reference's `combinations(selectors, k-1)`
 * order over the canonical selector sequence — i.e. drop the LAST selector
 * first. Tie-breaking in the aggregates below uses strict `>`, so iteration
 * order is semantics: the reference's order over an arbitrarily-ordered
 * conjunction makes GA-numeric qualities depend on construction order
 * (ADJ-009); subgroup-web pins the canonical order, matching the reference
 * whenever its conjunction was built in canonical order.
 */
function immediateGeneralizations(desc: Conjunction): Conjunction[] {
  const sels = desc.selectors;
  const out: Conjunction[] = [];
  for (let drop = sels.length - 1; drop >= 0; drop--) {
    out.push(new Conjunction(sels.filter((_, i) => i !== drop)));
  }
  return out;
}

/**
 * Generic wrapper (measures.py:197-246):
 * q_ga(sg) = q(sg) − max(0, max over all strict generalizations of q(g)),
 * the empty description included.
 */
export function generalizationAware(inner: QF): DescriptionQF {
  if (inner.kind === "description") {
    throw new ValidationError("generalizationAware: cannot wrap a description-level QF");
  }
  const cache = new Map<string, { q: number; prevMax: number }>();
  const qualAndPrev = (desc: Conjunction, ctx: EvalContext): { q: number; prevMax: number } => {
    const key = desc.canonicalKey();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const q = ctx.evaluate(inner, desc);
    // Reference: max_q seeded at 0 (measures.py:232).
    let prevMax = 0;
    if (desc.selectors.length > 0) {
      for (const gen of immediateGeneralizations(desc)) {
        const g = qualAndPrev(gen, ctx);
        prevMax = pyMax2(pyMax2(prevMax, g.q), g.prevMax);
      }
    }
    const entry = { q, prevMax };
    cache.set(key, entry);
    return entry;
  };
  return {
    kind: "description",
    name: `generalizationAware(${inner.name})`,
    pruningSafe: false,
    evaluate(desc, ctx) {
      const { q, prevMax } = qualAndPrev(desc, ctx);
      return q - prevMax;
    },
  };
}

// ---------------------------------------------------------------------------
// gaStandard(a) — GeneralizationAware_StandardQF (binary_target.py:638-851)

interface GaAgg {
  maxP: number;
  minDeltaNegatives: number;
  minNegatives: number;
}

interface GaEntry {
  n: number;
  p: number;
  agg: GaAgg;
}

export type GaStandardStrategy = "difference" | "max";

export function gaStandard(a: number, strategy: GaStandardStrategy = "difference"): DescriptionQF {
  if (strategy !== "difference" && strategy !== "max") {
    throw new ValidationError(
      `gaStandard: optimistic estimate strategy must be 'difference'|'max', got ${strategy}`,
    );
  }
  if (strategy === "max") return gaStandardMax(a);
  const cache = new Map<string, GaEntry>();

  const entryFor = (desc: Conjunction, ctx: EvalContext): GaEntry => {
    const key = desc.canonicalKey();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const stats = ctx.binaryStats(desc);
    const pp = (nn: number, ppos: number): number => (nn === 0 ? Number.NaN : ppos / nn);
    let agg: GaAgg;
    if (desc.selectors.length === 0) {
      // Empty pattern (binary_target.py:812-815): (own share, +inf, +inf).
      agg = {
        maxP: pp(stats.size, stats.positives),
        minDeltaNegatives: Number.POSITIVE_INFINITY,
        minNegatives: Number.POSITIVE_INFINITY,
      };
    } else {
      const pairs = immediateGeneralizations(desc).map((g) => entryFor(g, ctx));
      const sgNegatives = stats.size - stats.positives;
      let minImmediateNegatives = Number.POSITIVE_INFINITY;
      let minImmediateDelta = Number.POSITIVE_INFINITY;
      let maxP = Number.NEGATIVE_INFINITY;
      for (const pair of pairs) {
        minImmediateNegatives = Math.min(minImmediateNegatives, pair.n - pair.p);
        minImmediateDelta = Math.min(minImmediateDelta, pair.agg.minDeltaNegatives);
        // CPython max over max(pp(stats), agg.maxP) per pair
        maxP = pyMax2(maxP, pyMax2(pp(pair.n, pair.p), pair.agg.maxP));
      }
      const sgDelta = minImmediateNegatives - sgNegatives;
      agg = {
        maxP,
        minDeltaNegatives: Math.min(sgDelta, minImmediateDelta),
        minNegatives: sgDelta,
      };
    }
    const entry: GaEntry = { n: stats.size, p: stats.positives, agg };
    cache.set(key, entry);
    return entry;
  };

  return {
    kind: "description",
    name: `gaStandard(${a})`,
    pruningSafe: false,
    evaluate(desc, ctx) {
      const e = entryFor(desc, ctx);
      if (e.n === 0) return Number.NaN;
      const n0 = ctx.nRows;
      return (e.n / n0) ** a * (e.p / e.n - e.agg.maxP);
    },
    optimisticEstimate(desc, ctx) {
      // difference strategy (binary_target.py:760-791)
      const e = entryFor(desc, ctx);
      const agg = e.agg;
      if (agg.minDeltaNegatives === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
      const deltaN = agg.minDeltaNegatives;
      const n0 = ctx.nRows;
      let pos: number;
      if (a === 0) pos = 1;
      else if (a === 1) pos = e.p;
      else pos = Math.min(Math.ceil((a * deltaN) / (1 - a)), e.p);
      const tauDiff = pos / (pos + deltaN);
      const tauSg = e.n > 0 ? e.p / e.n : -1;
      const tauMax = pyMax2(pyMax2(tauDiff, tauSg), agg.maxP);
      return (e.p / n0) ** a * (1 - tauMax);
    },
  };
}

function gaStandardMax(a: number): DescriptionQF {
  interface MaxEntry {
    n: number;
    p: number;
    // aggregate = the stats tuple with max positives ratio among {stats, agg}
    // of the immediate generalization pairs (binary_target.py:700-724)
    aggN: number;
    aggP: number;
  }
  const cache = new Map<string, MaxEntry>();
  const entryFor = (desc: Conjunction, ctx: EvalContext): MaxEntry => {
    const key = desc.canonicalKey();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const stats = ctx.binaryStats(desc);
    let aggN = stats.size;
    let aggP = stats.positives;
    if (desc.selectors.length > 0) {
      const pairs = immediateGeneralizations(desc).map((g) => entryFor(g, ctx));
      let maxRatio = -100; // reference seed (binary_target.py:712)
      let best: { n: number; p: number } | null = null;
      for (const pair of pairs) {
        for (const cand of [
          { n: pair.n, p: pair.p },
          { n: pair.aggN, p: pair.aggP },
        ]) {
          if (cand.n === 0) continue;
          const ratio = cand.p / cand.n;
          if (ratio > maxRatio) {
            maxRatio = ratio;
            best = cand;
          }
        }
      }
      if (best !== null) {
        aggN = best.n;
        aggP = best.p;
      } else {
        // All generalizations empty — unreachable when the empty pattern is
        // among them (its cover is the dataset); keep own stats like the
        // empty-list branch.
      }
    }
    const entry: MaxEntry = { n: stats.size, p: stats.positives, aggN, aggP };
    cache.set(key, entry);
    return entry;
  };
  return {
    kind: "description",
    name: `gaStandard(${a},max)`,
    pruningSafe: false,
    evaluate(desc, ctx) {
      const e = entryFor(desc, ctx);
      if (e.n === 0) return Number.NaN;
      return (e.n / ctx.nRows) ** a * (e.p / e.n - e.aggP / e.aggN);
    },
    optimisticEstimate(desc, ctx) {
      const e = entryFor(desc, ctx);
      if (e.n === 0 || e.aggN === 0) return Number.NaN;
      return (e.p / ctx.nRows) ** a * (1 - e.aggP / e.aggN);
    },
  };
}

// ---------------------------------------------------------------------------
// gaStandardNumeric(a) — GeneralizationAware_StandardQFNumeric
// (numeric_target.py:770-835)

export function gaStandardNumeric(a: number, inner?: NumericQF): DescriptionQF {
  // The aggregate keyed on max(centroid(agg), centroid(stat)) but *storing*
  // the stat tuple — a pinned reference quirk (numeric_target.py:828-835).
  interface NumEntry {
    n: number;
    centroid: number;
    aggN: number;
    aggCentroid: number;
  }
  const centroidKind = inner?.plan.centroid ?? "mean";
  const cache = new Map<string, NumEntry>();
  const planKey = {
    centroid: centroidKind,
    direction: 1 as const,
    needStd: false,
    needMedian: centroidKind === "median",
    needExcess: false,
    needTail: false,
    needOrder: false,
    orderA: a,
  };
  const readCentroid = (s: { size: number; sum: number; median: number }): number =>
    centroidKind === "mean" ? s.sum / s.size : s.median;

  const entryFor = (desc: Conjunction, ctx: EvalContext): NumEntry => {
    const key = desc.canonicalKey();
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const stats = ctx.numericStats(desc, planKey);
    const own = {
      n: stats.size,
      centroid: stats.size > 0 ? readCentroid(stats) : Number.NaN,
    };
    let aggN = own.n;
    let aggCentroid = own.centroid;
    if (desc.selectors.length > 0) {
      const pairs = immediateGeneralizations(desc).map((g) => entryFor(g, ctx));
      // Reference seed 0.0 relaxed to −inf: with the reference seed, an
      // all-nonpositive-centroid family leaves max_stats = None and the
      // reference crashes on read; −inf picks the true argmax instead and
      // agrees with the reference wherever the reference terminates
      // (spec §6.8).
      let maxCentroid = Number.NEGATIVE_INFINITY;
      let best: NumEntry | null = null;
      for (const pair of pairs) {
        if (pair.n === 0) continue;
        const c = pyMax2(pair.aggCentroid, pair.centroid);
        if (c > maxCentroid) {
          maxCentroid = c;
          best = pair;
        }
      }
      if (best !== null) {
        aggN = best.n;
        aggCentroid = best.centroid;
      }
    }
    const entry: NumEntry = { n: own.n, centroid: own.centroid, aggN, aggCentroid };
    cache.set(key, entry);
    return entry;
  };

  return {
    kind: "description",
    name: `gaStandardNumeric(${a})`,
    pruningSafe: false,
    evaluate(desc, ctx) {
      const e = entryFor(desc, ctx);
      if (e.n === 0) return Number.NaN;
      return (e.n / ctx.nRows) ** a * (e.centroid - e.aggCentroid);
    },
  };
}

/** BinaryQF variant guard used by tests to assert wrapper input kinds. */
export function assertBinary(qf: QF): asserts qf is BinaryQF {
  if (qf.kind !== "binary") throw new ValidationError(`expected a binary QF, got ${qf.kind}`);
}
