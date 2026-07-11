/**
 * Row-scan cover semantics — the spec-defining evaluation path (spec §§1.2, 2.1).
 *
 * This is deliberately simple, allocation-heavy code: it is statistics path #1
 * of the dual-path oracle (BRIEF §6.1). The bitset atlas (src/bitset/) is
 * path #2 and is cross-checked against this on every fixture.
 *
 * NA policy (spec §1.2): with V(attr) = the set of non-NA rows of attr,
 * - cover(equality(attr, v))  ⊆ V(attr): rows with value === v
 * - cover(interval(attr, lo, hi)) ⊆ V(attr): rows with lo <= value < hi
 * - cover(isNull(attr)) = complement of V(attr)
 * - cover(negated(s)) = V(attribute(s)) \ cover(s)   ← NA never satisfies a
 *   negation (deliberate divergence from the reference's logical_not; ADJ-003)
 */

import { ValidationError } from "../errors.js";
import type { DataTable } from "../table/table.js";
import { type Selector, selectorAttribute } from "./selector.js";

/** 0/1 mask of non-NA rows for an attribute. */
export function validityMask(table: DataTable, attribute: string): Uint8Array {
  const out = new Uint8Array(table.nRows);
  const col = table.column(attribute);
  switch (col.kind) {
    case "categorical":
      for (let i = 0; i < out.length; i++) out[i] = col.codes[i] === -1 ? 0 : 1;
      break;
    case "numeric":
      for (let i = 0; i < out.length; i++) out[i] = Number.isNaN(col.values[i]!) ? 0 : 1;
      break;
    case "boolean":
      if (col.na === null) out.fill(1);
      else for (let i = 0; i < out.length; i++) out[i] = col.na[i] === 1 ? 0 : 1;
      break;
  }
  return out;
}

/** Row-scan cover of a single selector as a 0/1 mask. */
export function selectorCover(table: DataTable, sel: Selector): Uint8Array {
  const n = table.nRows;
  const out = new Uint8Array(n);
  switch (sel.kind) {
    case "isNull": {
      const valid = validityMask(table, sel.attribute);
      for (let i = 0; i < n; i++) out[i] = valid[i] === 1 ? 0 : 1;
      return out;
    }
    case "equality": {
      const col = table.column(sel.attribute);
      const v = sel.value;
      switch (col.kind) {
        case "categorical": {
          // Values compare by strict identity within the JS value domain.
          let code = -2;
          for (let c = 0; c < col.categories.length; c++) {
            if (col.categories[c] === v) {
              code = c;
              break;
            }
          }
          if (code !== -2) {
            for (let i = 0; i < n; i++) out[i] = col.codes[i] === code ? 1 : 0;
          }
          return out;
        }
        case "numeric": {
          if (typeof v !== "number") return out; // type-mismatched equality covers nothing
          for (let i = 0; i < n; i++) out[i] = col.values[i] === v ? 1 : 0;
          return out;
        }
        case "boolean": {
          if (typeof v !== "boolean") return out;
          const want = v ? 1 : 0;
          for (let i = 0; i < n; i++) {
            out[i] = col.values[i] === want && (col.na === null || col.na[i] === 0) ? 1 : 0;
          }
          return out;
        }
      }
      break;
    }
    case "interval": {
      const col = table.column(sel.attribute);
      if (col.kind !== "numeric") {
        throw new ValidationError(
          `interval selector on ${JSON.stringify(sel.attribute)} requires a numeric column, got ${col.kind}`,
        );
      }
      const { lo, hi } = sel;
      for (let i = 0; i < n; i++) {
        const x = col.values[i]!;
        // NaN comparisons are false: NA rows are never covered.
        out[i] = x >= lo && x < hi ? 1 : 0;
      }
      return out;
    }
    case "negated": {
      const inner = selectorCover(table, sel.inner);
      const valid = validityMask(table, selectorAttribute(sel.inner));
      for (let i = 0; i < n; i++) out[i] = valid[i] === 1 && inner[i] === 0 ? 1 : 0;
      return out;
    }
  }
  return out;
}

/** Row-scan cover of a conjunction (empty = all rows, mirroring the reference). */
export function conjunctionCover(table: DataTable, selectors: readonly Selector[]): Uint8Array {
  const n = table.nRows;
  const out = new Uint8Array(n).fill(1);
  for (const sel of selectors) {
    const c = selectorCover(table, sel);
    for (let i = 0; i < n; i++) out[i] = out[i]! & c[i]!;
  }
  return out;
}

/** Row-scan cover of a disjunction (empty = no rows). */
export function disjunctionCover(table: DataTable, selectors: readonly Selector[]): Uint8Array {
  const n = table.nRows;
  const out = new Uint8Array(n);
  for (const sel of selectors) {
    const c = selectorCover(table, sel);
    for (let i = 0; i < n; i++) out[i] = out[i]! | c[i]!;
  }
  return out;
}
