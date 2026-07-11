/**
 * M5 §6.2 exactness gates for the full algorithm surface:
 * - dfsNumeric == oracle on every standardNumeric cell (pruning on/off,
 *   off enumerates the full space); typed applicability errors elsewhere.
 * - patternTree == oracle on every binary/FI cell (pruning on/off;
 *   evaluation-count identity inapplicable by design — the tree visits only
 *   support > 0 itemsets); FI θ<0 guard asserted.
 * - generalizingBFS == the exhaustive oracle over the DISJUNCTION space
 *   D(S, d) (pruning on/off + full-space count identity).
 * - beamSearch == its own executable spec mirror at widths {1, 20} and
 *   adaptive, bit-identical; run-to-run deterministic; width ≥ |C(S,d)| on
 *   θ = −inf cells degenerates to the oracle top-k.
 */
import { describe, expect, it } from "vitest";
import {
  beamSearch,
  candidateSpaceSize,
  dfsNumeric,
  exhaustive,
  generalizingBFS,
  patternTree,
  prepareTask,
  ValidationError,
} from "../../src/index.js";
import { beamSpecMirror } from "../util/beamspec.js";
import { buildTask, type CellSpec } from "../util/cells.js";
import { recordGateRow } from "../util/gaterow.js";
import { EXACTNESS_CELLS } from "./cells.js";
import { assertSameResults, fingerprint } from "./runner.js";

const isStandardNumeric = (c: CellSpec): boolean => c.qf.name === "standardNumeric";
const isPatternTreeable = (c: CellSpec): boolean =>
  (c.target.type === "binary" || c.target.type === "fi") &&
  ["wracc", "lift", "simpleBinomial", "standard", "chiSquared", "count", "area"].includes(
    c.qf.name,
  ) &&
  !(
    c.target.type === "fi" &&
    !((c.minQuality ?? Number.NEGATIVE_INFINITY) >= 0) &&
    !(c.constraints ?? []).some((x) => x.type === "minSupport" && x.count >= 1)
  );
const isGbfsable = (c: CellSpec): boolean =>
  !["generalizationAware", "gaStandard", "gaStandardNumeric", "combined"].includes(c.qf.name);

describe("M5 dfsNumeric == oracle (standardNumeric family)", () => {
  const cells = EXACTNESS_CELLS.filter(isStandardNumeric);
  let done = 0;
  for (const cell of cells) {
    it(cell.id, async () => {
      const oracle = await exhaustive(buildTask(cell));
      const on = await dfsNumeric(buildTask(cell));
      const off = await dfsNumeric(buildTask(cell), { pruning: false });
      assertSameResults(`${cell.id}/dfsNumeric/on`, on, oracle);
      assertSameResults(`${cell.id}/dfsNumeric/off`, off, oracle);
      expect(off.candidatesEvaluated).toBe(oracle.candidatesEvaluated);
      expect(on.candidatesEvaluated).toBeLessThanOrEqual(off.candidatesEvaluated);
      done++;
    });
  }

  it("rejects non-standardNumeric QFs with an actionable error", async () => {
    const median = EXACTNESS_CELLS.find((c) => c.qf.name === "standardNumericMedian")!;
    await expect(dfsNumeric(buildTask(median))).rejects.toThrow(ValidationError);
    await expect(dfsNumeric(buildTask(median))).rejects.toThrow(/standardNumeric/);
  });

  it("records the gate row", () => {
    recordGateRow({
      id: "m5-exactness-dfsnumeric",
      cell: "exactness-matrix (standardNumeric cells)",
      check: "dfsNumeric top-k == oracle exactly; pruning on/off identical; off = full space",
      value: `${done}/${cells.length} cells`,
      expected: `${cells.length} cells`,
      gate: true,
      pass: done === cells.length && cells.length >= 5,
    });
    expect(done).toBe(cells.length);
  });
});

