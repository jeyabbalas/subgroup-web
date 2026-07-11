/**
 * Target constructors and preparation (spec §5).
 */

import { Bitset } from "../bitset/bitset.js";
import { selectorCover } from "../desc/cover.js";
import { equality, type Selector } from "../desc/selector.js";
import { ValidationError } from "../errors.js";
import type { DataTable } from "../table/table.js";
import { mean, medianInPlace, populationStd } from "../util/math.js";
import type {
  BinaryTargetSpec,
  EMMTargetSpec,
  FITargetSpec,
  NumericTargetSpec,
  PolyRegressionModel,
  PreparedBinary,
  PreparedEMM,
  PreparedFI,
  PreparedNumeric,
  PreparedTarget,
  Target,
} from "./types.js";

/**
 * Binary target (classic subgroup discovery): rows covered by the target
 * selector are the positives. `binary({ attribute, value })` builds the
 * equality selector like the reference's BinaryTarget
 * (binary_target.py:62-71).
 */
export function binary(
  spec: { attribute: string; value: string | number | boolean } | { selector: Selector },
): BinaryTargetSpec {
  if ("selector" in spec) return { kind: "binary", selector: spec.selector };
  return { kind: "binary", selector: equality(spec.attribute, spec.value) };
}

/** Numeric target over an NA-free, finite numeric column (spec §5.2). */
export function numeric(attribute: string): NumericTargetSpec {
  return { kind: "numeric", attribute };
}

/** Frequent-itemset target (no target attribute; spec §5.3). */
export function frequentItemset(): FITargetSpec {
  return { kind: "fi" };
}

/** Degree-1 polynomial regression model for EMM (spec §5.4). */
export function polyRegression(x: string, y: string, degree = 1): PolyRegressionModel {
  if (degree !== 1) {
    throw new ValidationError("polyRegression: only degree 1 is supported (like the reference)");
  }
  return { type: "polyRegression", x, y, degree };
}

/** Exceptional-model-mining target wrapping a model class (spec §5.4). */
export function emm(model: PolyRegressionModel): EMMTargetSpec {
  return { kind: "emm", model };
}

function requireFiniteColumn(table: DataTable, attribute: string, context: string): Float64Array {
  const col = table.column(attribute);
  if (col.kind !== "numeric") {
    throw new ValidationError(
      `${context}: attribute ${JSON.stringify(attribute)} must be numeric, got ${col.kind}`,
    );
  }
  for (let i = 0; i < col.values.length; i++) {
    const v = col.values[i]!;
    if (Number.isNaN(v)) {
      throw new ValidationError(
        `${context}: ${JSON.stringify(attribute)} contains NA at row ${i}; ` +
          `numeric/EMM targets require complete columns (spec §5.2)`,
      );
    }
    if (!Number.isFinite(v)) {
      throw new ValidationError(
        `${context}: ${JSON.stringify(attribute)} contains ${v} at row ${i}; ` +
          `numeric/EMM targets require finite values (spec §5.2)`,
      );
    }
  }
  return col.values;
}

export function prepareTarget(table: DataTable, target: Target): PreparedTarget {
  switch (target.kind) {
    case "binary": {
      const mask = selectorCover(table, target.selector);
      const bits = Bitset.fromMask(mask);
      let positives = 0;
      for (let i = 0; i < mask.length; i++) positives += mask[i]!;
      const prepared: PreparedBinary = {
        kind: "binary",
        n: table.nRows,
        positives,
        positivesMask: mask,
        positivesBits: bits.words,
      };
      return prepared;
    }
    case "numeric": {
      const values = requireFiniteColumn(table, target.attribute, "numeric target");
      const scratch = Float64Array.from(values);
      const med = medianInPlace(scratch);
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < values.length; i++) {
        const v = values[i]!;
        if (v < min) min = v;
        if (v > max) max = v;
      }
      const prepared: PreparedNumeric = {
        kind: "numeric",
        n: table.nRows,
        values,
        mean: mean(values),
        median: med,
        std: populationStd(values),
        min,
        max,
        descOrder: null,
      };
      return prepared;
    }
    case "fi": {
      const prepared: PreparedFI = { kind: "fi", n: table.nRows };
      return prepared;
    }
    case "emm": {
      const x = requireFiniteColumn(table, target.model.x, "emm target (x)");
      const y = requireFiniteColumn(table, target.model.y, "emm target (y)");
      const prepared: PreparedEMM = { kind: "emm", n: table.nRows, x, y };
      return prepared;
    }
  }
}

/** Descending-by-value row permutation (stable), built once per prepared target. */
export function ensureDescOrder(prep: PreparedNumeric): Uint32Array {
  if (prep.descOrder !== null) return prep.descOrder;
  const idx = new Uint32Array(prep.n);
  for (let i = 0; i < prep.n; i++) idx[i] = i;
  // Stable sort by value descending; ties keep ascending row order for determinism.
  const values = prep.values;
  const arr = Array.from(idx);
  arr.sort((a, b) => {
    const d = values[b]! - values[a]!;
    return d !== 0 ? d : a - b;
  });
  prep.descOrder = Uint32Array.from(arr);
  return prep.descOrder;
}
