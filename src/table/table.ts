/**
 * Column-oriented DataTable (BRIEF §5.1, spec §1).
 */

import { ValidationError } from "../errors.js";
import {
  type CategoricalColumn,
  type CategoryValue,
  type Column,
  columnLength,
  countNA,
  isNARow,
  valueAt,
} from "./column.js";

/** A cell value accepted by row-based constructors. null/undefined/NaN = NA. */
export type CellValue = string | number | boolean | null | undefined;

export class DataTable {
  readonly names: readonly string[];
  readonly nRows: number;
  private readonly byName: Map<string, Column>;

  constructor(names: readonly string[], columns: readonly Column[]) {
    if (names.length !== columns.length) {
      throw new ValidationError(
        `column name/data mismatch: ${names.length} names vs ${columns.length} columns`,
      );
    }
    if (names.length === 0) throw new ValidationError("a DataTable needs at least one column");
    const seen = new Set<string>();
    for (const name of names) {
      if (seen.has(name))
        throw new ValidationError(`duplicate column name: ${JSON.stringify(name)}`);
      seen.add(name);
    }
    const n = columnLength(columns[0]!);
    for (let i = 0; i < columns.length; i++) {
      const len = columnLength(columns[i]!);
      if (len !== n) {
        throw new ValidationError(
          `column ${JSON.stringify(names[i])} has ${len} rows, expected ${n}`,
        );
      }
    }
    this.names = [...names];
    this.nRows = n;
    this.byName = new Map(names.map((name, i) => [name, columns[i]!]));
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  column(name: string): Column {
    const col = this.byName.get(name);
    if (col === undefined) {
      throw new ValidationError(
        `unknown attribute ${JSON.stringify(name)}; available: ${this.names.join(", ")}`,
      );
    }
    return col;
  }

  /** NA count per column (diagnostics + builders). */
  naCount(name: string): number {
    return countNA(this.column(name));
  }

  isNA(name: string, row: number): boolean {
    return isNARow(this.column(name), row);
  }

  value(name: string, row: number): CategoryValue | undefined {
    if (row < 0 || row >= this.nRows) {
      throw new ValidationError(`row ${row} out of range [0, ${this.nRows})`);
    }
    return valueAt(this.column(name), row);
  }

  /** Materialize rows (small-data utility; not used on hot paths). */
  toRows(): Record<string, CellValue>[] {
    const out: Record<string, CellValue>[] = [];
    for (let i = 0; i < this.nRows; i++) {
      const row: Record<string, CellValue> = {};
      for (const name of this.names) {
        const v = valueAt(this.byName.get(name)!, i);
        row[name] = v === undefined ? null : v;
      }
      out.push(row);
    }
    return out;
  }
}

/** Build a categorical column from raw values, dictionary-encoding in first-appearance order. */
export function categoricalFromValues(values: readonly CellValue[]): CategoricalColumn {
  const categories: CategoryValue[] = [];
  const index = new Map<CategoryValue, number>();
  const codes = new Int32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) {
      codes[i] = -1;
      continue;
    }
    let code = index.get(v);
    if (code === undefined) {
      code = categories.length;
      categories.push(v);
      index.set(v, code);
    }
    codes[i] = code;
  }
  return { kind: "categorical", codes, categories };
}

export interface ColumnSpec {
  kind?: "categorical" | "numeric" | "boolean";
  values: readonly CellValue[] | Float64Array | Int32Array;
}

/**
 * `fromColumns({ a: [1, 2, NaN], b: ["x", "y", null] })`.
 * Kind inference per column: all-boolean -> boolean; all-number -> numeric;
 * otherwise categorical. null/undefined/NaN are NA and don't affect the kind
 * unless every value is NA (then categorical).
 */
