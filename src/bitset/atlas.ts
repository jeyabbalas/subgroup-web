/**
 * Selector-bitset atlas (BRIEF §9/§10): one bitset per selector over the
 * task's table, stored contiguously (selector-major) in a single Uint32Array.
 * Built once per task; conjunction covers are word-wise ANDs of atlas rows.
 *
 * Column-aware fast paths: one pass per categorical/boolean column fills all
 * of that column's equality/isNull selectors; numeric columns evaluate their
 * selector predicates per row. Negations derive from the inner selector's
 * bits and the column validity mask (spec §1.2 NA policy).
 *
 * This is statistics path #2; test/exactness cross-checks it row-for-row
 * against the row-scan path (src/desc/cover.ts) on every fixture (BRIEF §6.1).
 */

import { conjunctionCover } from "../desc/cover.js";
import type { Selector } from "../desc/selector.js";
import { selectorAttribute, selectorKey } from "../desc/selector.js";
import { ValidationError } from "../errors.js";
import type { DataTable } from "../table/table.js";
import { andInto, countRange, maskTail, wordsFor } from "./bitset.js";

export class SelectorAtlas {
  readonly nRows: number;
  /** Words per bitset row. */
  readonly wordsPerRow: number;
  /** Contiguous selector-major bit matrix: selectors.length × wordsPerRow. */
  readonly bits: Uint32Array;
  readonly selectors: readonly Selector[];
  /** Validity (non-NA) bitsets per attribute name. */
  readonly validity: ReadonlyMap<string, Uint32Array>;
  private readonly indexByKey: Map<string, number>;

  constructor(
    nRows: number,
    selectors: readonly Selector[],
    bits: Uint32Array,
    validity: Map<string, Uint32Array>,
  ) {
    this.nRows = nRows;
    this.wordsPerRow = wordsFor(nRows);
    this.selectors = selectors;
    this.bits = bits;
    this.validity = validity;
    this.indexByKey = new Map(selectors.map((s, i) => [selectorKey(s), i]));
  }

  /** Word offset of selector i's bitset inside `bits`. */
  offset(i: number): number {
    return i * this.wordsPerRow;
  }

  /** Subarray view of selector i's bitset. */
  row(i: number): Uint32Array {
    return this.bits.subarray(this.offset(i), this.offset(i) + this.wordsPerRow);
  }

  indexOf(sel: Selector): number {
    const i = this.indexByKey.get(selectorKey(sel));
    if (i === undefined) throw new ValidationError(`selector not in atlas: ${selectorKey(sel)}`);
    return i;
  }

  /** Popcount of selector i's bitset. */
  countOf(i: number): number {
    return countRange(this.bits, this.offset(i), this.wordsPerRow);
  }

  /** AND the given selector rows into dst (dst must be wordsPerRow long). */
  coverInto(selIndices: readonly number[], dst: Uint32Array): void {
    const w = this.wordsPerRow;
    if (selIndices.length === 0) {
      dst.fill(0xffffffff);
      maskTail(dst, this.nRows);
      return;
    }
    dst.set(this.row(selIndices[0]!));
    for (let k = 1; k < selIndices.length; k++) {
      andInto(dst, 0, dst, 0, this.bits, this.offset(selIndices[k]!), w);
    }
  }
}

