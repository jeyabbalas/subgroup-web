/**
 * Property suite: the selector atlas agrees bit-for-bit with the row-scan
 * cover path on random tables (categorical + numeric columns, NAs,
 * negations), and every row keeps its tail-word bits ≥ nRows at 0 — the
 * invariant the fused AND+popcount kernels trust (they never re-mask).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildAtlas } from "../../src/bitset/atlas.js";
import { allSelectors, Conjunction, fromColumns } from "../../src/index.js";

const tableArb = fc.integer({ min: 1, max: 100 }).chain((n) =>
  fc.record({
    cat: fc.array(fc.option(fc.constantFrom("a", "b", "c"), { nil: null }), {
      minLength: n,
      maxLength: n,
    }),
    num: fc.array(fc.option(fc.integer({ min: 0, max: 6 }), { nil: null }), {
      minLength: n,
      maxLength: n,
    }),
    negations: fc.boolean(),
  }),
);

describe("atlas vs row-scan cover (BRIEF §6.1 dual paths)", () => {
  it("every selector row: tail bits zero, bits == row-scan mask, popcount matches", () => {
    fc.assert(
      fc.property(tableArb, ({ cat, num, negations }) => {
        const table = fromColumns({ cat, num });
        const selectors = allSelectors(table, { negations });
        const atlas = buildAtlas(table, selectors);
        const w = atlas.wordsPerRow;
        const n = table.nRows;
        const lastMask = n % 32 === 0 ? 0xffffffff : (1 << (n & 31)) - 1;

        for (let s = 0; s < selectors.length; s++) {
          const row = atlas.row(s);
          // Tail-word bits at positions ≥ nRows stay 0.
          expect((row[w - 1]! & ~lastMask) >>> 0).toBe(0);

          // Bit-for-bit agreement with the independent row-scan cover.
          const mask = new Conjunction([selectors[s]!]).covers(table);
          const got = new Uint8Array(n);
          for (let i = 0; i < n; i++) got[i] = (row[i >>> 5]! >>> (i & 31)) & 1;
          expect(got).toEqual(mask);

          // SWAR popcount (countRange — the kernels' counting path).
          let expected = 0;
          for (let i = 0; i < n; i++) expected += mask[i]!;
          expect(atlas.countOf(s)).toBe(expected);
        }
      }),
      { numRuns: 60 },
    );
  });
});
