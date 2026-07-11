/**
 * Planted-ground-truth dataset generators (BRIEF §6.1): synthetic tables
 * whose best subgroup is known BY CONSTRUCTION, used to gate that exact
 * algorithms recover the plant at rank 1. Deterministic given the seed
 * (single PCG32); generators + seeds are frozen as fixtures (hash-checked,
 * BRIEF §21).
 *
 * Construction (binary): attributes a1 ∈ {p,q,r}, a2 ∈ {x,y,z} uniform; the
 * pocket a1=='p' ∧ a2=='x' has P(target=1) = pocketProb, everywhere else
 * baseProb; noise attributes are independent uniform categoricals. With the
 * default margins (0.95 vs 0.25, n ≥ 2000) the pocket's WRAcc dominates
 * every other candidate's by construction: the best single selector reaches
 * share (pocketProb + 2·baseProb)/3 on a 1/3 slice, strictly below the
 * pocket's margin; noise fluctuations are O(√(1/n)) ≪ the gap. The plant
 * test asserts rank 1 through the exhaustive oracle rather than trusting
 * this argument.
 *
 * Numeric: target = N(0, 1) noise + shift·[pocket], pocket b1=='u' ∧ b2=='m',
 * shift default 2.0σ; best standardNumeric(1) subgroup = the pocket.
 */

import { Conjunction } from "../desc/conjunction.js";
import { equality } from "../desc/selector.js";
import { type CellValue, type DataTable, fromColumns } from "../table/table.js";
import { Pcg32 } from "../util/rng.js";

export interface PlantedBinaryOptions {
  n: number;
  seed: bigint | number;
  pocketProb?: number;
  baseProb?: number;
  noiseAttributes?: number;
  noiseCardinality?: number;
}

export interface PlantedDataset {
  table: DataTable;
  /** The implanted description (the true rank-1 subgroup by construction). */
  plant: Conjunction;
  targetAttribute: string;
  /** For binary plants: the positive value. */
  targetValue?: number;
}

const A1 = ["p", "q", "r"] as const;
const A2 = ["x", "y", "z"] as const;

export function plantedBinary(options: PlantedBinaryOptions): PlantedDataset {
  const {
    n,
    seed,
    pocketProb = 0.95,
    baseProb = 0.25,
    noiseAttributes = 4,
    noiseCardinality = 3,
  } = options;
  const rng = new Pcg32(BigInt(seed));
  const a1 = new Array<CellValue>(n);
  const a2 = new Array<CellValue>(n);
  const y = new Array<CellValue>(n);
  const noise: CellValue[][] = Array.from({ length: noiseAttributes }, () => new Array(n));
  for (let i = 0; i < n; i++) {
    const v1 = A1[rng.nextBounded(3)]!;
    const v2 = A2[rng.nextBounded(3)]!;
    a1[i] = v1;
    a2[i] = v2;
    const inPocket = v1 === "p" && v2 === "x";
    y[i] = rng.nextFloat() < (inPocket ? pocketProb : baseProb) ? 1 : 0;
    for (let m = 0; m < noiseAttributes; m++) {
      noise[m]![i] = `v${rng.nextBounded(noiseCardinality)}`;
    }
  }
  const spec: Record<string, CellValue[]> = { a1: a1 as CellValue[], a2: a2 as CellValue[] };
  for (let m = 0; m < noiseAttributes; m++) spec[`m${m}`] = noise[m]!;
  spec.y = y;
  return {
    table: fromColumns(spec),
    plant: new Conjunction([equality("a1", "p"), equality("a2", "x")]),
    targetAttribute: "y",
    targetValue: 1,
  };
}

export interface PlantedNumericOptions {
  n: number;
  seed: bigint | number;
  shift?: number;
  noiseAttributes?: number;
  noiseCardinality?: number;
}

export function plantedNumeric(options: PlantedNumericOptions): PlantedDataset {
  const { n, seed, shift = 2.0, noiseAttributes = 4, noiseCardinality = 3 } = options;
  const rng = new Pcg32(BigInt(seed));
  const b1 = new Array<CellValue>(n);
  const b2 = new Array<CellValue>(n);
  const t = new Float64Array(n);
  const noise: CellValue[][] = Array.from({ length: noiseAttributes }, () => new Array(n));
  const B1 = ["u", "v", "w"];
  const B2 = ["m", "n", "o"];
  for (let i = 0; i < n; i++) {
    const v1 = B1[rng.nextBounded(3)]!;
    const v2 = B2[rng.nextBounded(3)]!;
    b1[i] = v1;
    b2[i] = v2;
    const inPocket = v1 === "u" && v2 === "m";
    t[i] = rng.nextGaussian() + (inPocket ? shift : 0);
    for (let m = 0; m < noiseAttributes; m++) {
      noise[m]![i] = `v${rng.nextBounded(noiseCardinality)}`;
    }
  }
  const spec: Record<string, CellValue[] | Float64Array> = {
    b1: b1 as CellValue[],
    b2: b2 as CellValue[],
  };
  for (let m = 0; m < noiseAttributes; m++) spec[`m${m}`] = noise[m]!;
  spec.t = t;
  return {
    table: fromColumns(spec as never),
    plant: new Conjunction([equality("b1", "u"), equality("b2", "m")]),
    targetAttribute: "t",
  };
}

/** Serialize a table to RFC-4180 CSV (fixture freezing; demo export). */
export function tableToCSV(table: DataTable): string {
  const escapeField = (v: CellValue): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  const lines: string[] = [table.names.map((n) => escapeField(n)).join(",")];
  for (const row of table.toRows()) {
    lines.push(table.names.map((name) => escapeField(row[name] as CellValue)).join(","));
  }
  return `${lines.join("\n")}\n`;
}