/** Build the atlas for a selector list over a table. */
export function buildAtlas(table: DataTable, selectors: readonly Selector[]): SelectorAtlas {
  const nRows = table.nRows;
  const w = wordsFor(nRows);
  const bits = new Uint32Array(selectors.length * w);
  const validity = new Map<string, Uint32Array>();

  const ensureValidity = (attr: string): Uint32Array => {
    let v = validity.get(attr);
    if (v !== undefined) return v;
    v = new Uint32Array(w);
    const col = table.column(attr);
    switch (col.kind) {
      case "categorical":
        for (let i = 0; i < nRows; i++) if (col.codes[i] !== -1) v[i >>> 5]! |= 1 << (i & 31);
        break;
      case "numeric":
        for (let i = 0; i < nRows; i++) {
          if (!Number.isNaN(col.values[i]!)) v[i >>> 5]! |= 1 << (i & 31);
        }
        break;
      case "boolean":
        if (col.na === null) {
          v.fill(0xffffffff);
          maskTail(v, nRows);
        } else {
          for (let i = 0; i < nRows; i++) if (col.na[i] === 0) v[i >>> 5]! |= 1 << (i & 31);
        }
        break;
    }
    validity.set(attr, v);
    return v;
  };

  // Group base (non-negated) selectors by column for single-pass builds.
  const eqByColumn = new Map<string, { selIdx: number; value: string | number | boolean }[]>();
  const isNullIdx: { attr: string; selIdx: number }[] = [];
  const intervalIdx = new Map<string, { selIdx: number; lo: number; hi: number }[]>();
  const negations: number[] = [];

  selectors.forEach((sel, i) => {
    switch (sel.kind) {
      case "equality": {
        const list = eqByColumn.get(sel.attribute) ?? [];
        list.push({ selIdx: i, value: sel.value });
        eqByColumn.set(sel.attribute, list);
        break;
      }
      case "isNull":
        isNullIdx.push({ attr: sel.attribute, selIdx: i });
        break;
      case "interval": {
        const list = intervalIdx.get(sel.attribute) ?? [];
        list.push({ selIdx: i, lo: sel.lo, hi: sel.hi });
        intervalIdx.set(sel.attribute, list);
        break;
      }
      case "negated":
        negations.push(i);
        break;
    }
  });

  // Equality selectors: per column, map value -> selector index, one pass.
  for (const [attr, entries] of eqByColumn) {
    const col = table.column(attr);
    if (col.kind === "categorical") {
      // code -> selIdx (or -1)
      const codeToSel = new Int32Array(col.categories.length).fill(-1);
      for (const { selIdx, value } of entries) {
        for (let c = 0; c < col.categories.length; c++) {
          if (col.categories[c] === value) {
            codeToSel[c] = selIdx;
            break;
          }
        }
      }
      for (let i = 0; i < nRows; i++) {
        const code = col.codes[i]!;
        if (code >= 0) {
          const s = codeToSel[code]!;
          if (s >= 0) bits[s * w + (i >>> 5)]! |= 1 << (i & 31);
        }
      }
    } else if (col.kind === "numeric") {
      for (const { selIdx, value } of entries) {
        if (typeof value !== "number") continue;
        const off = selIdx * w;
        for (let i = 0; i < nRows; i++) {
          if (col.values[i] === value) bits[off + (i >>> 5)]! |= 1 << (i & 31);
        }
      }
    } else {
      for (const { selIdx, value } of entries) {
        if (typeof value !== "boolean") continue;
        const want = value ? 1 : 0;
        const off = selIdx * w;
        for (let i = 0; i < nRows; i++) {
          if (col.values[i] === want && (col.na === null || col.na[i] === 0)) {
            bits[off + (i >>> 5)]! |= 1 << (i & 31);
          }
        }
      }
    }
  }

  // isNull selectors: complement of validity.
  for (const { attr, selIdx } of isNullIdx) {
    const v = ensureValidity(attr);
    const off = selIdx * w;
    for (let i = 0; i < w; i++) bits[off + i] = ~v[i]!;
    maskTail(bits.subarray(off, off + w), nRows);
  }

  // Interval selectors: per column pass, each row tested against that
  // column's intervals (bins are few; NaN comparisons are false).
  for (const [attr, entries] of intervalIdx) {
    const col = table.column(attr);
    if (col.kind !== "numeric") {
      throw new ValidationError(`interval selector on non-numeric column ${JSON.stringify(attr)}`);
    }
    const values = col.values;
    for (let i = 0; i < nRows; i++) {
      const x = values[i]!;
      for (const e of entries) {
        if (x >= e.lo && x < e.hi) bits[e.selIdx * w + (i >>> 5)]! |= 1 << (i & 31);
      }
    }
  }

  // Negations: validity AND NOT inner. Inner selectors may or may not be in
  // the atlas; build inner bits locally when absent.
  for (const selIdx of negations) {
    const sel = selectors[selIdx]! as Extract<Selector, { kind: "negated" }>;
    const attr = selectorAttribute(sel.inner);
    const v = ensureValidity(attr);
    const innerBits = bitsForSelector(table, sel.inner, selectors, bits, w);
    const off = selIdx * w;
    for (let i = 0; i < w; i++) bits[off + i] = v[i]! & ~innerBits[i]!;
  }

  // Pre-build validity for all referenced attributes (useful to callers).
  for (const sel of selectors) ensureValidity(selectorAttribute(sel));

  return new SelectorAtlas(nRows, selectors, bits, validity);
}

/** Inner-selector bits: reuse the atlas row when present, else build ad hoc. */
function bitsForSelector(
  table: DataTable,
  inner: Selector,
  selectors: readonly Selector[],
  bits: Uint32Array,
  w: number,
): Uint32Array {
  const key = selectorKey(inner);
  for (let i = 0; i < selectors.length; i++) {
    if (selectors[i]!.kind !== "negated" && selectorKey(selectors[i]!) === key) {
      return bits.subarray(i * w, i * w + w);
    }
  }
  // Not in atlas: row-scan build (rare; nested negation or ad-hoc selectors).
  const mask = conjunctionCover(table, [inner]);
  const out = new Uint32Array(w);
  for (let i = 0; i < mask.length; i++) if (mask[i] === 1) out[i >>> 5]! |= 1 << (i & 31);
  return out;
}
