/**
 * Hand-computed micro-fixtures for every quality function (BRIEF §6.1;
 * spec §§5-6). Each expectation's arithmetic is worked out in the comments —
 * these tables are the spec's executable ground truth, independent of the
 * reference.
 */
import { describe, expect, it } from "vitest";
import {
  area,
  binary,
  binaryStatsTable,
  Conjunction,
  CoverEvalContext,
  chiSquared,
  combined,
  count,
  emm,
  emmLikelihood,
  emmStatsFromMask,
  equality,
  frequentItemset,
  fromColumns,
  gaStandard,
  gaStandardNumeric,
  gatherValuesFromMask,
  generalizationAware,
  isNull,
  lift,
  negated,
  numeric,
  numericStatsTable,
  type PreparedBinary,
  type PreparedNumeric,
  polyRegression,
  prepareTarget,
  simpleBinomial,
  standard,
  standardNumeric,
  standardNumericMedian,
  standardNumericTscore,
  wracc,
} from "../../src/index.js";

// ---------------------------------------------------------------------------
// Table A — binary target, 10 rows, N=10, P=5, p0 = 0.5
//   sex: M M M M F F F F M F
//   cls: a a b b a a b b a b
//   y:   1 0 1 0 1 1 1 0 0 0    positives rows {0,2,4,5,6}
const tableA = fromColumns({
  sex: ["M", "M", "M", "M", "F", "F", "F", "F", "M", "F"],
  cls: ["a", "a", "b", "b", "a", "a", "b", "b", "a", "b"],
  y: [1, 0, 1, 0, 1, 1, 1, 0, 0, 0],
});
const targetA = binary({ attribute: "y", value: 1 });
const prepA = prepareTarget(tableA, targetA) as PreparedBinary;
const ctxA = new CoverEvalContext(tableA, prepA);
// sex==F covers rows {4,5,6,7,9}: n=5, p=3 (rows 4,5,6 positive)
const F = new Conjunction([equality("sex", "F")]);
// sex==F AND cls==a covers rows {4,5}: n=2, p=2
const FandA = new Conjunction([equality("sex", "F"), equality("cls", "a")]);
// empty cover
const EMPTY = new Conjunction([equality("sex", "X")]);

describe("standard(a) family on Table A (spec §6.1)", () => {
  it("wracc(F) = (5/10)^1 * (3/5 - 1/2) = 0.05", () => {
    expect(ctxA.evaluate(wracc(), F)).toBeCloseTo(0.05, 15);
  });
  it("lift(F) = (5/10)^0 * 0.1 = 0.1", () => {
    expect(ctxA.evaluate(lift(), F)).toBeCloseTo(0.1, 15);
  });
  it("simpleBinomial(F) = sqrt(0.5) * 0.1", () => {
    expect(ctxA.evaluate(simpleBinomial(), F)).toBeCloseTo(Math.sqrt(0.5) * 0.1, 15);
  });
  it("standard(0.5) === simpleBinomial alias identity", () => {
    expect(ctxA.evaluate(standard(0.5), F)).toBe(ctxA.evaluate(simpleBinomial(), F));
    expect(ctxA.evaluate(standard(1), F)).toBe(ctxA.evaluate(wracc(), F));
    expect(ctxA.evaluate(standard(0), F)).toBe(ctxA.evaluate(lift(), F));
  });
  it("empty cover evaluates to NaN and never enters results (spec §5.5)", () => {
    expect(ctxA.evaluate(wracc(), EMPTY)).toBeNaN();
  });
  it("optimistic estimate wracc(F) = (3/10) * (1 - 0.5) = 0.15 >= quality", () => {
    expect(ctxA.optimisticEstimate(wracc(), F)).toBeCloseTo(0.15, 15);
  });
  it("optimistic estimate is 0 on a zero-positive subgroup", () => {
    // cls==b AND sex==M covers rows {2,3}: p from y rows 2(1)... p=1 — use
    // an actually 0-positive cover: sex==M AND cls==a AND y... use EMPTY:
    expect(ctxA.optimisticEstimate(wracc(), EMPTY)).toBe(0);
  });
  it("full-dataset conjunction: q = 0 (share equals p0), estimate (P/N)^a(1-p0)", () => {
    const all = new Conjunction([]);
    expect(ctxA.evaluate(wracc(), all)).toBeCloseTo(0, 15);
    expect(ctxA.optimisticEstimate(wracc(), all)).toBeCloseTo(0.25, 15);
  });
});

