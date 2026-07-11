/**
 * Result serialization (BRIEF §5.4): a stable JSON codec for result sets —
 * descriptions as structured selectors (never dialect strings), qualities
 * and stats verbatim f64 (non-finite values tagged), plus search
 * diagnostics. `deserializeResults` rebuilds a SubgroupResults; covers are
 * recomputable when the original table is supplied (row-scan; no atlas
 * needed).
 */

import { Conjunction, Disjunction } from "../desc/conjunction.js";
import type { Selector } from "../desc/selector.js";
import { equality, interval, isNull, negated } from "../desc/selector.js";
import { ValidationError } from "../errors.js";
import type { DataTable } from "../table/table.js";
import type { Description, ResultEntry } from "./result.js";
import { SubgroupResults } from "./result.js";

type Tagged = number | { $f: "nan" | "inf" | "-inf" };

function tagNumber(v: number): Tagged {
  if (Number.isNaN(v)) return { $f: "nan" };
  if (v === Number.POSITIVE_INFINITY) return { $f: "inf" };
  if (v === Number.NEGATIVE_INFINITY) return { $f: "-inf" };
  return v;
}

function untagNumber(v: Tagged): number {
  if (typeof v === "number") return v;
  if (v.$f === "nan") return Number.NaN;
  return v.$f === "inf" ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

export type SelectorJSON =
  | { kind: "equality"; attribute: string; value: string | number | boolean; numInt?: boolean }
  | { kind: "isNull"; attribute: string }
  | {
      kind: "interval";
      attribute: string;
      lo: Tagged;
      hi: Tagged;
      loInt?: boolean;
      hiInt?: boolean;
    }
  | { kind: "negated"; inner: SelectorJSON };

export function selectorToJSON(sel: Selector): SelectorJSON {
  switch (sel.kind) {
    case "equality":
      return {
        kind: "equality",
        attribute: sel.attribute,
        value: sel.value,
        ...(sel.numInt !== undefined ? { numInt: sel.numInt } : {}),
      };
    case "isNull":
      return { kind: "isNull", attribute: sel.attribute };
    case "interval":
      return {
        kind: "interval",
        attribute: sel.attribute,
        lo: tagNumber(sel.lo),
        hi: tagNumber(sel.hi),
        ...(sel.loInt !== undefined ? { loInt: sel.loInt } : {}),
        ...(sel.hiInt !== undefined ? { hiInt: sel.hiInt } : {}),
      };
    case "negated":
      return { kind: "negated", inner: selectorToJSON(sel.inner) };
  }
}

export function selectorFromJSON(json: SelectorJSON): Selector {
  switch (json.kind) {
    case "equality":
      return equality(json.attribute, json.value, json.numInt);
    case "isNull":
      return isNull(json.attribute);
    case "interval":
      return interval(json.attribute, untagNumber(json.lo), untagNumber(json.hi), {
        ...(json.loInt !== undefined ? { loInt: json.loInt } : {}),
        ...(json.hiInt !== undefined ? { hiInt: json.hiInt } : {}),
      });
    case "negated":
      return negated(selectorFromJSON(json.inner));
    default:
      throw new ValidationError(`unknown selector kind in JSON: ${JSON.stringify(json)}`);
  }
}

export interface SerializedResults {
  format: "subgroup-web-results";
  version: 1;
  form: "conjunction" | "disjunction";
  entries: {
    selectors: SelectorJSON[];
    quality: Tagged;
    stats: Record<string, Tagged>;
    optimisticEstimate?: Tagged;
  }[];
  candidatesEvaluated: number;
  candidatesPruned: number;
}

export function serializeResults(results: SubgroupResults): string {
  const form =
    results.entries[0] !== undefined && results.entries[0].description instanceof Disjunction
      ? "disjunction"
      : "conjunction";
  const payload: SerializedResults = {
    format: "subgroup-web-results",
    version: 1,
    form,
    entries: results.entries.map((e) => ({
      selectors: e.description.selectors.map(selectorToJSON),
      quality: tagNumber(e.quality),
      stats: Object.fromEntries(Object.entries(e.stats).map(([k, v]) => [k, tagNumber(v)])),
      ...(e.optimisticEstimate !== undefined
        ? { optimisticEstimate: tagNumber(e.optimisticEstimate) }
        : {}),
    })),
    candidatesEvaluated: results.candidatesEvaluated,
    candidatesPruned: results.candidatesPruned,
  };
  return JSON.stringify(payload);
}

/**
 * Rebuild results from `serializeResults` output. `table` enables
 * `cover()` on the rebuilt entries (row-scan recomputation); without it,
 * cover() throws an actionable error.
 */
export function deserializeResults(json: string, table?: DataTable): SubgroupResults {
  let payload: SerializedResults;
  try {
    payload = JSON.parse(json) as SerializedResults;
  } catch (e) {
    throw new ValidationError(`deserializeResults: invalid JSON (${(e as Error).message})`);
  }
  if (payload.format !== "subgroup-web-results" || payload.version !== 1) {
    throw new ValidationError(
      `deserializeResults: unsupported payload (format ${JSON.stringify(payload.format)}, ` +
        `version ${JSON.stringify(payload.version)})`,
    );
  }
  const entries: ResultEntry[] = payload.entries.map((e) => {
    const selectors = e.selectors.map(selectorFromJSON);
    const description: Description =
      payload.form === "disjunction" ? new Disjunction(selectors) : new Conjunction(selectors);
    return {
      description,
      quality: untagNumber(e.quality),
      stats: Object.fromEntries(Object.entries(e.stats).map(([k, v]) => [k, untagNumber(v)])),
      ...(e.optimisticEstimate !== undefined
        ? { optimisticEstimate: untagNumber(e.optimisticEstimate) }
        : {}),
      cover(): Uint32Array {
        if (table === undefined) {
          throw new ValidationError(
            "cover() on deserialized results requires the original table: " +
              "deserializeResults(json, table)",
          );
        }
        const mask = description.covers(table);
        let count = 0;
        for (let i = 0; i < mask.length; i++) count += mask[i]!;
        const out = new Uint32Array(count);
        let k = 0;
        for (let i = 0; i < mask.length; i++) {
          if (mask[i] === 1) out[k++] = i;
        }
        return out;
      },
    };
  });
  return new SubgroupResults(entries, payload.candidatesEvaluated, payload.candidatesPruned);
}
