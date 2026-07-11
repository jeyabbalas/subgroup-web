/**
 * Search-space builders (spec §4), mirroring the reference's
 * `create_selectors` / `create_nominal_selectors` / `create_numeric_selectors`
 * semantics and ORDER exactly (pysubgroup subgroup_description.py:506-663):
 *
 * - nominal selectors first (table column order), then numeric (column order);
 * - nominal: one equality per unique value in first-appearance order, with NA
 *   (when present) yielding isNull at NA's first-appearance position
 *   (pandas `pd.unique` includes NaN in appearance order);
 * - numeric: isNull first when the column has NAs; then, if #unique(non-NA)
 *   <= nbins, one equality per unique value ascending; else equal-frequency
 *   cutpoints (exact reference walk, see equalFrequencyCutpoints) and either
 *   consecutive intervals (intervalsOnly) or per-cutpoint one-sided pairs
 *   [c,∞) then (-∞,c);
 * - boolean columns are nominal (pandas: non-number dtype).
 *
 * Negations: the differential harness convention appends negated(base) for
 * every base selector, in base order (the reference has no auto-negation
 * builder; pinned in reference/scripts/gen_differential_fixtures.py).
 */

import { ValidationError } from "../errors.js";
import type { DataTable } from "../table/table.js";
import { type Target, targetAttributes as targetAttributesOf } from "../targets/types.js";
import {
  equality,
  interval,
  isNull,
  negated,
  type Selector,
  selectorAttribute,
} from "./selector.js";

export interface NominalOptions {
  ignore?: readonly string[];
}

export interface NumericOptions {
  ignore?: readonly string[];
  /** Number of bins (default 5). */
  bins?: number;
  /** Binning method (default equal-frequency, mirroring the reference). */
  method?: "equalFrequency" | "equalWidth" | readonly number[];
  /** Consecutive intervals (true, default) vs one-sided pairs per cutpoint. */
  intervalsOnly?: boolean;
}

export interface AllSelectorsOptions extends NumericOptions {
  /** Append negated(base) for every base selector (differential convention). */
  negations?: boolean;
}

/**
 * Equal-frequency cutpoints — the reference walk, verbatim
 * (pysubgroup utils.py:92-129): for i in 1..nbins-1, take the value at
 * position ⌊i·n/nbins⌋ of the ascending non-NA values, walking forward past
 * values already chosen; a walk past the end contributes nothing.
 */
export function equalFrequencyCutpoints(sortedValues: ArrayLike<number>, nbins: number): number[] {
  const n = sortedValues.length;
  const cutpoints: number[] = [];
  for (let i = 1; i < nbins; i++) {
    let position = Math.floor((i * n) / nbins);
    let val: number | undefined;
    while (position < n) {
      val = sortedValues[position]!;
      if (!cutpoints.includes(val)) break;
      position++;
    }
    if (position < n && val !== undefined && !cutpoints.includes(val)) {
      cutpoints.push(val);
    }
  }
  return cutpoints;
}

/** Equal-width cutpoints (subgroup-web extension; deduplicated, ascending). */
export function equalWidthCutpoints(min: number, max: number, nbins: number): number[] {
  if (!(min < max)) return [];
  const out: number[] = [];
  for (let i = 1; i < nbins; i++) {
    const c = min + (i * (max - min)) / nbins;
    if (out.length === 0 || out[out.length - 1] !== c) out.push(c);
  }
  return out;
}

function nominalSelectorsForColumn(table: DataTable, name: string): Selector[] {
  const col = table.column(name);
  const out: Selector[] = [];
  if (col.kind === "categorical") {
    // First-appearance order including the NA marker (pd.unique semantics).
    let naEmitted = false;
    const emitted = new Set<number>();
    for (
      let i = 0;
      i < col.codes.length && (emitted.size < col.categories.length || !naEmitted);
      i++
    ) {
      const code = col.codes[i]!;
      if (code === -1) {
        if (!naEmitted) {
          out.push(isNull(name));
          naEmitted = true;
        }
      } else if (!emitted.has(code)) {
        emitted.add(code);
        out.push(equality(name, col.categories[code]!));
      }
    }
    return out;
  }
  if (col.kind === "boolean") {
    let naEmitted = false;
    const emitted = new Set<number>();
    for (let i = 0; i < col.values.length; i++) {
      if (col.na !== null && col.na[i] === 1) {
        if (!naEmitted) {
          out.push(isNull(name));
          naEmitted = true;
        }
      } else if (!emitted.has(col.values[i]!)) {
        emitted.add(col.values[i]!);
        out.push(equality(name, col.values[i] === 1));
      }
    }
    return out;
  }
  throw new ValidationError(
    `nominal selectors requested for numeric column ${JSON.stringify(name)}`,
  );
}

