/**
 * Exhaustive-oracle micro-fixtures (spec §3.2-3.4, §7.1-7.3): the full
 * top-k ordering on Table A is worked out by hand below, including boundary
 * tie cuts, minQuality strictness, constraints, NaN exclusion, and the
 * dual-path cross-check report.
 *
 * Table A (10 rows, P=5): selectors sorted canonically =
 *   [0] cls=='a'  [1] cls=='b'  [2] sex=='F'  [3] sex=='M'
 * wracc qualities (hand-computed):
 *   F = .5*(3/5-.5) = .05        M = .5*(2/5-.5) = -.05
 *   a = .5*(3/5-.5) = .05        b = .5*(2/5-.5) = -.05
 *   F∧a {4,5} p=2  : .2*(1-.5)  = .1
 *   F∧b {6,7,9} p=1: .3*(1/3-.5)= -.05
 *   M∧a {0,1,8} p=1: .3*(1/3-.5)= -.05     (y rows 0,1,8 = 1,0,0)
 *   M∧b {2,3} p=1  : .2*(.5-.5) = 0
 *   F∧M, a∧b       : empty -> NaN (excluded)
 * §3.2 order (quality desc -> depth asc -> tuple lex asc):
 *   F∧a(.1) | a(.05)=(0) F(.05)=(2) | M∧b(0) | b(-.05)=(1) M(-.05)=(3)
 *   M∧a(-.05)=(0,3) F∧b(-.05)=(1,2)   — depth-1 before depth-2 in the tie
 *   group, then lex tuples: (0,3) < (1,2).
 */
import { describe, expect, it } from "vitest";
import {
  binary,
  type Conjunction,
  equality,
  exhaustive,
  fromColumns,
  minSupport,
  wracc,
} from "../../src/index.js";

const tableA = fromColumns({
  sex: ["M", "M", "M", "M", "F", "F", "F", "F", "M", "F"],
  cls: ["a", "a", "b", "b", "a", "a", "b", "b", "a", "b"],
  y: [1, 0, 1, 0, 1, 1, 1, 0, 0, 0],
});
const space = [
  equality("sex", "F"),
  equality("sex", "M"),
  equality("cls", "a"),
  equality("cls", "b"),
];
const base = {
  table: tableA,
  target: binary({ attribute: "y", value: 1 }),
  searchSpace: space,
  qf: wracc(),
  depth: 2,
};

function names(entries: readonly { description: Conjunction }[]): string[] {
  return entries.map((e) => e.description.toString("display"));
}

describe("exhaustive oracle on Table A (hand-computed §3.2 order)", () => {
  it("full order at k=8, minQuality=-inf", async () => {
    const res = await exhaustive({ ...base, resultSetSize: 8 });
    expect(names(res.entries)).toEqual([
      "cls=='a' AND sex=='F'", // .1
      "cls=='a'", // .05, depth 1, tuple (0)
      "sex=='F'", // .05, depth 1, tuple (2)
      "cls=='b' AND sex=='M'", // 0
      "cls=='b'", // -.05, depth 1, tuple (1)
      "sex=='M'", // -.05, depth 1, tuple (3)
      "cls=='a' AND sex=='M'", // -.05, depth 2, tuple (0,3)
      "cls=='b' AND sex=='F'", // -.05, depth 2, tuple (1,2)
    ]);
    const expected = [0.1, 0.05, 0.05, 0, -0.05, -0.05, -0.05, -0.05];
    for (let i = 0; i < expected.length; i++) {
      expect(res.entries[i]!.quality).toBeCloseTo(expected[i]!, 14);
    }
    // 4 + C(4,2) = 10 candidates evaluated, no pruning
    expect(res.candidatesEvaluated).toBe(10);
    expect(res.crossCheckReport.mode).toBe("full");
    expect(res.crossCheckReport.checked).toBe(10);
  });

  it("boundary tie at k=3 cut by tuple order (spec §3.3)", async () => {
    const res = await exhaustive({ ...base, resultSetSize: 3 });
    // .05 group: a (tuple 0) then F (tuple 2) then M∧a (0,3): k=3 keeps a, F
    expect(names(res.entries)).toEqual(["cls=='a' AND sex=='F'", "cls=='a'", "sex=='F'"]);
  });

  it("minQuality is strict: q == 0 excluded at minQuality 0", async () => {
    const res = await exhaustive({ ...base, resultSetSize: 10, minQuality: 0 });
    expect(names(res.entries)).toEqual(["cls=='a' AND sex=='F'", "cls=='a'", "sex=='F'"]);
  });

  it("minSupport(3) drops F∧a (n=2) and M∧b (n=2)", async () => {
    const res = await exhaustive({
      ...base,
      resultSetSize: 4,
      constraints: [minSupport(3)],
    });
    // eligible: a(.05,n5) F(.05,n5) b(-.05,n5) M(-.05,n5) M∧a/F∧b(-.05,n3)
    expect(names(res.entries)).toEqual(["cls=='a'", "sex=='F'", "cls=='b'", "sex=='M'"]);
  });

  it("stats table + estimate + cover on entries", async () => {
    const res = await exhaustive({ ...base, resultSetSize: 1 });
    const top = res.entries[0]!;
    expect(top.stats.size_sg).toBe(2);
    expect(top.stats.positives_sg).toBe(2);
    expect(top.stats.target_share_sg).toBe(1);
    // oe = (2/10)^1 * (1 - .5) = .1
    expect(top.optimisticEstimate).toBeCloseTo(0.1, 15);
    expect(Array.from(top.cover())).toEqual([4, 5]);
  });

  it("abort signal raises AbortedError", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      exhaustive({ ...base, signal: controller.signal }, { batchSize: 1 }),
    ).rejects.toThrowError(/aborted/);
  });

  it("progress reports evaluated counts", async () => {
    let last = -1;
    await exhaustive(
      { ...base, onProgress: (p) => (last = p.candidatesEvaluated) },
      {
        batchSize: 3,
      },
    );
    expect(last).toBeGreaterThan(0);
  });
});
