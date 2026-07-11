/**
 * Metamorphic identity backing ADJ-005 (spec §6.3): standardNumeric with
 * invert on target T equals standardNumeric without invert on target −T —
 * for qualities AND optimistic estimates, across estimators, on seeded
 * random tables.
 */
import { describe, expect, it } from "vitest";
import {
  Conjunction,
  CoverEvalContext,
  equality,
  fromColumns,
  numeric,
  Pcg32,
  prepareTarget,
  standardNumeric,
  standardNumericMedian,
} from "../../src/index.js";

const SEED = 20260711n;

function randomTable(rng: Pcg32, n: number) {
  const t = new Array<number>(n);
  const negT = new Array<number>(n);
  const g = new Array<string>(n);
  for (let i = 0; i < n; i++) {
    const v = Math.round(rng.nextFloat() * 200 - 100) / 4;
    t[i] = v;
    negT[i] = -v;
    g[i] = `g${rng.nextBounded(5)}`;
  }
  return {
    plus: fromColumns({ T: t, g }),
    minus: fromColumns({ T: negT, g }),
  };
}

describe("invert metamorphic identity (ADJ-005, spec §6.3)", () => {
  const rng = new Pcg32(SEED);
  for (let round = 0; round < 5; round++) {
    const n = 16 + rng.nextBounded(48);
    const { plus, minus } = randomTable(rng, n);
    for (const estimator of ["sum", "average", "order"] as const) {
      for (const a of [0, 0.5, 1]) {
        it(`round ${round}: a=${a} estimator=${estimator} (n=${n})`, () => {
          const qfInv = standardNumeric(a, { invert: true, estimator });
          const qfNeg = standardNumeric(a, { estimator });
          const ctxInv = new CoverEvalContext(plus, prepareTarget(plus, numeric("T")));
          const ctxNeg = new CoverEvalContext(minus, prepareTarget(minus, numeric("T")));
          for (let k = 0; k < 5; k++) {
            const desc = new Conjunction([equality("g", `g${k}`)]);
            const qi = ctxInv.evaluate(qfInv, desc);
            const qn = ctxNeg.evaluate(qfNeg, desc);
            if (Number.isNaN(qi)) expect(qn).toBeNaN();
            else expect(qi).toBeCloseTo(qn, 10);
            const oi = ctxInv.optimisticEstimate(qfInv, desc);
            const on = ctxNeg.optimisticEstimate(qfNeg, desc);
            expect(oi).toBeCloseTo(on, 10);
          }
        });
      }
    }
  }

  it("median centroid inverts through the same identity", () => {
    const { plus, minus } = randomTable(new Pcg32(SEED + 1n), 40);
    const ctxInv = new CoverEvalContext(plus, prepareTarget(plus, numeric("T")));
    const ctxNeg = new CoverEvalContext(minus, prepareTarget(minus, numeric("T")));
    for (let k = 0; k < 5; k++) {
      const desc = new Conjunction([equality("g", `g${k}`)]);
      const qi = ctxInv.evaluate(standardNumericMedian(1, { invert: true }), desc);
      const qn = ctxNeg.evaluate(standardNumericMedian(1), desc);
      if (Number.isNaN(qi)) expect(qn).toBeNaN();
      else expect(qi).toBeCloseTo(qn, 10);
    }
  });
});
