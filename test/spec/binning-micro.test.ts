/**
 * Micro-fixtures for binning helpers and nominal selector construction
 * (spec §4): medianInPlace (np.median parity), equalWidthCutpoints edges,
 * and boolean-column nominal selectors (booleans are nominal, pandas
 * non-number dtype). medianInPlace is internal — deep import.
 */
import { describe, expect, it } from "vitest";
import { equalWidthCutpoints, fromColumns, nominalSelectors } from "../../src/index.js";
import { medianInPlace } from "../../src/util/math.js";

describe("medianInPlace (np.median parity)", () => {
  it("odd length → middle of the sorted values", () => {
    expect(medianInPlace(Float64Array.from([3, 1, 2]))).toBe(2);
    expect(medianInPlace(Float64Array.from([5]))).toBe(5);
  });
  it("even length → mean of the two middle values", () => {
    expect(medianInPlace(Float64Array.from([4, 1, 3, 2]))).toBe(2.5);
    expect(medianInPlace(Float64Array.from([2, 1]))).toBe(1.5);
  });
  it("empty → NaN", () => {
    expect(medianInPlace(new Float64Array(0))).toBeNaN();
  });
  it("sorts the caller's scratch in place (documented contract)", () => {
    const scratch = Float64Array.from([3, 1, 2]);
    medianInPlace(scratch);
    expect([...scratch]).toEqual([1, 2, 3]);
  });
});

describe("equalWidthCutpoints edges", () => {
  it("nbins interior cutpoints over [min, max)", () => {
    expect(equalWidthCutpoints(0, 10, 5)).toEqual([2, 4, 6, 8]);
    expect(equalWidthCutpoints(0, 1, 3)).toEqual([1 / 3, 2 / 3]);
  });
  it("degenerate ranges and nbins produce no cutpoints", () => {
    expect(equalWidthCutpoints(5, 5, 4)).toEqual([]); // min == max
    expect(equalWidthCutpoints(7, 3, 4)).toEqual([]); // min > max
    expect(equalWidthCutpoints(0, 10, 1)).toEqual([]); // single bin
  });
  it("negative and fractional ranges stay ascending", () => {
    expect(equalWidthCutpoints(-1, 1, 4)).toEqual([-0.5, 0, 0.5]);
  });
});

describe("boolean-column nominal selectors (spec §4)", () => {
  it("emits equalities in first-appearance order", () => {
    const t = fromColumns({ b: [true, false, true], y: [1, 0, 1] });
    const sels = nominalSelectors(t, { ignore: ["y"] });
    expect(sels.map((s) => `${s.kind}:${"value" in s ? s.value : ""}`)).toEqual([
      "equality:true",
      "equality:false",
    ]);
  });
  it("NA yields isNull at its first-appearance position", () => {
    const t = fromColumns({ b: [false, null, true, false] });
    const sels = nominalSelectors(t);
    expect(sels.map((s) => s.kind)).toEqual(["equality", "isNull", "equality"]);
    expect(sels.map((s) => ("value" in s ? s.value : null))).toEqual([false, null, true]);
  });
});