describe("binary statistics table on Table A (spec §5.1, 13 fields)", () => {
  it("F: the reference formulas, field for field", () => {
    const stats = binaryStatsTable(prepA, ctxA.binaryStats(F));
    expect(stats).toEqual({
      size_sg: 5,
      size_dataset: 10,
      positives_sg: 3,
      positives_dataset: 5,
      size_complement: 5,
      relative_size_sg: 0.5,
      relative_size_complement: 0.5,
      coverage_sg: 0.6,
      coverage_complement: 0.4,
      target_share_sg: 0.6,
      target_share_complement: 0.4,
      target_share_dataset: 0.5,
      lift: 0.6 / 0.5,
    });
  });
  it("empty cover: share NaN, complement share defined", () => {
    const stats = binaryStatsTable(prepA, ctxA.binaryStats(EMPTY));
    expect(stats.target_share_sg).toBeNaN();
    expect(stats.lift).toBeNaN();
    expect(stats.target_share_complement).toBe(0.5);
    expect(stats.coverage_sg).toBe(0);
  });
  it("full cover: target_share_complement is NaN (reference guard)", () => {
    const stats = binaryStatsTable(prepA, ctxA.binaryStats(new Conjunction([])));
    expect(stats.target_share_complement).toBeNaN();
  });
});

describe("chiSquared on Table A (spec §6.2)", () => {
  // F: 2x2 = [[3, 2], [2, 3]], expected all 2.5, chi2 = 4 * 0.25/2.5 = 0.4
  // scipy chi2_contingency(correction=False): statistic 0.4, p 0.5270892568655381
  it("chi2(F) = 0.4 (no continuity correction)", () => {
    expect(ctxA.evaluate(chiSquared({ minInstances: 1 }), F)).toBeCloseTo(0.4, 14);
  });
  it("pValue(F) = 0.5270892568655381 (scipy literal)", () => {
    const got = ctxA.evaluate(chiSquared({ minInstances: 1, stat: "pValue" }), F);
    expect(Math.abs(got - 0.5270892568655381)).toBeLessThanOrEqual(1e-12);
  });
  it("direction 'positive': F has share 0.6 > 0.5, value stays positive", () => {
    expect(ctxA.evaluate(chiSquared({ minInstances: 1, direction: "positive" }), F)).toBeCloseTo(
      0.4,
      14,
    );
  });
  it("direction 'negative': F deviates positively, value negated", () => {
    expect(ctxA.evaluate(chiSquared({ minInstances: 1, direction: "negative" }), F)).toBeCloseTo(
      -0.4,
      14,
    );
  });
  it("minInstances guards subgroup and complement (reference parity)", () => {
    expect(ctxA.evaluate(chiSquared({ minInstances: 6 }), F)).toBe(Number.NEGATIVE_INFINITY);
    // FandA: n=2 < 5 (default minInstances)
    expect(ctxA.evaluate(chiSquared({}), FandA)).toBe(Number.NEGATIVE_INFINITY);
  });
});

// ---------------------------------------------------------------------------
// Table B — NA + negation, 8 rows
//   x: a a b b NA NA a b
//   y: 1 0 1 0 1  1  1 0    P=5, p0=0.625
const tableB = fromColumns({
  x: ["a", "a", "b", "b", null, null, "a", "b"],
  y: [1, 0, 1, 0, 1, 1, 1, 0],
});
const prepB = prepareTarget(tableB, binary({ attribute: "y", value: 1 })) as PreparedBinary;
const ctxB = new CoverEvalContext(tableB, prepB);

