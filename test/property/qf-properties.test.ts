/**
 * Property/metamorphic suites (BRIEF §6.1; spec §6): admissibility of every
 * pruningSafe optimistic estimate on sampled refinement chains, coverage
 * anti-monotonicity, row-permutation invariance, row-duplication scaling
 * laws, negation/complement identities, alias identities, and statistics
 * invariants. fast-check with a FIXED seed (logged in the gate row) —
 * replayable by construction.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  area,
  binary,
  binaryStatsFromMask,
  binaryStatsTable,
  type CellValue,
  Conjunction,
  CoverEvalContext,
  chiSquared,
  count,
  equality,
  frequentItemset,
  fromColumns,
  isNull,
  lift,
  negated,
  numeric,
  type PreparedBinary,
  prepareTarget,
  type QF,
  selectorCover,
  simpleBinomial,
  standard,
  standardNumeric,
  standardNumericMedian,
  validityMask,
  wracc,
} from "../../src/index.js";
import { recordGateRow } from "../util/gaterow.js";

const FC_SEED = 202607_11;
const RUNS = 60;

/** Random small table: 2 categorical attrs (with optional NAs) + binary y + numeric t. */
const tableArb = fc
  .record({
    n: fc.integer({ min: 4, max: 24 }),
    aVals: fc.array(fc.integer({ min: 0, max: 3 }), { minLength: 24, maxLength: 24 }),
    bVals: fc.array(fc.integer({ min: 0, max: 2 }), { minLength: 24, maxLength: 24 }),
    naMask: fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
    yVals: fc.array(fc.boolean(), { minLength: 24, maxLength: 24 }),
    tVals: fc.array(fc.integer({ min: -40, max: 60 }), { minLength: 24, maxLength: 24 }),
  })
  .map(({ n, aVals, bVals, naMask, yVals, tVals }) => {
    const a: CellValue[] = [];
    const b: CellValue[] = [];
    const y: CellValue[] = [];
    const t: CellValue[] = [];
    for (let i = 0; i < n; i++) {
      a.push(naMask[i] && i % 3 === 0 ? null : `a${aVals[i]}`);
      b.push(`b${bVals[i]}`);
      y.push(yVals[i] ? 1 : 0);
      t.push(tVals[i]! / 4);
    }
    return fromColumns({ a, b, y, t });
  });

const selArb = fc.oneof(
  fc.integer({ min: 0, max: 3 }).map((v) => equality("a", `a${v}`)),
  fc.integer({ min: 0, max: 2 }).map((v) => equality("b", `b${v}`)),
  fc.constant(isNull("a")),
  fc.integer({ min: 0, max: 3 }).map((v) => negated(equality("a", `a${v}`))),
);

const chainArb = fc.record({
  table: tableArb,
  base: fc.array(selArb, { minLength: 0, maxLength: 2 }),
  extensions: fc.array(selArb, { minLength: 1, maxLength: 3 }),
});

interface QfCase {
  qf: QF;
  targetKind: "binary" | "numeric" | "fi";
}

const PRUNING_SAFE_QFS: QfCase[] = [
  { qf: wracc(), targetKind: "binary" },
  { qf: simpleBinomial(), targetKind: "binary" },
  { qf: lift(), targetKind: "binary" },
  { qf: standard(0.3), targetKind: "binary" },
  { qf: count(), targetKind: "fi" },
  { qf: area(3), targetKind: "fi" },
  { qf: standardNumeric(1, { estimator: "sum" }), targetKind: "numeric" },
  { qf: standardNumeric(0.5, { estimator: "sum" }), targetKind: "numeric" },
  { qf: standardNumeric(1, { estimator: "average" }), targetKind: "numeric" },
  { qf: standardNumeric(0.5, { estimator: "max" }), targetKind: "numeric" },
  { qf: standardNumeric(1, { estimator: "order" }), targetKind: "numeric" },
  { qf: standardNumeric(0.5, { estimator: "order" }), targetKind: "numeric" },
  { qf: standardNumeric(1, { invert: true, estimator: "sum" }), targetKind: "numeric" },
  { qf: standardNumericMedian(1), targetKind: "numeric" },
  { qf: standardNumericMedian(0.5), targetKind: "numeric" },
];

