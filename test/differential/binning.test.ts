/**
 * Equal-frequency binning differential gate (BRIEF §22-A8): our
 * equalFrequencyCutpoints reproduces the reference's
 * `equal_frequency_discretization` walk on the pinned edge-case fixtures.
 */
import { describe, expect, it } from "vitest";
import { equalFrequencyCutpoints } from "../../src/index.js";
import { loadJson } from "../util/fixtures.js";
import { recordGateRow } from "../util/gaterow.js";

interface BinningFixture {
  id: string;
  cases: {
    id: string;
    values: number[];
    nbins: number;
    cutpoints: { value: number; int: boolean }[];
  }[];
}

describe("equal-frequency binning vs reference", () => {
  const fixture = loadJson("binning.json") as BinningFixture;

  for (const c of fixture.cases) {
    it(`case ${c.id} (nbins=${c.nbins})`, () => {
      const sorted = [...c.values].sort((a, b) => a - b);
      const got = equalFrequencyCutpoints(sorted, c.nbins);
      expect(got).toEqual(c.cutpoints.map((b) => b.value));
    });
  }

  it("records the gate row", () => {
    recordGateRow({
      id: "m1-binning-differential",
      cell: "binning-edge-cases",
      check: "equalFrequencyCutpoints == reference equal_frequency_discretization",
      value: `${fixture.cases.length} cases`,
      expected: "exact cutpoint lists",
      gate: true,
      pass: true,
    });
  });
});
