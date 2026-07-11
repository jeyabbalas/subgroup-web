/**
 * Target definitions and per-subgroup statistics payloads (spec §5).
 *
 * A target is a plain descriptor (`Target`); `prepareTarget` resolves it
 * against a DataTable into a `PreparedTarget` holding the constant
 * (dataset-level) statistics and the vectors evaluators need. Per-candidate
 * statistics are computed from covers by the functions in binary.ts /
 * numeric.ts / fi.ts / emm.ts — each with two independent paths (row-scan
 * mask and bitset words) that the oracle cross-checks (BRIEF §6.1).
 */

import type { Selector } from "../desc/selector.js";
import type { DataTable } from "../table/table.js";

export interface BinaryTargetSpec {
  readonly kind: "binary";
  readonly selector: Selector;
}

export interface NumericTargetSpec {
  readonly kind: "numeric";
  readonly attribute: string;
}

export interface FITargetSpec {
  readonly kind: "fi";
}

export interface PolyRegressionModel {
  readonly type: "polyRegression";
  readonly x: string;
  readonly y: string;
  readonly degree: 1;
}

export interface EMMTargetSpec {
  readonly kind: "emm";
  readonly model: PolyRegressionModel;
}

export type Target = BinaryTargetSpec | NumericTargetSpec | FITargetSpec | EMMTargetSpec;

/** Dataset-level constant statistics + evaluation vectors per target kind. */
export interface PreparedBinary {
  readonly kind: "binary";
  readonly n: number;
  readonly positives: number;
  /** Row-scan path: 0/1 positives mask. */
  readonly positivesMask: Uint8Array;
  /** Bitset path: positives bitset words (32 rows/word, tail-masked). */
  readonly positivesBits: Uint32Array;
}

export interface PreparedNumeric {
  readonly kind: "numeric";
  readonly n: number;
  readonly values: Float64Array;
  readonly mean: number;
  readonly median: number;
  readonly std: number;
  readonly min: number;
  readonly max: number;
  /** Row indices sorted by value descending (built lazily; 'order' estimator). */
  descOrder: Uint32Array | null;
}

export interface PreparedFI {
  readonly kind: "fi";
  readonly n: number;
}

export interface PreparedEMM {
  readonly kind: "emm";
  readonly n: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
}

export type PreparedTarget = PreparedBinary | PreparedNumeric | PreparedFI | PreparedEMM;

/** The attributes a target constrains (for removeTargetAttributes / validation). */
export function targetAttributes(target: Target): string[] {
  switch (target.kind) {
    case "binary": {
      const attrs: string[] = [];
      const walk = (sel: Selector): void => {
        if (sel.kind === "negated") walk(sel.inner);
        else attrs.push(sel.attribute);
      };
      walk(target.selector);
      return attrs;
    }
    case "numeric":
      return [target.attribute];
    case "fi":
      return [];
    case "emm":
      return [target.model.x, target.model.y];
  }
}

export type { DataTable };
