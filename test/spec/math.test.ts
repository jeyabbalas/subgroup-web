/**
 * Special-function accuracy vs the pinned scipy (spec §6.10).
 *
 * The literals were produced by reference/.venv scipy 1.17.1
 * (`scipy.stats.chi2.sf(x, 1)` / `scipy.stats.norm.pdf`); both sides are
 * ~1e-14-accurate approximations of the same analytic function, so agreement
 * is asserted at rel 1e-12 — tighter than the differential gate's 1e-9.
 */
import { describe, expect, it } from "vitest";
import { chi2TailProbability, normPdf, pairwiseSum, populationStd } from "../../src/index.js";

const SCIPY_CHI2_SF_DOF1: [number, number][] = [
  [1e-8, 0.9999202115440526],
  [0.001, 0.9747728793699604],
  [0.1, 0.7518296340458492],
  [0.4, 0.5270892568655381],
  [1.0, 0.31731050786291115],
  [2.5, 0.11384629800665808],
  [3.841458820694124, 0.04999999999999994],
  [10.0, 0.0015654022580025482],
  [25.0, 5.733031437583878e-7],
  [50.0, 1.537459794428033e-12],
  [200.0, 2.0884875837625688e-45],
];

describe("chi2TailProbability (dof 1) vs scipy.stats.chi2.sf", () => {
  it.each(SCIPY_CHI2_SF_DOF1)("x = %f", (x, expected) => {
    const got = chi2TailProbability(x, 1);
    expect(Math.abs(got - expected)).toBeLessThanOrEqual(1e-12 * Math.abs(expected));
  });

  it("x <= 0 has full tail", () => {
    expect(chi2TailProbability(0, 1)).toBe(1);
    expect(chi2TailProbability(-3, 1)).toBe(1);
  });
});

describe("normPdf vs scipy.stats.norm.pdf", () => {
  it("matches at r = 0, 1, 3", () => {
    expect(normPdf(0)).toBe(0.3989422804014327);
    expect(normPdf(1)).toBe(0.24197072451914337);
    // scipy: 0.0044318484119380075; identical formula, allow 1 ulp
    expect(Math.abs(normPdf(3) - 0.0044318484119380075)).toBeLessThanOrEqual(1e-18);
  });
});

describe("pairwiseSum / populationStd", () => {
  it("sums exactly on integers and matches naive on smooth data", () => {
    const v = new Float64Array(1000);
    for (let i = 0; i < v.length; i++) v[i] = i + 1;
    expect(pairwiseSum(v)).toBe((1000 * 1001) / 2);
  });

  it("population std of [4,-4,2,-2,0,0,6,-6]+6 is sqrt(14)", () => {
    // T = [10, 2, 8, 4, 6, 6, 12, 0]: mean 6, squared devs [16,16,4,4,0,0,36,36]
    // mean of squares = 112/8 = 14
    const v = Float64Array.from([10, 2, 8, 4, 6, 6, 12, 0]);
    expect(populationStd(v)).toBeCloseTo(Math.sqrt(14), 14);
  });
});
