/**
 * Spec §1.2 NA policy micro-fixtures (hand-computed truth tables).
 *
 * Table (5 rows):
 *   x:   [1.0, 2.0, NaN, 1.0, 3.0]   numeric with NA at row 2
 *   cat: ["a", null, "b", "a", "b"]  categorical with NA at row 1
 *
 * Policy: NA satisfies no selector — equality, interval, or NEGATION
 * (cover(¬s) = validity \ cover(s)); isNull covers exactly the NA rows.
 * The negation rule deliberately diverges from the reference's logical_not
 * (which covers NA); adjudicated as ADJ-003 with repro
 * reference/repros/adj_003_negation_na.py.
 */
import { describe, expect, it } from "vitest";
import {
  equality,
  fromColumns,
  interval,
  isNull,
  negated,
  selectorCover,
  validityMask,
} from "../../src/index.js";

const table = fromColumns({
  x: [1.0, 2.0, Number.NaN, 1.0, 3.0],
  cat: ["a", null, "b", "a", "b"],
});

function cover(sel: Parameters<typeof selectorCover>[1]): number[] {
  return [...selectorCover(table, sel)];
}

describe("NA policy (spec §1.2)", () => {
  it("equality never covers NA", () => {
    expect(cover(equality("x", 1.0))).toEqual([1, 0, 0, 1, 0]);
    expect(cover(equality("cat", "a"))).toEqual([1, 0, 0, 1, 0]);
    expect(cover(equality("cat", "b"))).toEqual([0, 0, 1, 0, 1]);
  });

  it("interval never covers NA (NaN comparisons are false)", () => {
    expect(cover(interval("x", 0, 10))).toEqual([1, 1, 0, 1, 1]);
    expect(cover(interval("x", Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY))).toEqual([
      1, 1, 0, 1, 1,
    ]);
    expect(cover(interval("x", 2, Number.POSITIVE_INFINITY))).toEqual([0, 1, 0, 0, 1]);
  });

  it("interval bounds are [lo, hi): left-closed, right-open", () => {
    expect(cover(interval("x", 1, 2))).toEqual([1, 0, 0, 1, 0]); // 2.0 excluded
    expect(cover(interval("x", 1, 2.0000001))).toEqual([1, 1, 0, 1, 0]);
    expect(cover(interval("x", Number.NEGATIVE_INFINITY, 3))).toEqual([1, 1, 0, 1, 0]);
    expect(cover(interval("x", 3, Number.POSITIVE_INFINITY))).toEqual([0, 0, 0, 0, 1]);
  });

  it("isNull covers exactly the NA rows", () => {
    expect(cover(isNull("x"))).toEqual([0, 0, 1, 0, 0]);
    expect(cover(isNull("cat"))).toEqual([0, 1, 0, 0, 0]);
  });

  it("negation covers valid rows not covered — never NA (ADJ-003)", () => {
    // Reference (pandas logical_not) would give [0,1,1,0,1] for NOT x==1.0:
    // the NaN row 2 covered. Spec says NA satisfies no selector:
    expect(cover(negated(equality("x", 1.0)))).toEqual([0, 1, 0, 0, 1]);
    expect(cover(negated(equality("cat", "a")))).toEqual([0, 0, 1, 0, 1]);
    expect(cover(negated(interval("x", 0, 10)))).toEqual([0, 0, 0, 0, 0]);
    expect(cover(negated(interval("x", 2, 3)))).toEqual([1, 0, 0, 1, 1]);
  });

  it("negated(isNull) covers exactly the valid rows", () => {
    expect(cover(negated(isNull("x")))).toEqual([1, 1, 0, 1, 1]);
    expect(cover(negated(isNull("cat")))).toEqual([1, 0, 1, 1, 1]);
  });

  it("double negation restricted to valid rows", () => {
    // ¬¬s = V \ (V \ cover(s)) = cover(s) since cover(s) ⊆ V.
    expect(cover(negated(negated(equality("x", 1.0))))).toEqual(cover(equality("x", 1.0)));
  });

  it("validity masks", () => {
    expect([...validityMask(table, "x")]).toEqual([1, 1, 0, 1, 1]);
    expect([...validityMask(table, "cat")]).toEqual([1, 0, 1, 1, 1]);
  });

  it("type-mismatched equality covers nothing", () => {
    expect(cover(equality("x", "1"))).toEqual([0, 0, 0, 0, 0]);
    expect(cover(equality("cat", 1))).toEqual([0, 0, 0, 0, 0]);
  });
});
