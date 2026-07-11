/**
 * Parser/printer for pysubgroup 0.9.0's description-string dialects.
 *
 * Differential fixtures record subgroup descriptions in the reference's own
 * two string forms (BRIEF §22-A16):
 *
 * - the **query** dialect (`repr(Conjunction)`): full-precision numbers,
 *   `"(sel and sel)"` with selectors sorted by their repr; empty = `"True"`;
 *   negation = `"(not <repr>)"`.
 * - the **display** dialect (`str(Conjunction)`): `"sel AND sel"` sorted by
 *   str; empty = `"Dataset"`; negation = `"NOT <str>"`; interval bounds
 *   rounded via `"{0:.2f}"` when non-integral.
 *
 * Selector forms (both dialects unless noted):
 * - equality: `attr=='value'` (str), `attr==5` / `attr==5.5` / `attr==True`,
 *   `attr.isnull()` (NaN value), `attr is None` (None value).
 * - interval `[lo, hi)`: `attr: [lo:hi[`; half-open at ±inf: `attr>=lo`,
 *   `attr<hi`; both infinite: `attr = anything`.
 *
 * Known dialect limitations (documented in docs/spec.md): attribute names and
 * string values containing the tokens `" AND "`, `" and "`, `"=="`, `">="`,
 * `"<"`, or `": ["` cannot be round-tripped; none of the gate datasets
 * contain such names/values.
 */

import { pyFloatRepr, pyFormatFixed } from "../util/pyfloat.js";

/** A numeric literal as Python printed it: `int` distinguishes `5` from `5.0`. */
export interface RefNumber {
  value: number;
  int: boolean;
}

export type RefValue =
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: RefNumber }
  | { t: "nan" } // pandas NA — prints as `attr.isnull()`
  | { t: "none" }; // Python None — prints as `attr is None`

export type RefSelector =
  | { kind: "equality"; attribute: string; value: RefValue }
  | { kind: "interval"; attribute: string; lo: RefNumber; hi: RefNumber }
  | { kind: "negated"; inner: RefSelector };

export type RefDialect = "query" | "display";

export class RefDialectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RefDialectError";
  }
}

const INF: RefNumber = { value: Number.POSITIVE_INFINITY, int: false };
const NEG_INF: RefNumber = { value: Number.NEGATIVE_INFINITY, int: false };

function parseRefNumber(s: string): RefNumber {
  const t = s.trim();
  if (t === "inf") return INF;
  if (t === "-inf") return NEG_INF;
  if (/^-?\d+$/.test(t)) {
    const v = Number(t);
    if (!Number.isSafeInteger(v)) {
      // Python ints are unbounded; doubles beyond 2^53 would silently lose
      // precision. No gate dataset produces such bounds.
      throw new RefDialectError(`integer literal out of safe range: ${t}`);
    }
    return { value: v, int: true };
  }
  const v = Number(t);
  if (Number.isNaN(v) && t !== "nan") {
    throw new RefDialectError(`unparseable number: ${JSON.stringify(s)}`);
  }
  return { value: v, int: false };
}

/** Print a number the way `IntervalSelector.compute_string` does. */
function printBound(n: RefNumber, dialect: RefDialect): string {
  if (n.int) return String(n.value);
  // Python: `if bound % 1:` — only non-integral floats go through the
  // rounding formatter; integral floats fall back to str() -> "5.0".
  const nonIntegral = !Number.isInteger(n.value) && Number.isFinite(n.value);
  if (dialect === "display" && nonIntegral) return pyFormatFixed(n.value, 2);
  return pyFloatRepr(n.value);
}

function printValue(v: RefValue): string {
  switch (v.t) {
    case "str":
      return `'${v.v}'`;
    case "bool":
      return v.v ? "True" : "False";
    case "num":
      return v.v.int ? String(v.v.value) : pyFloatRepr(v.v.value);
    case "nan":
    case "none":
      throw new RefDialectError("nan/none values print via selector-level forms");
  }
}

