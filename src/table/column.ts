/**
 * Column model (BRIEF §5.1, spec §1.1).
 *
 * - categorical: dictionary-encoded Int32 codes into `categories`
 *   (first-appearance order); code -1 = NA.
 * - numeric: Float64 values; NaN = NA. `integerLike` records whether the
 *   column would be an integer dtype in the reference (pandas int64): all
 *   values integral and no NA — it controls number formatting in the
 *   reference string dialect (spec §2.4).
 * - boolean: Uint8 0/1 values with optional NA mask (1 = NA).
 */

export type CategoryValue = string | number | boolean;

export interface CategoricalColumn {
  kind: "categorical";
  codes: Int32Array;
  categories: CategoryValue[];
}

export interface NumericColumn {
  kind: "numeric";
  values: Float64Array;
  /** True when the column is integer-typed in the reference sense (pandas int64). */
  integerLike: boolean;
}

export interface BooleanColumn {
  kind: "boolean";
  values: Uint8Array;
  na: Uint8Array | null;
}

export type Column = CategoricalColumn | NumericColumn | BooleanColumn;

export function columnLength(col: Column): number {
  switch (col.kind) {
    case "categorical":
      return col.codes.length;
    case "numeric":
      return col.values.length;
    case "boolean":
      return col.values.length;
  }
}

/** Number of NA entries in the column. */
export function countNA(col: Column): number {
  switch (col.kind) {
    case "categorical": {
      let n = 0;
      for (let i = 0; i < col.codes.length; i++) if (col.codes[i] === -1) n++;
      return n;
    }
    case "numeric": {
      let n = 0;
      for (let i = 0; i < col.values.length; i++) if (Number.isNaN(col.values[i]!)) n++;
      return n;
    }
    case "boolean": {
      if (col.na === null) return 0;
      let n = 0;
      for (let i = 0; i < col.na.length; i++) if (col.na[i] === 1) n++;
      return n;
    }
  }
}

/** True if row i is NA in this column. */
export function isNARow(col: Column, i: number): boolean {
  switch (col.kind) {
    case "categorical":
      return col.codes[i] === -1;
    case "numeric":
      return Number.isNaN(col.values[i]!);
    case "boolean":
      return col.na !== null && col.na[i] === 1;
  }
}

/**
 * The raw value at row i: string|number|boolean, or undefined for NA.
 * (Row-scan statistics path and toRows use this; hot paths never do.)
 */
export function valueAt(col: Column, i: number): CategoryValue | undefined {
  switch (col.kind) {
    case "categorical": {
      const code = col.codes[i]!;
      return code === -1 ? undefined : col.categories[code];
    }
    case "numeric": {
      const v = col.values[i]!;
      return Number.isNaN(v) ? undefined : v;
    }
    case "boolean": {
      if (col.na !== null && col.na[i] === 1) return undefined;
      return col.values[i] === 1;
    }
  }
}
