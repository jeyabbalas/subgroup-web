/**
 * Direct coverage of the canonical top-k structure and the frontier heap
 * (spec §3.2–§3.4) — previously exercised only through whole-engine gates.
 * Internals import via deep paths (they are not part of the public barrel).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { BinaryHeap } from "../../src/search/heap.js";
import { compareItems, TopK } from "../../src/search/topk.js";

const t = (...ids: number[]): Uint16Array => Uint16Array.from(ids);

describe("TopK canonical order (spec §3.2)", () => {
  it("ties break depth asc → tuple lex asc", () => {
    const topk = new TopK(3, Number.NEGATIVE_INFINITY);
    topk.add(0.5, t(1));
    topk.add(0.5, t(0, 1));
    topk.add(0.5, t(2));
    topk.add(0.5, t(0));
    const tuples = topk.toArray().map((i) => [...i.tuple]);
    // depth-1 tuples beat the depth-2 one; lex among equals.
    expect(tuples).toEqual([[0], [1], [2]]);
  });

  it("retained set is insertion-order invariant (fast-check)", () => {
    const items: [number, number[]][] = [
      [0.9, [0]],
      [0.9, [3]],
      [0.5, [1, 2]],
      [0.5, [1]],
      [0.5, [0, 2]],
      [0.1, [2]],
      [Number.NaN, [4]],
      [0.9, [2, 3]],
    ];
    const canonical = (order: number[]): string => {
      const topk = new TopK(4, 0);
      for (const idx of order) topk.add(items[idx]![0], t(...items[idx]![1]));
      return JSON.stringify(topk.toArray().map((i) => [i.quality, [...i.tuple]]));
    };
    const baseline = canonical(items.map((_, i) => i));
    fc.assert(
      fc.property(
        fc.shuffledSubarray(
          items.map((_, i) => i),
          { minLength: items.length },
        ),
        (order) => {
          expect(canonical(order)).toBe(baseline);
        },
      ),
    );
  });

  it("membership needs quality > minQuality strictly; NaN never enters", () => {
    const topk = new TopK(3, 0.5);
    expect(topk.add(0.5, t(0))).toBe(false);
    expect(topk.add(Number.NaN, t(1))).toBe(false);
    expect(topk.add(0.5000001, t(2))).toBe(true);
    expect(topk.size).toBe(1);
  });
});

describe("TopK shouldPrune (spec §3.4)", () => {
  it("inclusive at θ (oe ≤ minQuality prunes even when not full)", () => {
    const topk = new TopK(3, 0.1);
    expect(topk.shouldPrune(0.1)).toBe(true);
    expect(topk.shouldPrune(0.10000001)).toBe(false);
    expect(topk.shouldPrune(Number.NaN)).toBe(false);
  });

  it("strict < at the kth quality once full", () => {
    const topk = new TopK(2, Number.NEGATIVE_INFINITY);
    topk.add(0.8, t(0));
    expect(topk.shouldPrune(0.4)).toBe(false); // not full yet
    topk.add(0.4, t(1));
    expect(topk.full).toBe(true);
    expect(topk.shouldPrune(0.4)).toBe(false); // == kth: NOT prunable
    expect(topk.shouldPrune(0.3999999)).toBe(true);
  });
});

describe("TopK couldAdmit (the §12 screening predicate)", () => {
  const offerArb = fc.record({
    quality: fc.oneof(
      fc.double({ min: -1, max: 1, noNaN: true }),
      fc.constant(Number.NaN),
      fc.constant(0),
    ),
    tuple: fc.array(fc.nat({ max: 6 }), { minLength: 1, maxLength: 3 }),
  });

  it("couldAdmit(q, t) ≡ add(q, t) on a clone (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.array(offerArb, { maxLength: 20 }),
        offerArb,
        fc.integer({ min: 1, max: 4 }),
        (setup, probe, k) => {
          const topk = new TopK(k, 0);
          const clone = new TopK(k, 0);
          for (const o of setup) {
            const sorted = [...o.tuple].sort((a, b) => a - b);
            topk.add(o.quality, t(...sorted));
            clone.add(o.quality, t(...sorted));
          }
          const sorted = [...probe.tuple].sort((a, b) => a - b);
          expect(topk.couldAdmit(probe.quality, t(...sorted))).toBe(
            clone.add(probe.quality, t(...sorted)),
          );
        },
      ),
    );
  });

  it("couldAdmit is monotone in quality for a fixed tuple (fast-check)", () => {
    fc.assert(
      fc.property(
        fc.array(offerArb, { maxLength: 20 }),
        fc.array(fc.nat({ max: 6 }), { minLength: 1, maxLength: 3 }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        (setup, tuple, q, bump) => {
          const topk = new TopK(3, 0);
          for (const o of setup) topk.add(o.quality, t(...[...o.tuple].sort((a, b) => a - b)));
          const sorted = [...tuple].sort((a, b) => a - b);
          // If the lower quality could enter, the higher one must too.
          if (topk.couldAdmit(q, t(...sorted))) {
            expect(topk.couldAdmit(q + bump, t(...sorted))).toBe(true);
          }
        },
      ),
    );
  });
});

describe("BinaryHeap (spec §7 frontier determinism)", () => {
  it("pop sequence equals the sorted push multiset under a total order (fast-check)", () => {
    // Pairs (value, seq) with a total-order comparator — duplicates in
    // `value` stay distinct overall, like frontier nodes.
    fc.assert(
      fc.property(fc.array(fc.integer({ min: -50, max: 50 }), { maxLength: 60 }), (values) => {
        const items = values.map((v, seq) => ({ v, seq }));
        const cmp = (a: { v: number; seq: number }, b: { v: number; seq: number }): number =>
          a.v !== b.v ? a.v - b.v : a.seq - b.seq;
        const heap = new BinaryHeap(cmp);
        for (const it of items) heap.push(it);
        expect(heap.size).toBe(items.length);
        const popped: { v: number; seq: number }[] = [];
        for (;;) {
          const top = heap.pop();
          if (top === undefined) break;
          popped.push(top);
        }
        expect(popped).toEqual([...items].sort(cmp));
        expect(heap.pop()).toBeUndefined();
      }),
    );
  });

  it("compareItems orders quality desc → depth asc → lex asc", () => {
    expect(compareItems(0.9, t(5), 0.1, t(0))).toBeLessThan(0);
    expect(compareItems(0.5, t(1), 0.5, t(0, 1))).toBeLessThan(0);
    expect(compareItems(0.5, t(0, 2), 0.5, t(0, 1))).toBeGreaterThan(0);
    expect(compareItems(0.5, t(0, 1), 0.5, t(0, 1))).toBe(0);
  });
});