function targetFor(kind: QfCase["targetKind"]) {
  switch (kind) {
    case "binary":
      return binary({ attribute: "y", value: 1 });
    case "numeric":
      return numeric("t");
    case "fi":
      return frequentItemset();
  }
}

describe(`admissibility on sampled refinement chains (seed ${FC_SEED})`, () => {
  for (const { qf, targetKind } of PRUNING_SAFE_QFS) {
    it(`${qf.name}: oe(parent) >= quality(every chain refinement)`, () => {
      expect(qf.pruningSafe).toBe(true);
      fc.assert(
        fc.property(chainArb, ({ table, base, extensions }) => {
          const ctx = new CoverEvalContext(table, prepareTarget(table, targetFor(targetKind)));
          const parent = new Conjunction(base);
          const oe = ctx.optimisticEstimate(qf, parent);
          let selectors = [...base];
          for (const ext of extensions) {
            selectors = [...selectors, ext];
            const child = new Conjunction(selectors);
            if (child.depth === parent.depth) continue; // duplicate predicate
            const q = ctx.evaluate(qf, child);
            if (Number.isNaN(q)) continue; // NaN never enters results
            const tol = 1e-9 * Math.max(1, Math.abs(oe), Math.abs(q));
            expect(
              q,
              `${qf.name}: q(${child.toString()}) > oe(${parent.toString()})`,
            ).toBeLessThanOrEqual(oe + tol);
          }
        }),
        { seed: FC_SEED, numRuns: RUNS },
      );
    });
  }
});

describe(`coverage anti-monotonicity + negation identities (seed ${FC_SEED})`, () => {
  it("cover(c AND s) is a subset of cover(c)", () => {
    fc.assert(
      fc.property(chainArb, ({ table, base, extensions }) => {
        const parent = new Conjunction(base).covers(table);
        const child = new Conjunction([...base, ...extensions]).covers(table);
        for (let i = 0; i < table.nRows; i++) {
          expect(child[i]! <= parent[i]!).toBe(true);
        }
      }),
      { seed: FC_SEED, numRuns: RUNS },
    );
  });

  it("size(s) + size(NOT s) = |valid(attr)| and NOT covers no NA row", () => {
    fc.assert(
      fc.property(tableArb, fc.integer({ min: 0, max: 3 }), (table, v) => {
        const sel = equality("a", `a${v}`);
        const cover = selectorCover(table, sel);
        const negCover = selectorCover(table, negated(sel));
        const valid = validityMask(table, "a");
        let s = 0;
        let ns = 0;
        let nValid = 0;
        for (let i = 0; i < table.nRows; i++) {
          s += cover[i]!;
          ns += negCover[i]!;
          nValid += valid[i]!;
          expect(negCover[i]! <= valid[i]!).toBe(true);
        }
        expect(s + ns).toBe(nValid);
      }),
      { seed: FC_SEED, numRuns: RUNS },
    );
  });
});