/** Equality selectors for all non-numeric columns (table order). */
export function nominalSelectors(table: DataTable, options: NominalOptions = {}): Selector[] {
  const ignore = new Set(options.ignore ?? []);
  const out: Selector[] = [];
  for (const name of table.names) {
    if (ignore.has(name)) continue;
    if (table.column(name).kind === "numeric") continue;
    out.push(...nominalSelectorsForColumn(table, name));
  }
  return out;
}

function numericSelectorsForColumn(
  table: DataTable,
  name: string,
  bins: number,
  method: NumericOptions["method"],
  intervalsOnly: boolean,
): Selector[] {
  const col = table.column(name);
  if (col.kind !== "numeric") {
    throw new ValidationError(
      `numeric selectors requested for ${col.kind} column ${JSON.stringify(name)}`,
    );
  }
  const out: Selector[] = [];
  const nonNA: number[] = [];
  let hasNA = false;
  for (let i = 0; i < col.values.length; i++) {
    const v = col.values[i]!;
    if (Number.isNaN(v)) hasNA = true;
    else nonNA.push(v);
  }
  if (hasNA) out.push(isNull(name));
  nonNA.sort((a, b) => a - b);
  const unique: number[] = [];
  for (const v of nonNA) {
    if (unique.length === 0 || unique[unique.length - 1] !== v) unique.push(v);
  }
  const asInt = col.integerLike;

  if (unique.length === 0) return out; // all-NA column: only isNull (reference parity)
  if (unique.length <= bins && (method === undefined || method === "equalFrequency")) {
    for (const v of unique) out.push(equality(name, v, asInt));
    return out;
  }

  let cutpoints: number[];
  if (method === undefined || method === "equalFrequency") {
    cutpoints = equalFrequencyCutpoints(nonNA, bins);
  } else if (method === "equalWidth") {
    cutpoints = equalWidthCutpoints(unique[0]!, unique[unique.length - 1]!, bins);
  } else {
    cutpoints = [...method];
    for (let i = 1; i < cutpoints.length; i++) {
      if (!(cutpoints[i - 1]! < cutpoints[i]!)) {
        throw new ValidationError(
          `explicit cutpoints for ${JSON.stringify(name)} must be strictly ascending`,
        );
      }
    }
  }

  if (intervalsOnly) {
    let old = Number.NEGATIVE_INFINITY;
    for (const c of cutpoints) {
      out.push(
        interval(name, old, c, {
          loInt: old === Number.NEGATIVE_INFINITY ? false : asInt,
          hiInt: asInt,
        }),
      );
      old = c;
    }
    out.push(
      interval(name, old, Number.POSITIVE_INFINITY, {
        loInt: old === Number.NEGATIVE_INFINITY ? false : asInt,
        hiInt: false,
      }),
    );
  } else {
    for (const c of cutpoints) {
      out.push(interval(name, c, Number.POSITIVE_INFINITY, { loInt: asInt, hiInt: false }));
      out.push(interval(name, Number.NEGATIVE_INFINITY, c, { loInt: false, hiInt: asInt }));
    }
  }
  return out;
}

/** Numeric selectors for all numeric columns (table order). */
export function numericSelectors(table: DataTable, options: NumericOptions = {}): Selector[] {
  const ignore = new Set(options.ignore ?? []);
  const bins = options.bins ?? 5;
  if (!Number.isInteger(bins) || bins < 2) {
    throw new ValidationError(`bins must be an integer >= 2, got ${bins}`);
  }
  const out: Selector[] = [];
  for (const name of table.names) {
    if (ignore.has(name)) continue;
    if (table.column(name).kind !== "numeric") continue;
    out.push(
      ...numericSelectorsForColumn(
        table,
        name,
        bins,
        options.method,
        options.intervalsOnly ?? true,
      ),
    );
  }
  return out;
}

/** All selectors: nominal (column order) then numeric (column order). */
export function allSelectors(table: DataTable, options: AllSelectorsOptions = {}): Selector[] {
  const base = [...nominalSelectors(table, options), ...numericSelectors(table, options)];
  if (base.length === 0) {
    throw new ValidationError(
      "empty search space: every column was ignored or produced no selectors",
    );
  }
  if (options.negations) {
    return [...base, ...base.map((s) => negated(s))];
  }
  return base;
}

/** Drop selectors on any of the given attributes (mirrors remove_target_attributes). */
export function removeTargetAttributes(
  selectors: readonly Selector[],
  target: readonly string[] | { attributes: readonly string[] } | Target,
): Selector[] {
  let list: readonly string[];
  if (Array.isArray(target)) list = target as readonly string[];
  else if ("attributes" in (target as object)) {
    list = (target as { attributes: readonly string[] }).attributes;
  } else list = targetAttributesOf(target as Target);
  const attrs = new Set(list);
  return selectors.filter((s) => !attrs.has(selectorAttribute(s)));
}