export function fromColumns(
  spec: Record<string, readonly CellValue[] | Float64Array | ColumnSpec>,
): DataTable {
  const names = Object.keys(spec);
  const columns: Column[] = [];
  for (const name of names) {
    const raw = spec[name]!;
    const { kind, values } = normalizeSpec(raw);
    columns.push(buildColumn(name, kind, values));
  }
  return new DataTable(names, columns);
}

function normalizeSpec(raw: readonly CellValue[] | Float64Array | ColumnSpec): {
  kind: "categorical" | "numeric" | "boolean" | undefined;
  values: readonly CellValue[] | Float64Array;
} {
  if (raw instanceof Float64Array) return { kind: "numeric", values: raw };
  if (Array.isArray(raw)) return { kind: undefined, values: raw as readonly CellValue[] };
  const s = raw as ColumnSpec;
  if (s.values instanceof Int32Array) {
    return { kind: s.kind ?? "numeric", values: Float64Array.from(s.values) };
  }
  return { kind: s.kind, values: s.values as readonly CellValue[] | Float64Array };
}

function buildColumn(
  name: string,
  kind: "categorical" | "numeric" | "boolean" | undefined,
  values: readonly CellValue[] | Float64Array,
): Column {
  if (values instanceof Float64Array) {
    return {
      kind: "numeric",
      values: Float64Array.from(values),
      integerLike: isIntegerLike(values),
    };
  }
  const inferred = kind ?? inferKind(values);
  switch (inferred) {
    case "numeric": {
      const out = new Float64Array(values.length);
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || v === undefined) out[i] = Number.NaN;
        else if (typeof v === "number") out[i] = v;
        else {
          throw new ValidationError(
            `column ${JSON.stringify(name)}: non-numeric value ${JSON.stringify(v)} in numeric column (row ${i})`,
          );
        }
      }
      return { kind: "numeric", values: out, integerLike: isIntegerLike(out) };
    }
    case "boolean": {
      const out = new Uint8Array(values.length);
      let na: Uint8Array | null = null;
      for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v === null || v === undefined || (typeof v === "number" && Number.isNaN(v))) {
          na ??= new Uint8Array(values.length);
          na[i] = 1;
        } else if (typeof v === "boolean") {
          out[i] = v ? 1 : 0;
        } else {
          throw new ValidationError(
            `column ${JSON.stringify(name)}: non-boolean value ${JSON.stringify(v)} in boolean column (row ${i})`,
          );
        }
      }
      return { kind: "boolean", values: out, na };
    }
    case "categorical":
      return categoricalFromValues(values);
  }
}

function inferKind(values: readonly CellValue[]): "categorical" | "numeric" | "boolean" {
  let sawNumber = false;
  let sawBool = false;
  let sawString = false;
  let sawValue = false;
  for (const v of values) {
    if (v === null || v === undefined) continue;
    if (typeof v === "number") {
      if (Number.isNaN(v)) continue;
      sawNumber = true;
    } else if (typeof v === "boolean") sawBool = true;
    else sawString = true;
    sawValue = true;
  }
  if (!sawValue) return "categorical";
  if (sawString || (sawNumber && sawBool)) return "categorical";
  if (sawBool) return "boolean";
  return "numeric";
}

function isIntegerLike(values: Float64Array | readonly CellValue[]): boolean {
  for (let i = 0; i < values.length; i++) {
    const v = values[i] as number;
    if (Number.isNaN(v)) return false; // pandas: NaN forces float64
    if (!Number.isInteger(v)) return false;
  }
  return true;
}

/** `fromRows([{a: 1, b: "x"}, ...])` — keys unioned over all rows; missing = NA. */
export function fromRows(rows: readonly Record<string, CellValue>[]): DataTable {
  if (rows.length === 0) throw new ValidationError("fromRows needs at least one row");
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        names.push(key);
      }
    }
  }
  const spec: Record<string, CellValue[]> = {};
  for (const name of names) spec[name] = rows.map((r) => r[name]);
  return fromColumns(spec);
}
