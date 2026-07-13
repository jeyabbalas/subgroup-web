/**
 * fromCSV — strict RFC-4180 subset parser with pandas-compatible type
 * inference (spec §1.3).
 *
 * Grammar: comma-separated fields; LF or CRLF record breaks; fields may be
 * double-quoted, with `""` escaping a quote; quoted fields may contain
 * commas, quotes, and newlines; text after a closing quote concatenates
 * onto the field (`"x"y` → `xy`, matching pandas). A quote opening after
 * field content (`x"y`), or a dangling quote at EOF, is a CsvError.
 *
 * Blank records — exactly one empty UNQUOTED field — are skipped, matching
 * pandas skip_blank_lines=True (its default). A quoted `""` line is a real
 * single-field record; whitespace-only lines are NOT blank (exact-match, no
 * trimming — documented divergence, spec §1.3).
 *
 * NA tokens (unquoted or quoted, exact match after no trimming) default to
 * the pandas `read_csv` default set, because the canonical gate datasets are
 * consumed by both harness sides — pandas on the reference side and this
 * parser here — and must agree byte-for-byte on what is missing (spec §1.3;
 * override with `naTokens`).
 *
 * Column type inference (mirrors pandas on the gate datasets; spec §1.3):
 * 1. every non-NA field matches /^[+-]?\d+$/ -> numeric with
 *    `integerLike: !hasNA` (pandas: int64, or float64 once NA present);
 * 2. else every non-NA field parses as a finite decimal float
 *    (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/) -> numeric;
 * 3. else every non-NA field in {True,TRUE,true,False,FALSE,false} -> boolean;
 * 4. else categorical (dictionary-encoded strings, first-appearance order).
 * Per-column `overrides` force a kind; forcing numeric on unparseable text is
 * a CsvError naming the row/column.
 */

import { CsvError, ValidationError } from "../errors.js";
import type { Column } from "./column.js";
import { categoricalFromValues, DataTable } from "./table.js";

/** pandas read_csv default NA tokens (documented; override with naTokens). */
export const DEFAULT_NA_TOKENS: readonly string[] = [
  "",
  "#N/A",
  "#N/A N/A",
  "#NA",
  "-1.#IND",
  "-1.#QNAN",
  "-NaN",
  "-nan",
  "1.#IND",
  "1.#QNAN",
  "<NA>",
  "N/A",
  "NA",
  "NULL",
  "NaN",
  "None",
  "n/a",
  "nan",
  "null",
];

export interface FromCSVOptions {
  /** Force column kinds by name. */
  overrides?: Record<string, "categorical" | "numeric" | "boolean">;
  /** NA token set (exact match). Default: pandas read_csv defaults. */
  naTokens?: readonly string[];
  /** Field delimiter (single character). Default ",". */
  delimiter?: string;
}

const INT_RE = /^[+-]?\d+$/;
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const BOOL_TOKENS = new Map<string, boolean>([
  ["True", true],
  ["TRUE", true],
  ["true", true],
  ["False", false],
  ["FALSE", false],
  ["false", false],
]);

/** Parse CSV text into rows of raw string fields (RFC-4180 subset). */
export function parseCsvRecords(text: string, delimiter = ","): string[][] {
  if (delimiter.length !== 1 || delimiter === '"' || delimiter === "\n" || delimiter === "\r") {
    throw new ValidationError(`invalid delimiter ${JSON.stringify(delimiter)}`);
  }
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldWasQuoted = false;
  let i = 0;
  const n = text.length;
  // Line/col tracking for error messages.
  let line = 1;

  const endField = () => {
    row.push(field);
    field = "";
    fieldWasQuoted = false;
  };
  const endRecord = () => {
    // Blank record (exactly one empty unquoted field): skip, like pandas
    // skip_blank_lines. Quoted "" is a real record; "   " is not blank.
    if (row.length === 0 && field === "" && !fieldWasQuoted) return;
    endField();
    rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (i + 1 < n && text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      if (c === "\n") line++;
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      if (field !== "" || fieldWasQuoted) {
        throw new CsvError(`line ${line}: unexpected quote inside unquoted field`);
      }
      inQuotes = true;
      fieldWasQuoted = true;
      i++;
      continue;
    }
    if (c === delimiter) {
      endField();
      i++;
      continue;
    }
    if (c === "\n") {
      endRecord();
      line++;
      i++;
      continue;
    }
    if (c === "\r") {
      if (i + 1 < n && text[i + 1] === "\n") {
        endRecord();
        line++;
        i += 2;
        continue;
      }
      throw new CsvError(`line ${line}: bare carriage return (expected CRLF or LF)`);
    }
    field += c;
    i++;
  }
  if (inQuotes) throw new CsvError(`line ${line}: unterminated quoted field at end of input`);
  // Final record; a trailing newline leaves a blank record, which endRecord skips.
  endRecord();
  return rows;
}

