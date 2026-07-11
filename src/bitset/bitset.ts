/**
 * Bitset word operations (spec §8 memory model; BRIEF §9/§11).
 *
 * Layout: Uint32Array, 32 rows per word, bit i of word w = row w*32 + i
 * (little-endian bit order). Tail bits past nRows are always zero — builders
 * enforce it and AND-only pipelines preserve it; complement() re-masks.
 *
 * Hot loops are closure-free and allocation-free; popcount is the standard
 * SWAR reduction; set-bit iteration uses ctz via Math.clz32 on isolated LSBs.
 */

export function wordsFor(nRows: number): number {
  return (nRows + 31) >>> 5;
}

/** SWAR popcount of one 32-bit word. */
export function popcount32(x: number): number {
  x = x - ((x >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  x = (x + (x >>> 4)) & 0x0f0f0f0f;
  return (x * 0x01010101) >>> 24;
}

/** Count of set bits in words[start, start+len). */
export function countRange(words: Uint32Array, start: number, len: number): number {
  let total = 0;
  const end = start + len;
  for (let w = start; w < end; w++) {
    let x = words[w]!;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    total += (x * 0x01010101) >>> 24;
  }
  return total;
}

/** dst = a AND b (all length len, at given offsets). */
export function andInto(
  dst: Uint32Array,
  dstOff: number,
  a: Uint32Array,
  aOff: number,
  b: Uint32Array,
  bOff: number,
  len: number,
): void {
  for (let i = 0; i < len; i++) dst[dstOff + i] = a[aOff + i]! & b[bOff + i]!;
}

/** popcount(a AND b) without materializing the intersection. */
export function andCount(
  a: Uint32Array,
  aOff: number,
  b: Uint32Array,
  bOff: number,
  len: number,
): number {
  let total = 0;
  for (let i = 0; i < len; i++) {
    let x = a[aOff + i]! & b[bOff + i]!;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    total += (x * 0x01010101) >>> 24;
  }
  return total;
}

/** popcount(a AND b AND c). */
export function andCount3(
  a: Uint32Array,
  aOff: number,
  b: Uint32Array,
  bOff: number,
  c: Uint32Array,
  cOff: number,
  len: number,
): number {
  let total = 0;
  for (let i = 0; i < len; i++) {
    let x = a[aOff + i]! & b[bOff + i]! & c[cOff + i]!;
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    total += (x * 0x01010101) >>> 24;
  }
  return total;
}

/**
 * Iterate set bits of words[off, off+len), calling fn(rowIndex).
 * ctz(x) = 31 - clz32(x & -x) on the isolated lowest set bit.
 */
export function forEachSetBit(
  words: Uint32Array,
  off: number,
  len: number,
  fn: (row: number) => void,
): void {
  for (let w = 0; w < len; w++) {
    let x = words[off + w]!;
    const base = w << 5;
    while (x !== 0) {
      const isolated = x & -x;
      fn(base + (31 - Math.clz32(isolated)));
      x ^= isolated;
    }
  }
}

/** Gather-sum of values at set-bit rows (f64 accumulator; used by numeric targets). */
export function gatherSum(
  words: Uint32Array,
  off: number,
  len: number,
  values: Float64Array,
): number {
  let sum = 0;
  for (let w = 0; w < len; w++) {
    let x = words[off + w]!;
    const base = w << 5;
    while (x !== 0) {
      const isolated = x & -x;
      sum += values[base + (31 - Math.clz32(isolated))]!;
      x ^= isolated;
    }
  }
  return sum;
}

/** A single bitset over nRows rows. */
export class Bitset {
  readonly nRows: number;
  readonly words: Uint32Array;

  constructor(nRows: number, words?: Uint32Array) {
    this.nRows = nRows;
    this.words = words ?? new Uint32Array(wordsFor(nRows));
  }

  static fromMask(mask: Uint8Array): Bitset {
    const bs = new Bitset(mask.length);
    const words = bs.words;
    for (let i = 0; i < mask.length; i++) {
      if (mask[i] === 1) words[i >>> 5]! |= 1 << (i & 31);
    }
    return bs;
  }

  get(row: number): boolean {
    return (this.words[row >>> 5]! & (1 << (row & 31))) !== 0;
  }

  set(row: number): void {
    this.words[row >>> 5]! |= 1 << (row & 31);
  }

  count(): number {
    return countRange(this.words, 0, this.words.length);
  }

  /** New bitset = this AND other. */
  and(other: Bitset): Bitset {
    const out = new Bitset(this.nRows);
    andInto(out.words, 0, this.words, 0, other.words, 0, this.words.length);
    return out;
  }

  /** New bitset = NOT this, tail-masked to nRows. */
  complement(): Bitset {
    const out = new Bitset(this.nRows);
    const len = this.words.length;
    for (let i = 0; i < len; i++) out.words[i] = ~this.words[i]!;
    maskTail(out.words, this.nRows);
    return out;
  }

  toMask(): Uint8Array {
    const out = new Uint8Array(this.nRows);
    forEachSetBit(this.words, 0, this.words.length, (row) => {
      if (row < this.nRows) out[row] = 1;
    });
    return out;
  }

  /** Row indices of set bits (ascending). */
  toIndices(): Uint32Array {
    const out = new Uint32Array(this.count());
    let k = 0;
    forEachSetBit(this.words, 0, this.words.length, (row) => {
      out[k++] = row;
    });
    return out;
  }
}

/** Zero all bits at positions >= nRows in the final word. */
export function maskTail(words: Uint32Array, nRows: number): void {
  const rem = nRows & 31;
  if (rem !== 0 && words.length > 0) {
    words[words.length - 1]! &= (1 << rem) - 1;
  }
}