describe("NA policy through QFs on Table B (spec §1.2 + §6.1; ADJ-003)", () => {
  it("x=='a': rows {0,1,6}, p=2: wracc = 3/8*(2/3 - 5/8) = 0.015625", () => {
    const q = ctxB.evaluate(wracc(), new Conjunction([equality("x", "a")]));
    expect(q).toBeCloseTo((3 / 8) * (2 / 3 - 5 / 8), 15);
  });
  it("NOT x=='a' covers {2,3,7} (never NA rows): wracc = 3/8*(1/3 - 5/8) = -0.109375", () => {
    // The reference's logical_not would cover {2,3,4,5,7} (n=5, p=3) giving
    // 5/8*(3/5 - 5/8) = -0.015625 — adjudicated divergence ADJ-003.
    const q = ctxB.evaluate(wracc(), new Conjunction([negated(equality("x", "a"))]));
    expect(q).toBeCloseTo(-0.109375, 15);
  });
  it("x.isnull() covers {4,5}, both positive: wracc = 2/8*(1 - 5/8) = 0.09375", () => {
    const q = ctxB.evaluate(wracc(), new Conjunction([isNull("x")]));
    expect(q).toBeCloseTo(0.09375, 15);
  });
});

// ---------------------------------------------------------------------------
// Table C — numeric target, 8 rows
//   T: 10 2 8 4 7 5 12 0   sum 48, mean 6, median 6, std sqrt(14.25)
//   g: a a a a b b b  b
//   k: e e e f f f f  e
const tableC = fromColumns({
  T: [10, 2, 8, 4, 7, 5, 12, 0],
  g: ["a", "a", "a", "a", "b", "b", "b", "b"],
  k: ["e", "e", "e", "f", "f", "f", "f", "e"],
});
const prepC = prepareTarget(tableC, numeric("T")) as PreparedNumeric;
const ctxC = new CoverEvalContext(tableC, prepC);
const Kf = new Conjunction([equality("k", "f")]); // rows {3,4,5,6}: T = [4,7,5,12], mean 7
const Ke = new Conjunction([equality("k", "e")]); // rows {0,1,2,7}: T = [10,2,8,0], mean 5
const Ga = new Conjunction([equality("g", "a")]); // rows {0..3}: T = [10,2,8,4], mean 6 (tie)
const EMPTYC = new Conjunction([equality("g", "zzz")]);

