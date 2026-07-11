/**
 * Property suite: bitset engine vs a naive boolean-array model (seeds logged
 * and replayable via fast-check's default reporter output).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  andCount,
  Bitset,
  countRange,
  forEachSetBit,
  gatherSum,
  popcount32,
  wordsFor,
} from "../../src/index.js";

const maskArb = fc
  .integer({ min: 1, max: 300 })
  .chain((n) => fc.array(fc.boolean(), { minLength: n, maxLength: n }));

function toMask(bools: boolean[]): Uint8Array {
  return Uint8Array.from(bools, (b) => (b ? 1 : 0));
}

describe("bitset engine properties", () => {
  it("popcount32 matches naive bit loop", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffffff }), (x) => {
        let expected = 0;
        for (let i = 0; i < 32; i++) if ((x >>> i) & 1) expected++;
        expect(popcount32(x >>> 0)).toBe(expected);
      }),
    );
  });

  it("fromMask/toMask round-trip; count matches", () => {
    fc.assert(
      fc.property(maskArb, (bools) => {
        const mask = toMask(bools);
        const bs = Bitset.fromMask(mask);
        expect([...bs.toMask()]).toEqual([...mask]);
        expect(bs.count()).toBe(bools.filter(Boolean).length);
        expect(bs.words.length).toBe(wordsFor(bools.length));
      }),
    );
  });

  it("and + complement match boolean model; tail bits stay zero", () => {
    fc.assert(
      fc.property(maskArb, (boolsA) => {
        const boolsB = boolsA.map((_, i) => i % 3 === 0);
        const a = Bitset.fromMask(toMask(boolsA));
        const b = Bitset.fromMask(toMask(boolsB));
        const and = a.and(b);
        expect([...and.toMask()]).toEqual(boolsA.map((x, i) => (x && boolsB[i] ? 1 : 0)));
        const comp = a.complement();
        expect([...comp.toMask()]).toEqual(boolsA.map((x) => (x ? 0 : 1)));
        expect(comp.count()).toBe(boolsA.filter((x) => !x).length);
        expect(andCount(a.words, 0, b.words, 0, a.words.length)).toBe(and.count());
        expect(countRange(comp.words, 0, comp.words.length)).toBe(comp.count());
      }),
    );
  });

  it("forEachSetBit yields exactly the set rows ascending; gatherSum matches", () => {
    fc.assert(
      fc.property(maskArb, (bools) => {
        const bs = Bitset.fromMask(toMask(bools));
        const rows: number[] = [];
        forEachSetBit(bs.words, 0, bs.words.length, (r) => rows.push(r));
        const expected = bools.flatMap((b, i) => (b ? [i] : []));
        expect(rows).toEqual(expected);
        const values = Float64Array.from(bools, (_, i) => i * 1.5 + 1);
        const sum = gatherSum(bs.words, 0, bs.words.length, values);
        expect(sum).toBeCloseTo(
          expected.reduce((acc, i) => acc + values[i]!, 0),
          9,
        );
        expect([...bs.toIndices()]).toEqual(expected);
      }),
    );
  });
});
