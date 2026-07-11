/**
 * Performance-scale planted synthetics: synth-2M×256sel (BRIEF §6.4, §8).
 *
 * 32 categorical attributes (c00..c31) × 8 uniform categories (k0..k7) =
 * 256 equality selectors. The plant is c00=k0 ∧ c01=k0 (expected n/64 rows):
 *
 * - binary variant: P(y=1) = 0.95 in the pocket, 0.20 outside. Best
 *   competitor by construction is the single selector c00=k0 with WRAcc
 *   (1/8)·(0.95/8 + 0.20·7/8 − p₀) ≈ 0.0103 vs the plant's
 *   (1/64)·(0.95 − p₀) ≈ 0.0115 (p₀ ≈ 0.2117) — a ≈12% margin, ≫ the
 *   O(1/√n) sampling noise at 2M rows.
 * - numeric variant: t = N(0,1) + 2.0·[pocket]; standardNumeric(1) gives the
 *   plant n/64·(2−μ₀) vs the best selector's n/8·(2/8−μ₀) — same ≈12% margin,
 *   and depth-3 refinements of the plant keep ≲ 1/8 of its quality.
 *
 * Datasets are NEVER committed (≈270 MB): they regenerate from the seed and
 * are pinned by an FNV-1a content hash in test/fixtures/synth2m-manifest.json
 * (BRIEF §21: generators + seeds are frozen; hash checks stay on). The same
 * code runs in Node (bench runner) and the browser (GPU bench page), so both
 * environments mine the byte-identical dataset.
 */

import { Conjunction } from "../desc/conjunction.js";
import { equality } from "../desc/selector.js";
import type { CategoricalColumn, Column, NumericColumn } from "../table/column.js";
import { DataTable } from "../table/table.js";
import { Pcg32 } from "../util/rng.js";
import type { PlantedDataset } from "./planted.js";

export interface Synth2MOptions {
  rows?: number;
  attributes?: number;
  cardinality?: number;
  seed?: number | bigint;
}

const DEFAULTS = { rows: 2_000_000, attributes: 32, cardinality: 8, seed: 20260711 };

interface Core {
  names: string[];
  columns: Column[];
  pocket: Uint8Array;
  rng: Pcg32;
}

function generateCore(options: Required<Synth2MOptions>): Core {
  const { rows, attributes, cardinality, seed } = options;
  const rng = new Pcg32(BigInt(seed));
  const categories = Array.from({ length: cardinality }, (_, c) => `k${c}`);
  const names: string[] = [];
  const columns: Column[] = [];
  const codeArrays: Int32Array[] = [];
  for (let a = 0; a < attributes; a++) {
    const codes = new Int32Array(rows);
    codeArrays.push(codes);
    names.push(`c${String(a).padStart(2, "0")}`);
    columns.push({
      kind: "categorical",
      codes,
      categories: categories.slice(),
    } satisfies CategoricalColumn);
  }
  // Row-major generation: one RNG stream, attribute-inner loop — the layout
  // every consumer (Node bench, browser bench page) reproduces exactly.
  for (let r = 0; r < rows; r++) {
    for (let a = 0; a < attributes; a++) {
      codeArrays[a]![r] = rng.nextBounded(cardinality);
    }
  }
  const pocket = new Uint8Array(rows);
  const c0 = codeArrays[0]!;
  const c1 = codeArrays[1]!;
  for (let r = 0; r < rows; r++) pocket[r] = c0[r] === 0 && c1[r] === 0 ? 1 : 0;
  return { names, columns, pocket, rng };
}

/** synth-2M×256sel, binary target `y` (planted share pocket). */
export function synth2MBinary(options: Synth2MOptions = {}): PlantedDataset {
  const opts = { ...DEFAULTS, ...options };
  const { names, columns, pocket, rng } = generateCore(opts);
  const y = new Float64Array(opts.rows);
  for (let r = 0; r < opts.rows; r++) {
    y[r] = rng.nextFloat() < (pocket[r] === 1 ? 0.95 : 0.2) ? 1 : 0;
  }
  names.push("y");
  columns.push({ kind: "numeric", values: y, integerLike: true } satisfies NumericColumn);
  return {
    table: new DataTable(names, columns),
    plant: new Conjunction([equality("c00", "k0"), equality("c01", "k0")]),
    targetAttribute: "y",
    targetValue: 1,
  };
}

/** synth-2M×256sel, numeric target `t` (planted mean-shift pocket). */
export function synth2MNumeric(options: Synth2MOptions = {}): PlantedDataset {
  const opts = { ...DEFAULTS, ...options };
  const { names, columns, pocket, rng } = generateCore(opts);
  const t = new Float64Array(opts.rows);
  for (let r = 0; r < opts.rows; r++) {
    // Portable gaussian: byte-identical across Node and Chromium (the two
    // environments that regenerate this dataset against one hash pin).
    t[r] = rng.nextGaussianPortable() + (pocket[r] === 1 ? 2.0 : 0);
  }
  names.push("t");
  columns.push({ kind: "numeric", values: t, integerLike: false } satisfies NumericColumn);
  return {
    table: new DataTable(names, columns),
    plant: new Conjunction([equality("c00", "k0"), equality("c01", "k0")]),
    targetAttribute: "t",
  };
}

/** First `n` rows of a table (deterministic subsample for P5 verification). */
export function headRows(table: DataTable, n: number): DataTable {
  const names = table.names.slice();
  const columns: Column[] = names.map((name): Column => {
    const col = table.column(name);
    if (col.kind === "categorical") {
      return { kind: "categorical", codes: col.codes.slice(0, n), categories: col.categories };
    }
    if (col.kind === "numeric") {
      return { kind: "numeric", values: col.values.slice(0, n), integerLike: col.integerLike };
    }
    return {
      kind: "boolean",
      values: col.values.slice(0, n),
      na: col.na === null ? null : col.na.slice(0, n),
    };
  });
  return new DataTable(names, columns);
}

/**
 * FNV-1a (64-bit, BigInt) over every column's raw buffer — the generator
 * drift pin for the never-committed 2M datasets.
 */
export function datasetContentHash(table: DataTable): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const mix = (byte: number): void => {
    h ^= BigInt(byte);
    h = (h * prime) & mask;
  };
  for (const name of table.names) {
    for (let i = 0; i < name.length; i++) mix(name.charCodeAt(i) & 0xff);
    const col = table.column(name);
    const bytes =
      col.kind === "categorical"
        ? new Uint8Array(col.codes.buffer, col.codes.byteOffset, col.codes.byteLength)
        : col.kind === "numeric"
          ? new Uint8Array(col.values.buffer, col.values.byteOffset, col.values.byteLength)
          : col.values;
    // Sampled mixing keeps hashing O(n/step) while still pinning content:
    // every 64th byte plus the full first/last 4 KiB of each column.
    const step = 64;
    const dense = 4096;
    for (let i = 0; i < Math.min(dense, bytes.length); i++) mix(bytes[i]!);
    for (let i = dense; i < bytes.length - dense; i += step) mix(bytes[i]!);
    for (let i = Math.max(0, bytes.length - dense); i < bytes.length; i++) mix(bytes[i]!);
  }
  return h.toString(16).padStart(16, "0");
}