describe("standardNumeric on Table C (spec §6.3)", () => {
  it("a=1: q(k=='f') = 4 * (7-6) = 4; q(k=='e') = 4 * (5-6) = -4", () => {
    expect(ctxC.evaluate(standardNumeric(1), Kf)).toBeCloseTo(4, 14);
    expect(ctxC.evaluate(standardNumeric(1), Ke)).toBeCloseTo(-4, 14);
  });
  it("a=0.5: q(k=='f') = 2 * 1 = 2; a=0: q = 1", () => {
    expect(ctxC.evaluate(standardNumeric(0.5), Kf)).toBeCloseTo(2, 14);
    expect(ctxC.evaluate(standardNumeric(0), Kf)).toBeCloseTo(1, 14);
  });
  it("tie subgroup g=='a' has mean 6 = mu0: q = 0 at any a", () => {
    expect(ctxC.evaluate(standardNumeric(1), Ga)).toBeCloseTo(0, 15);
    expect(ctxC.evaluate(standardNumeric(0.5), Ga)).toBeCloseTo(0, 15);
  });
  it("empty cover: NaN (spec §5.5; the reference returns 0 — ADJ-004)", () => {
    expect(ctxC.evaluate(standardNumeric(1), EMPTYC)).toBeNaN();
    expect(ctxC.evaluate(standardNumeric(0), EMPTYC)).toBeNaN();
  });
  it("invert: q(k=='e') = 4 * (6-5) = 4 (ADJ-005: reference ignores invert)", () => {
    expect(ctxC.evaluate(standardNumeric(1, { invert: true }), Ke)).toBeCloseTo(4, 14);
  });

  it("'sum' estimate of k=='f' = (7-6) + (12-6) = 7", () => {
    expect(ctxC.optimisticEstimate(standardNumeric(1, { estimator: "sum" }), Kf)).toBeCloseTo(
      7,
      14,
    );
  });
  it("'max'/'average' estimate: n+=2, max=12: a=1: 2*6=12; a=0.5: sqrt(2)*6", () => {
    expect(ctxC.optimisticEstimate(standardNumeric(1, { estimator: "max" }), Kf)).toBeCloseTo(
      12,
      14,
    );
    expect(ctxC.optimisticEstimate(standardNumeric(0.5, { estimator: "average" }), Kf)).toBeCloseTo(
      Math.sqrt(2) * 6,
      14,
    );
  });
  it("'max' closure: all values below mu0 -> estimate 0, not -inf (spec §6.3)", () => {
    // g=='zzz2'? use a cover with all values < 6: k=='e' minus 10,8...
    // rows {1,7}: T = [2,0] — describable as g=='a' AND k=='e' gives rows {0,1,2}
    // T=[10,2,8] has 10,8 > 6. Use cls-free: build cover via T interval instead:
    // interval selectors live in desc; simplest: subgroup {1,7} = k=='e' AND g... row1 g=a,row7 g=b.
    // Take conjunction [g=='b', k=='e']: rows {7}: T=[0] all < 6.
    const be = new Conjunction([equality("g", "b"), equality("k", "e")]);
    expect(ctxC.optimisticEstimate(standardNumeric(1, { estimator: "max" }), be)).toBe(0);
    // reference Max_Estimator would return -inf here (ADJ-007 class)
  });
  it("'order' estimate k=='f', a=1: max over desc prefixes [12,7,5,4] = 7 at j=2", () => {
    // j=1: 6, j=2: 2*(9.5-6)=7, j=3: 3*(8-6)=6, j=4: 4*1=4
    expect(ctxC.optimisticEstimate(standardNumeric(1, { estimator: "order" }), Kf)).toBeCloseTo(
      7,
      14,
    );
  });
  it("'order' estimate k=='f', a=0.5: j=1 wins with 6", () => {
    // j=1: 6, j=2: sqrt2*3.5≈4.95, j=3: sqrt3*2≈3.46, j=4: 2
    expect(ctxC.optimisticEstimate(standardNumeric(0.5, { estimator: "order" }), Kf)).toBeCloseTo(
      6,
      14,
    );
  });
  it("inverted estimators mirror on -T: k=='e' sum: (6-2)+(6-0) = 10; order: 10 at j=2", () => {
    expect(
      ctxC.optimisticEstimate(standardNumeric(1, { invert: true, estimator: "sum" }), Ke),
    ).toBeCloseTo(10, 14);
    // working -T desc: [0,-2,-8,-10], c0w=-6: j=1: 6, j=2: 2*5=10, j=3: 8, j=4: 4
    expect(
      ctxC.optimisticEstimate(standardNumeric(1, { invert: true, estimator: "order" }), Ke),
    ).toBeCloseTo(10, 14);
  });
});

describe("standardNumericMedian / tscore on Table C (spec §6.4-6.5)", () => {
  it("median0 = 6; q(k=='e') = 4 * ((2+8)/2 - 6) = -4 at a=1", () => {
    expect(ctxC.evaluate(standardNumericMedian(1), Ke)).toBeCloseTo(-4, 14);
  });
  it("median q(k=='f') = 4 * ((5+7)/2 - 6) = 0", () => {
    expect(ctxC.evaluate(standardNumericMedian(1), Kf)).toBeCloseTo(0, 14);
  });
  it("median safe-form estimate k=='e': n^a * (10-6) = 16 (spec §6.4)", () => {
    // The reference's n+-based bound would be 2^1*(10-6)=8 — inadmissible for
    // medians (spec §6.4 counterexample); the safe form dominates it.
    expect(ctxC.optimisticEstimate(standardNumericMedian(1), Ke)).toBeCloseTo(16, 14);
  });
  it("tscore(k=='f') = sqrt(4)*(7-6)/sqrt(9.5)", () => {
    // subgroup devs from mean 7: [-3,0,-2,5] -> squares [9,0,4,25], mean 9.5
    expect(ctxC.evaluate(standardNumericTscore(), Kf)).toBeCloseTo(2 / Math.sqrt(9.5), 14);
  });
  it("tscore of a constant subgroup is 0 (std = 0)", () => {
    const be = new Conjunction([equality("g", "b"), equality("k", "e")]); // single row
    expect(ctxC.evaluate(standardNumericTscore(), be)).toBe(0);
  });
  it("tscore/median/standardNumeric of empty cover: NaN (ADJ-004)", () => {
    expect(ctxC.evaluate(standardNumericTscore(), EMPTYC)).toBeNaN();
    expect(ctxC.evaluate(standardNumericMedian(1), EMPTYC)).toBeNaN();
  });
});