describe("M5 patternTree == oracle (binary/FI targets)", () => {
  const cells = EXACTNESS_CELLS.filter(isPatternTreeable);
  let done = 0;
  let prunedSomewhere = 0;
  for (const cell of cells) {
    it(cell.id, async () => {
      const oracle = await exhaustive(buildTask(cell));
      const on = await patternTree(buildTask(cell));
      const off = await patternTree(buildTask(cell), { pruning: false });
      assertSameResults(`${cell.id}/patternTree/on`, on, oracle);
      assertSameResults(`${cell.id}/patternTree/off`, off, oracle);
      expect(on.candidatesEvaluated).toBeLessThanOrEqual(off.candidatesEvaluated);
      if (on.candidatesEvaluated < off.candidatesEvaluated) prunedSomewhere++;
      done++;
    });
  }

  it("rejects FI targets whose space admits zero-cover results (θ < 0, no minSupport)", async () => {
    const fiNegTheta = EXACTNESS_CELLS.find(
      (c) => c.target.type === "fi" && !((c.minQuality ?? Number.NEGATIVE_INFINITY) >= 0),
    )!;
    await expect(patternTree(buildTask(fiNegTheta))).rejects.toThrow(/minSupport|minQuality/);
  });

  it("rejects numeric targets with an actionable error", async () => {
    const numericCell = EXACTNESS_CELLS.find(isStandardNumeric)!;
    await expect(patternTree(buildTask(numericCell))).rejects.toThrow(/binary and frequentItemset/);
  });

  it("records the gate row", () => {
    recordGateRow({
      id: "m5-exactness-patterntree",
      cell: "exactness-matrix (binary/FI cells)",
      check:
        "patternTree top-k == oracle exactly (FP-growth merge algebra, integer-exact); " +
        "pruning on/off identical",
      value: `${done}/${cells.length} cells, pruning engaged on ${prunedSomewhere}`,
      expected: `${cells.length} cells`,
      gate: true,
      pass: done === cells.length && cells.length >= 12,
    });
    expect(done).toBe(cells.length);
  });
});

describe("M5 generalizingBFS == disjunction-space oracle", () => {
  const cells = EXACTNESS_CELLS.filter(isGbfsable).filter(
    // Keep runtime sane: EMM over D(S,d) at depth>1 is O(N) per candidate.
    (c) => !(c.target.type === "emm" && c.depth > 1),
  );
  let done = 0;
  let prunedSomewhere = 0;
  for (const cell of cells) {
    it(cell.id, async () => {
      const oracle = await exhaustive(buildTask(cell), { form: "disjunction" });
      const on = await generalizingBFS(buildTask(cell));
      const off = await generalizingBFS(buildTask(cell), { pruning: false });
      assertSameResults(`${cell.id}/generalizingBFS/on`, on, oracle);
      assertSameResults(`${cell.id}/generalizingBFS/off`, off, oracle);
      expect(off.candidatesEvaluated).toBe(oracle.candidatesEvaluated);
      expect(on.candidatesEvaluated).toBeLessThanOrEqual(off.candidatesEvaluated);
      if (on.candidatesEvaluated < off.candidatesEvaluated) prunedSomewhere++;
      done++;
    });
  }

  it("rejects description-level QFs", async () => {
    const gaCell = EXACTNESS_CELLS.find((c) => c.qf.name === "gaStandard")!;
    await expect(generalizingBFS(buildTask(gaCell))).rejects.toThrow(/disjunction/);
  });

  it("records the gate row", () => {
    // Note: for standard(a) the generalization bound is ≥ the global quality
    // maximum (spec §7.11), so §3.4 pruning provably NEVER engages mid-search
    // — `prunedSomewhere` stays 0 by mathematics, not by accident. Exactness
    // and on/off identity are the binding properties.
    recordGateRow({
      id: "m5-exactness-generalizingbfs",
      cell: "exactness-matrix (disjunction space)",
      check:
        "generalizingBFS top-k == exhaustive oracle over D(S,d) exactly; pruning-option " +
        "on/off identical; off = full space (generalization bound is vacuous for " +
        "standard(a), spec §7.11)",
      value: `${done}/${cells.length} cells (bound engaged on ${prunedSomewhere}, expected 0)`,
      expected: `${cells.length} cells`,
      gate: true,
      pass: done === cells.length && cells.length >= 20,
    });
    expect(done).toBe(cells.length);
  });
});