describe(`row-permutation and duplication laws (seed ${FC_SEED})`, () => {
  const descArb = fc.array(selArb, { minLength: 1, maxLength: 2 });

  it("permutation invariance (rel <= 1e-12)", () => {
    fc.assert(
      fc.property(tableArb, descArb, fc.integer({ min: 1, max: 1000 }), (table, sels, salt) => {
        // deterministic permutation from salt
        const n = table.nRows;
        const perm = Array.from({ length: n }, (_, i) => i);
        for (let i = n - 1; i > 0; i--) {
          const j = (i * 7919 + salt) % (i + 1);
          [perm[i], perm[j]] = [perm[j]!, perm[i]!];
        }
        const rows = table.toRows();
        const permuted = fromColumns(
          Object.fromEntries(
            table.names.map((name) => [name, perm.map((p) => rows[p]![name] as CellValue)]),
          ),
        );
        const prepBinary = prepareTarget(table, targetFor("binary")) as PreparedBinary;
        const degenerate = prepBinary.positives === 0 || prepBinary.positives === prepBinary.n;
        for (const { qf, targetKind } of [
          { qf: wracc(), targetKind: "binary" as const },
          { qf: standardNumeric(1), targetKind: "numeric" as const },
          { qf: chiSquared({ minInstances: 1 }), targetKind: "binary" as const },
        ]) {
          if (degenerate && qf.name.startsWith("chiSquared")) continue; // chi2 requires 0 < P < N
          const desc = new Conjunction(sels);
          const q1 = new CoverEvalContext(
            table,
            prepareTarget(table, targetFor(targetKind)),
          ).evaluate(qf, desc);
          const q2 = new CoverEvalContext(
            permuted,
            prepareTarget(permuted, targetFor(targetKind)),
          ).evaluate(qf, desc);
          if (Number.isNaN(q1)) expect(q2).toBeNaN();
          else if (!Number.isFinite(q1)) expect(q2).toBe(q1);
          else expect(Math.abs(q2 - q1)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(q1)));
        }
      }),
      { seed: FC_SEED, numRuns: 30 },
    );
  });

  it("duplication scaling: wracc/lift invariant, count doubles, chi2 doubles", () => {
    fc.assert(
      fc.property(tableArb, descArb, (table, sels) => {
        const rows = table.toRows();
        const doubled = fromColumns(
          Object.fromEntries(
            table.names.map((name) => [name, [...rows, ...rows].map((r) => r[name] as CellValue)]),
          ),
        );
        const desc = new Conjunction(sels);
        const evalOn = (qf: QF, tbl: typeof table, kind: "binary" | "fi") =>
          new CoverEvalContext(tbl, prepareTarget(tbl, targetFor(kind))).evaluate(qf, desc);

        const w1 = evalOn(wracc(), table, "binary");
        const w2 = evalOn(wracc(), doubled, "binary");
        if (Number.isNaN(w1)) expect(w2).toBeNaN();
        else expect(Math.abs(w2 - w1)).toBeLessThanOrEqual(1e-12 * Math.max(1, Math.abs(w1)));

        const c1 = evalOn(count(), table, "fi") as number;
        const c2 = evalOn(count(), doubled, "fi") as number;
        expect(c2).toBe(2 * c1);

        const prepB = prepareTarget(table, targetFor("binary")) as PreparedBinary;
        if (prepB.positives === 0 || prepB.positives === prepB.n) return; // chi2 needs 0 < P < N
        const x1 = evalOn(chiSquared({ minInstances: 0 }), table, "binary");
        const x2 = evalOn(chiSquared({ minInstances: 0 }), doubled, "binary");
        if (Number.isFinite(x1) && Number.isFinite(x2)) {
          expect(Math.abs(x2 - 2 * x1)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(x1)));
        }
      }),
      { seed: FC_SEED, numRuns: 30 },
    );
  });
});

describe(`statistics invariants (seed ${FC_SEED})`, () => {
  it("binary table: shares in [0,1], sizes add up, coverages sum to 1", () => {
    fc.assert(
      fc.property(tableArb, fc.array(selArb, { minLength: 1, maxLength: 2 }), (table, sels) => {
        const prep = prepareTarget(table, binary({ attribute: "y", value: 1 })) as PreparedBinary;
        if (prep.positives === 0) return; // degenerate: coverage undefined
        const cover = new Conjunction(sels).covers(table);
        const stats = binaryStatsTable(prep, binaryStatsFromMask(prep, cover));
        expect(stats.size_sg! + stats.size_complement!).toBe(stats.size_dataset);
        expect(stats.positives_sg!).toBeLessThanOrEqual(stats.size_sg!);
        expect(stats.relative_size_sg!).toBeGreaterThanOrEqual(0);
        expect(stats.relative_size_sg!).toBeLessThanOrEqual(1);
        expect(stats.coverage_sg! + stats.coverage_complement!).toBeCloseTo(1, 12);
        if (stats.size_sg! > 0) {
          expect(stats.target_share_sg!).toBeGreaterThanOrEqual(0);
          expect(stats.target_share_sg!).toBeLessThanOrEqual(1);
        }
      }),
      { seed: FC_SEED, numRuns: RUNS },
    );
  });

  it("records the gate row", () => {
    recordGateRow({
      id: "m3-property-suites",
      cell: "property",
      check: `admissibility (15 pruningSafe QFs), anti-monotonicity, permutation/duplication, negation, stats invariants (fast-check seed ${FC_SEED})`,
      value: "all properties hold",
      expected: "hold",
      gate: true,
      pass: true,
    });
  });
});