/** Print one selector in the given dialect (matches EqualitySelector/IntervalSelector/NegatedSelector). */
export function printRefSelector(sel: RefSelector, dialect: RefDialect): string {
  switch (sel.kind) {
    case "negated": {
      const inner = printRefSelector(sel.inner, dialect);
      return dialect === "query" ? `(not ${inner})` : `NOT ${inner}`;
    }
    case "equality": {
      if (sel.value.t === "nan") return `${sel.attribute}.isnull()`;
      if (sel.value.t === "none") return `${sel.attribute} is None`;
      return `${sel.attribute}==${printValue(sel.value)}`;
    }
    case "interval": {
      const { lo, hi } = sel;
      const loInf = lo.value === Number.NEGATIVE_INFINITY;
      const hiInf = hi.value === Number.POSITIVE_INFINITY;
      if (loInf && hiInf) return `${sel.attribute} = anything`;
      if (loInf) return `${sel.attribute}<${printBound(hi, dialect)}`;
      if (hiInf) return `${sel.attribute}>=${printBound(lo, dialect)}`;
      return `${sel.attribute}: [${printBound(lo, dialect)}:${printBound(hi, dialect)}[`;
    }
  }
}

/** Parse one selector string in the given dialect. */
export function parseRefSelector(s: string, dialect: RefDialect): RefSelector {
  const t = s.trim();
  if (dialect === "query" && t.startsWith("(not ") && t.endsWith(")")) {
    return { kind: "negated", inner: parseRefSelector(t.slice(5, -1), dialect) };
  }
  if (dialect === "display" && t.startsWith("NOT ")) {
    return { kind: "negated", inner: parseRefSelector(t.slice(4), dialect) };
  }
  if (t.endsWith(".isnull()")) {
    return { kind: "equality", attribute: t.slice(0, -".isnull()".length), value: { t: "nan" } };
  }
  if (t.endsWith(" is None")) {
    return { kind: "equality", attribute: t.slice(0, -" is None".length), value: { t: "none" } };
  }
  const eq = t.indexOf("==");
  if (eq >= 0) {
    const attribute = t.slice(0, eq);
    const raw = t.slice(eq + 2);
    let value: RefValue;
    if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
      value = { t: "str", v: raw.slice(1, -1) };
    } else if (raw === "True" || raw === "False") {
      value = { t: "bool", v: raw === "True" };
    } else {
      value = { t: "num", v: parseRefNumber(raw) };
    }
    return { kind: "equality", attribute, value };
  }
  if (t.endsWith(" = anything")) {
    return {
      kind: "interval",
      attribute: t.slice(0, -" = anything".length),
      lo: NEG_INF,
      hi: INF,
    };
  }
  const intervalMatch = t.match(/^(.*): \[(.*):(.*)\[$/);
  if (intervalMatch) {
    return {
      kind: "interval",
      attribute: intervalMatch[1] as string,
      lo: parseRefNumber(intervalMatch[2] as string),
      hi: parseRefNumber(intervalMatch[3] as string),
    };
  }
  const ge = t.indexOf(">=");
  if (ge >= 0) {
    return {
      kind: "interval",
      attribute: t.slice(0, ge),
      lo: parseRefNumber(t.slice(ge + 2)),
      hi: INF,
    };
  }
  const lt = t.indexOf("<");
  if (lt >= 0) {
    return {
      kind: "interval",
      attribute: t.slice(0, lt),
      lo: NEG_INF,
      hi: parseRefNumber(t.slice(lt + 1)),
    };
  }
  throw new RefDialectError(`unparseable selector: ${JSON.stringify(s)} (${dialect})`);
}

/**
 * Print a conjunction of selectors in the given dialect, applying the
 * reference's sort-at-print rule (sorted by each selector's own printed form).
 */
export function printRefConjunction(
  selectors: readonly RefSelector[],
  dialect: RefDialect,
): string {
  if (selectors.length === 0) return dialect === "query" ? "True" : "Dataset";
  const parts = selectors.map((sel) => printRefSelector(sel, dialect)).sort();
  return dialect === "query" ? `(${parts.join(" and ")})` : parts.join(" AND ");
}

/** Parse a conjunction string in the given dialect. */
export function parseRefConjunction(s: string, dialect: RefDialect): RefSelector[] {
  const t = s.trim();
  if (dialect === "query") {
    if (t === "True") return [];
    if (!t.startsWith("(") || !t.endsWith(")")) {
      throw new RefDialectError(`query conjunction must be parenthesized: ${JSON.stringify(s)}`);
    }
    // Negation reprs "(not X)" contain no " and ", so a flat split is safe.
    return t
      .slice(1, -1)
      .split(" and ")
      .map((part) => parseRefSelector(part, dialect));
  }
  if (t === "Dataset") return [];
  return t.split(" AND ").map((part) => parseRefSelector(part, dialect));
}