describe("M5 beamSearch == its own spec (widths 1, 20, adaptive)", () => {
  // Beam cells: stats-level QFs across targets incl. tie/NA stress.
  const beamCellIds = [
    "x-titanic-wracc-d2-k5",
    "x-titanic-simpleBinomial-d3-k10",
    "x-titanic-lift-minsupport-d2-k10",
    "x-creditg-stdnum-sum-d2-k10",
    "x-creditg-fi-area-d2-k10",
    "x-tie-stress-wracc-d3-k10",
    "x-na-stress-stdnum-d2-k10",
    "x-dup-rows-wracc-d3-k10",
  ];
  let comparisons = 0;
  for (const id of beamCellIds) {
    const cell = EXACTNESS_CELLS.find((c) => c.id === id)!;
    // width 1 requires k = 1 (validated); use k=1 variant for width 1.
    it(`${id} @ widths {1, 20} + adaptive`, async () => {
      const variants: { beam: { width?: number; adaptive?: boolean }; k?: number }[] = [
        { beam: { width: 1 }, k: 1 },
        { beam: { width: 20 } },
        { beam: { adaptive: true } },
      ];
      for (const variant of variants) {
        const spec = { ...cell, k: variant.k ?? cell.k };
        const engine = await beamSearch(buildTask(spec), variant.beam);
        const mirror = beamSpecMirror(buildTask(spec), variant.beam);
        const engineFp = fingerprint(engine);
        expect(
          engineFp.map((r) => `${r.key} @ ${r.quality}`),
          `${id} ${JSON.stringify(variant.beam)}: engine == spec mirror`,
        ).toEqual(mirror.map((r) => `${r.key} @ ${r.quality}`));
        // Determinism: bit-identical rerun.
        const again = await beamSearch(buildTask(spec), variant.beam);
        expect(fingerprint(again)).toEqual(engineFp);
        comparisons++;
      }
    });
  }

  it("degenerates to the oracle at width ≥ |C(S,d)| (θ = −inf cells)", async () => {
    for (const id of ["x-tie-stress-wracc-d3-k10", "x-dup-rows-wracc-d3-k10"]) {
      const cell = EXACTNESS_CELLS.find((c) => c.id === id)!;
      const task = prepareTask(buildTask(cell));
      const width = candidateSpaceSize(task.selectors.length, task.depth);
      const oracle = await exhaustive(buildTask(cell));
      const wide = await beamSearch(buildTask(cell), { width });
      assertSameResults(`${id}/beam-wide`, wide, oracle);
    }
  });

  it("validates width >= k (reference raises too)", async () => {
    const cell = EXACTNESS_CELLS.find((c) => c.id === "x-titanic-wracc-d2-k5")!;
    await expect(beamSearch(buildTask(cell), { width: 2 })).rejects.toThrow(/width/);
  });

  it("records the gate row", () => {
    recordGateRow({
      id: "m5-beam-spec",
      cell: "beam cells",
      check:
        "beamSearch == executable spec mirror at widths {1, 20} + adaptive (bit-identical), " +
        "deterministic across runs; width ≥ |C| degenerates to oracle",
      value: `${comparisons} engine-vs-mirror comparisons over ${beamCellIds.length} cells`,
      expected: `${beamCellIds.length * 3} comparisons`,
      gate: true,
      pass: comparisons === beamCellIds.length * 3,
    });
    expect(comparisons).toBe(beamCellIds.length * 3);
  });
});