/** Parse CSV text with a header row into a DataTable. */
export function fromCSV(text: string, options: FromCSVOptions = {}): DataTable {
  const naTokens = new Set(options.naTokens ?? DEFAULT_NA_TOKENS);
  const records = parseCsvRecords(text, options.delimiter ?? ",");
  if (records.length === 0) throw new CsvError("empty CSV: no header row");
  const header = records[0]!;
  const nCols = header.length;
  const seen = new Set<string>();
  for (const name of header) {
    if (seen.has(name)) throw new CsvError(`duplicate header column ${JSON.stringify(name)}`);
    seen.add(name);
  }
  const body = records.slice(1);
  if (body.length === 0) throw new CsvError("CSV has a header but no data rows");
  for (let r = 0; r < body.length; r++) {
    if (body[r]!.length !== nCols) {
      throw new CsvError(
        `row ${r + 2}: expected ${nCols} fields, got ${body[r]!.length} (RFC-4180 requires rectangular data)`,
      );
    }
  }

  const columns: Column[] = [];
  for (let c = 0; c < nCols; c++) {
    const name = header[c]!;
    const rawValues: (string | null)[] = new Array(body.length);
    for (let r = 0; r < body.length; r++) {
      const cell = body[r]![c]!;
      rawValues[r] = naTokens.has(cell) ? null : cell;
    }
    const forced = options.overrides?.[name];
    columns.push(buildTypedColumn(name, rawValues, forced));
  }
  return new DataTable(header, columns);
}

function buildTypedColumn(
  name: string,
  raw: readonly (string | null)[],
  forced: "categorical" | "numeric" | "boolean" | undefined,
): Column {
  const kind = forced ?? inferCsvKind(raw);
  switch (kind) {
    case "numeric": {
      const values = new Float64Array(raw.length);
      let hasNA = false;
      let allInt = true;
      for (let i = 0; i < raw.length; i++) {
        const cell = raw[i] ?? null;
        if (cell === null) {
          values[i] = Number.NaN;
          hasNA = true;
          continue;
        }
        if (!FLOAT_RE.test(cell) && !INT_RE.test(cell)) {
          throw new CsvError(
            `column ${JSON.stringify(name)}, row ${i + 2}: ${JSON.stringify(cell)} is not numeric`,
          );
        }
        if (!INT_RE.test(cell)) allInt = false;
        values[i] = Number(cell);
      }
      return { kind: "numeric", values, integerLike: allInt && !hasNA };
    }
    case "boolean": {
      const values = new Uint8Array(raw.length);
      let na: Uint8Array | null = null;
      for (let i = 0; i < raw.length; i++) {
        const cell = raw[i] ?? null;
        if (cell === null) {
          na ??= new Uint8Array(raw.length);
          na[i] = 1;
          continue;
        }
        const b = BOOL_TOKENS.get(cell);
        if (b === undefined) {
          throw new CsvError(
            `column ${JSON.stringify(name)}, row ${i + 2}: ${JSON.stringify(cell)} is not a boolean token`,
          );
        }
        values[i] = b ? 1 : 0;
      }
      return { kind: "boolean", values, na };
    }
    case "categorical":
      return categoricalFromValues(raw);
  }
}

function inferCsvKind(raw: readonly (string | null)[]): "categorical" | "numeric" | "boolean" {
  let sawValue = false;
  let allInt = true;
  let allFloat = true;
  let allBool = true;
  for (const cell of raw) {
    if (cell === null) continue;
    sawValue = true;
    if (allInt && !INT_RE.test(cell)) allInt = false;
    if (allFloat && !FLOAT_RE.test(cell)) allFloat = false;
    if (allBool && !BOOL_TOKENS.has(cell)) allBool = false;
    if (!allInt && !allFloat && !allBool) return "categorical";
  }
  if (!sawValue) return "categorical";
  if (allInt || allFloat) return "numeric";
  if (allBool) return "boolean";
  return "categorical";
}