describe("numeric statistics table on Table C (spec §5.2, 14 fields)", () => {
  it("k=='f': [4,7,5,12]", () => {
    const gathered = gatherValuesFromMask(prepC, ctxC.coverOf(Kf));
    const stats = numericStatsTable(prepC, gathered);
    expect(stats.size_sg).toBe(4);
    expect(stats.size_dataset).toBe(8);
    expect(stats.mean_sg).toBeCloseTo(7, 15);
    expect(stats.mean_dataset).toBeCloseTo(6, 15);
    expect(stats.std_sg).toBeCloseTo(Math.sqrt(9.5), 15);
    expect(stats.std_dataset).toBeCloseTo(Math.sqrt(14.25), 15);
    expect(stats.median_sg).toBeCloseTo(6, 15); // (5+7)/2
    expect(stats.median_dataset).toBeCloseTo(6, 15);
    expect(stats.max_sg).toBe(12);
    expect(stats.min_sg).toBe(4);
    expect(stats.max_dataset).toBe(12);
    expect(stats.min_dataset).toBe(0);
    expect(stats.mean_lift).toBeCloseTo(7 / 6, 15);
    expect(stats.median_lift).toBeCloseTo(1, 15);
  });
});

// ---------------------------------------------------------------------------
// FI target on Table C

describe("count / area on Table C (spec §6.6)", () => {
  const prepFi = prepareTarget(tableC, frequentItemset());
  const ctxFi = new CoverEvalContext(tableC, prepFi);
  it("count(k=='f') = 4 with estimate 4", () => {
    expect(ctxFi.evaluate(count(), Kf)).toBe(4);
    expect(ctxFi.optimisticEstimate(count(), Kf)).toBe(4);
  });
  it("area(g=='b' AND k=='f') = size 3 * depth 2 = 6", () => {
    // g=='b' rows {4,5,6,7} ∩ k=='f' rows {3,4,5,6} = {4,5,6}
    const bf = new Conjunction([equality("g", "b"), equality("k", "f")]);
    expect(ctxFi.evaluate(area(), bf)).toBe(6);
  });
  it("area estimate with maxDepth 3: 3 * size", () => {
    expect(ctxFi.optimisticEstimate(area(3), Kf)).toBe(12);
  });
});

// ---------------------------------------------------------------------------
// Table D — EMM, 8 rows: sg rows 0-3 fit y = x perfectly; complement inverted
//   x: 0 1 2 3 0 1 2 3
//   y: 0 1 2 3 3 2 1 0
const tableD = fromColumns({
  x: [0, 1, 2, 3, 0, 1, 2, 3],
  y: [0, 1, 2, 3, 3, 2, 1, 0],
  grp: ["s", "s", "s", "s", "c", "c", "c", "c"],
});
const targetD = emm(polyRegression("x", "y"));
const prepD = prepareTarget(tableD, targetD);
const ctxD = new CoverEvalContext(tableD, prepD);

