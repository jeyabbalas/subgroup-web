import { describe, expect, it } from "vitest";
import { pyFloatRepr, pyFormatFixed } from "../../src/util/pyfloat.js";

// Expected strings are CPython 3.12 outputs (verified against the pinned
// reference interpreter; see reference/ harness).
describe("pyFloatRepr matches CPython str(float)", () => {
  const cases: [number, string][] = [
    [0, "0.0"],
    [-0, "-0.0"],
    [5, "5.0"],
    [-5, "-5.0"],
    [28.5, "28.5"],
    [0.1, "0.1"],
    [1 / 3, "0.3333333333333333"],
    [1e15, "1000000000000000.0"],
    [1e16, "1e+16"],
    [1.5e16, "1.5e+16"],
    [9999999999999998, "9999999999999998.0"],
    [0.0001, "0.0001"],
    [0.00001, "1e-05"],
    [1.5e-7, "1.5e-07"],
    [1e100, "1e+100"],
    [1e-100, "1e-100"],
    [123456.789, "123456.789"],
    [2.0634920634920637, "2.0634920634920637"],
    [Number.POSITIVE_INFINITY, "inf"],
    [Number.NEGATIVE_INFINITY, "-inf"],
    [Number.NaN, "nan"],
    [-123.456e-8, "-1.23456e-06"],
    [7.62939453125e-6, "7.62939453125e-06"],
    [100.0, "100.0"],
    // 1234567890123456.7 is not representable; nearest double prints ...6.8
    [Number("1234567890123456.7"), "1234567890123456.8"],
  ];
  for (const [x, expected] of cases) {
    it(`${x} -> ${expected}`, () => {
      expect(pyFloatRepr(x)).toBe(expected);
    });
  }
});

describe('pyFormatFixed matches CPython "{:.Nf}".format', () => {
  const cases: [number, number, string][] = [
    [28.5, 2, "28.50"],
    [0.786, 2, "0.79"],
    [0.125, 2, "0.12"], // exact binary 0.125: round-half-even -> 0.12
    [0.375, 2, "0.38"], // exact binary 0.375: round-half-even -> 0.38
    [2.675, 2, "2.67"], // 2.675 is actually 2.67499999... in binary
    [-0.001, 2, "-0.00"],
    [1.005, 2, "1.00"], // 1.005 is 1.00499999... in binary
    [1e21, 2, "1000000000000000000000.00"],
    [33.755, 3, "33.755"],
    [0.5, 0, "0"], // round-half-even at integer: 0.5 -> 0
    [1.5, 0, "2"],
    [2.5, 0, "2"],
    [-28.5, 2, "-28.50"],
  ];
  for (const [x, digits, expected] of cases) {
    it(`(${x}, ${digits}) -> ${expected}`, () => {
      expect(pyFormatFixed(x, digits)).toBe(expected);
    });
  }
});
