/**
 * NaN optimistic estimates must not corrupt the best-first frontiers
 * (spec §7.7/§7.11): a NaN estimate carries no pruning information and is
 * treated as +∞ at push time. NaN in the frontier would break the
 * comparator's total order (NaN compares false both ways), letting the
 * heap-order-dependent early stop discard live subtrees. Shipped QFs never
 * produce NaN estimates on non-empty covers; custom QFs through the public
 * API can — these tests pin exactness for them.
 */
import { describe, expect, it } from "vitest";
import {
  type BinaryQF,
  bestFirst,
  binary,
  fromColumns,
  generalizingBFS,
  nominalSelectors,
  type SubgroupResults,
} from "../../src/index.js";

// 80 rows, 3 nominal columns (4+3+3 = 10 selectors), ~40% positive target.
// Seeded LCG keeps the data deterministic but irregular: covers have both
// odd and even positive counts (so the NaN branch fires) and skewed shares
// (so the top-k threshold actually prunes when estimates are finite).
const N = 80;
let lcg = 123456789;
const next = (): number => {
  lcg = (lcg * 1664525 + 1013904223) >>> 0;
  return lcg;
};
const c1: string[] = [];
const c2: string[] = [];
const c3: string[] = [];
const y: number[] = [];
for (let i = 0; i < N; i++) {
  c1.push(`a${next() % 4}`);
  c2.push(`b${next() % 3}`);
  c3.push(`c${next() % 3}`);
  y.push(next() % 5 < 2 ? 1 : 0);
}
const table = fromColumns({ c1, c2, c3, y });
const target = binary({ attribute: "y", value: 1 });
const searchSpace = nominalSelectors(table, { ignore: ["y"] });

/**
 * wracc with the standard(1) admissible estimates, except `nanWhen` makes
 * the estimate return NaN (information loss, never a wrong value — so
 * pruning-on must still be exact once NaN maps to +∞).
 */
function wraccNanEstimates(nanWhen: (size: number, positives: number) => boolean): BinaryQF {
  return {
    kind: "binary",
    name: "wracc-nan-estimates",
    pruningSafe: true,
    generalizationPruningSafe: true,
    evaluate(size, positives, c) {
      if (size === 0) return Number.NaN;
      return (size / c.n) * (positives / size - c.positives / c.n);
    },
    optimisticEstimate(size, positives, c) {
      if (nanWhen(size, positives)) return Number.NaN;
      return (positives / c.n) * (1 - c.positives / c.n);
    },
    generalizationEstimate(size, positives, c) {
      if (nanWhen(size, positives)) return Number.NaN;
      return ((size + c.positives - positives) / c.n) * (1 - c.positives / c.n);
    },
  };
}

function expectIdenticalResults(a: SubgroupResults, b: SubgroupResults): void {
  expect(a.entries.map((e) => e.description.canonicalKey())).toEqual(
    b.entries.map((e) => e.description.canonicalKey()),
  );
  for (let i = 0; i < a.entries.length; i++) {
    expect(Object.is(a.entries[i]!.quality, b.entries[i]!.quality)).toBe(true);
  }
}

const task = (qf: BinaryQF) => ({
  table,
  target,
  searchSpace,
  qf,
  resultSetSize: 3,
  depth: 3,
});

describe("NaN estimates in the bestFirst frontier (spec §7.7)", () => {
  it("mixed NaN/finite estimates: pruning-on ≡ pruning-off", async () => {
    const qf = wraccNanEstimates((_size, positives) => positives % 2 === 1);
    const on = await bestFirst(task(qf), { pruning: true });
    const off = await bestFirst(task(qf), { pruning: false });
    expect(on.entries.length).toBeGreaterThan(0);
    // The finite estimates must still engage pruning — the NaN→+∞ mapping
    // loses information only where the estimate was NaN.
    expect(on.candidatesPruned).toBeGreaterThan(0);
    expectIdenticalResults(on, off);
  });

  it("all-NaN estimates degrade to a full traversal", async () => {
    const qf = wraccNanEstimates(() => true);
    const on = await bestFirst(task(qf), { pruning: true });
    const off = await bestFirst(task(qf), { pruning: false });
    expectIdenticalResults(on, off);
    // Every estimate is +∞ after the clamp: nothing is prunable.
    expect(on.candidatesEvaluated).toBe(off.candidatesEvaluated);
    expect(on.candidatesPruned).toBe(0);
  });
});

describe("NaN generalization estimates in generalizingBFS (spec §7.11)", () => {
  it("mixed NaN/finite estimates: pruning-on ≡ pruning-off", async () => {
    const qf = wraccNanEstimates((_size, positives) => positives % 2 === 1);
    const on = await generalizingBFS(task(qf), { pruning: true });
    const off = await generalizingBFS(task(qf), { pruning: false });
    expect(on.entries.length).toBeGreaterThan(0);
    expectIdenticalResults(on, off);
  });

  it("all-NaN estimates degrade to a full traversal", async () => {
    const qf = wraccNanEstimates(() => true);
    const on = await generalizingBFS(task(qf), { pruning: true });
    const off = await generalizingBFS(task(qf), { pruning: false });
    expectIdenticalResults(on, off);
    expect(on.candidatesEvaluated).toBe(off.candidatesEvaluated);
    expect(on.candidatesPruned).toBe(0);
  });
});