describe("emmLikelihood on Table D (spec §6.7)", () => {
  const qf = emmLikelihood(polyRegression("x", "y"));
  it("subgroup grp=='s': slope 1, intercept 0; q = phi(0) - (2*phi(1)+2*phi(3))/4", () => {
    // residuals: sg all 0 -> phi(0) = 0.3989422804014327 each
    // complement: yhat - y = x - y = [-3,-1,1,3] -> phi(1)=0.24197072451914337,
    // phi(3)=0.0044318484119380075
    // q = 0.3989422804014327 - (2*0.24197072451914337 + 2*0.0044318484119380075)/4
    //   = 0.275740993935892  (scipy-verified literal)
    const q = ctxD.evaluate(qf, new Conjunction([equality("grp", "s")]));
    expect(Math.abs(q - 0.275740993935892)).toBeLessThanOrEqual(1e-12);
  });
  it("degenerate fits are NaN: n <= 2 and zero x-variance (spec §5.4, ADJ-006)", () => {
    // n = 2 subgroup: x==0 covers rows {0,4}
    expect(ctxD.evaluate(qf, new Conjunction([equality("x", 0)]))).toBeNaN();
    // zero x-variance with n = 4: build from a table where a selector picks
    // constant x with > 2 rows
    const tbl = fromColumns({
      x: [1, 1, 1, 2, 3, 4],
      y: [0, 1, 2, 3, 4, 5],
      m: ["u", "u", "u", "v", "v", "v"],
    });
    const ctx = new CoverEvalContext(tbl, prepareTarget(tbl, emm(polyRegression("x", "y"))));
    expect(ctx.evaluate(qf, new Conjunction([equality("m", "u")]))).toBeNaN();
  });
  it("full-dataset cover: complement empty -> NaN", () => {
    expect(ctxD.evaluate(qf, new Conjunction([]))).toBeNaN();
  });
  it("emm stats table exposes slope/intercept", () => {
    const s = emmStatsFromMask(
      prepD as never,
      ctxD.coverOf(new Conjunction([equality("grp", "s")])),
    );
    expect(s.slope).toBeCloseTo(1, 12);
    expect(s.intercept).toBeCloseTo(0, 12);
  });
});

// ---------------------------------------------------------------------------
// Generalization-aware + combined on Table A

describe("generalizationAware / gaStandard on Table A (spec §6.8)", () => {
  it("generic GA(wracc) on F AND cls=='a': q - max(0, gens) = 0.1 - 0.05 = 0.05", () => {
    // q(F∧a): cover {4,5}, n=2, p=2: 0.2*(1-0.5) = 0.1
    // q(F) = 0.05, q(cls=='a') = 5 rows {0,1,4,5,8}, p=3: 0.5*(0.6-0.5) = 0.05
    // q(∅) = 0
    const q = ctxA.evaluate(generalizationAware(wracc()), FandA);
    expect(q).toBeCloseTo(0.05, 15);
  });
  it("generic GA floors the generalization max at 0", () => {
    // sex=='M' AND cls=='b': cover {2,3}, p=1: q = 0.2*(0.5-0.5) = 0
    // gens: M: {0,1,2,3,8} p=2: 0.5*(0.4-0.5) = -0.05; b: {2,3,6,7,9} p=2: -0.05
    // max(0, -0.05, -0.05, 0) = 0 -> q_ga = 0 - 0 = 0
    const q = ctxA.evaluate(
      generalizationAware(wracc()),
      new Conjunction([equality("sex", "M"), equality("cls", "b")]),
    );
    expect(q).toBeCloseTo(0, 15);
  });
  it("gaStandard(1) on F AND cls=='a': (2/10)*(1 - max share 0.6) = 0.08", () => {
    // shares: F 3/5, a 3/5, ∅ 1/2 -> max_p = 0.6
    const q = ctxA.evaluate(gaStandard(1), FandA);
    expect(q).toBeCloseTo(0.08, 15);
  });
  it("gaStandard(1) on a depth-1 description equals wracc (max_p = p0)", () => {
    expect(ctxA.evaluate(gaStandard(1), F)).toBeCloseTo(0.05, 15);
  });
  it("gaStandard difference-strategy estimate on F (spec §6.8)", () => {
    // agg(F): min_delta_negatives = negatives(∅) - negatives(F) = 5 - 2 = 3
    // a=1 -> pos = p = 3; tau_diff = 3/(3+3) = 0.5; tau_sg = 0.6; max_p = 0.5
    // tau_max = 0.6 -> oe = (3/10)^1 * (1 - 0.6) = 0.12
    expect(ctxA.optimisticEstimate(gaStandard(1), F)).toBeCloseTo(0.12, 15);
  });
  it("gaStandard 'max' strategy picks the max-share generalization stats", () => {
    // F∧a: gens {F, a} shares 0.6 each with their aggregates ({∅}: 0.5)
    // -> picked stats have share 0.6; q = 0.2 * (1 - 0.6) = 0.08
    expect(ctxA.evaluate(gaStandard(1, "max"), FandA)).toBeCloseTo(0.08, 15);
  });
  it("gaStandard difference aggregate: CPython max is first-element sticky (spec §6.8)", () => {
    // cls=='zzz' (empty cover) sorts canonically first, so the FIRST
    // immediate generalization of (cls=='zzz' AND sex=='F') — drop-last —
    // is the empty-cover {cls=='zzz'} whose NaN positives-share seeds the
    // aggregate max. CPython max() seeds from the first element, so the
    // NaN sticks (reference agg tuple verified: max_p=nan,
    // min_delta_negatives=0). Quality is NaN (empty cover); the difference
    // estimate hits tau_diff = 0/0 — the reference raises
    // ZeroDivisionError there; ours stays NaN (the documented
    // agrees-where-the-reference-terminates relaxation).
    const dead = new Conjunction([equality("cls", "zzz"), equality("sex", "F")]);
    expect(ctxA.evaluate(gaStandard(1), dead)).toBeNaN();
    expect(ctxA.optimisticEstimate(gaStandard(1), dead)).toBeNaN();
  });
});

describe("gaStandardNumeric on Table C (spec §6.8)", () => {
  it("depth-1 k=='f': (4/8)*(7 - mean0 6) = 0.5 (aggregate = dataset stats)", () => {
    expect(ctxC.evaluate(gaStandardNumeric(1), Kf)).toBeCloseTo(0.5, 15);
  });
  it("depth-2 g=='b' AND k=='f': cover {4,5,6} mean 8; gens means: b 6, f 7, best 7", () => {
    // g=='b' rows {4,5,6,7} T=[7,5,12,0] mean 6; k=='f' mean 7; empty 6
    // aggregate picks max centroid 7 (from k=='f') -> q = (3/8)*(8-7) = 0.375
    const q = ctxC.evaluate(
      gaStandardNumeric(1),
      new Conjunction([equality("g", "b"), equality("k", "f")]),
    );
    expect(q).toBeCloseTo(0.375, 15);
  });
});

describe("combined on Table A (spec §6.9; ADJ-008)", () => {
  it("combined(wracc + 2*lift)(F) = 0.05 + 2*0.1 = 0.25", () => {
    const q = ctxA.evaluate(combined([{ qf: wracc() }, { qf: lift(), weight: 2 }]), F);
    expect(q).toBeCloseTo(0.25, 15);
  });
  it("combined estimate = weighted member estimates: 0.15 + 2*0.5 = 1.15", () => {
    // oe_wracc(F) = 0.15; oe_lift(F) = (3/10)^0*(1-0.5) = 0.5
    const oe = ctxA.optimisticEstimate(combined([{ qf: wracc() }, { qf: lift(), weight: 2 }]), F);
    expect(oe).toBeCloseTo(1.15, 15);
  });
});

// ---------------------------------------------------------------------------
// Validation errors (spec §5.2/§5.4)

describe("target validation (BRIEF §5.5)", () => {
  it("numeric target with NA raises a typed error", () => {
    const t = fromColumns({ v: [1, Number.NaN, 3], g: ["a", "b", "c"] });
    expect(() => prepareTarget(t, numeric("v"))).toThrowError(/contains NA/);
  });
  it("numeric target with Infinity raises", () => {
    const t = fromColumns({ v: [1, Number.POSITIVE_INFINITY, 3] });
    expect(() => prepareTarget(t, numeric("v"))).toThrowError(/finite/);
  });
  it("emm target on a non-numeric column raises", () => {
    const t = fromColumns({ x: ["a", "b"], y: [1, 2] });
    expect(() => prepareTarget(t, emm(polyRegression("x", "y")))).toThrowError(/numeric/);
  });
});
