/**
 * Stress-dataset generators (BRIEF §6.4): engineered tables targeting the
 * failure modes plain datasets rarely hit — exact quality ties (identical
 * covers under different labels AND distinct covers with equal statistics),
 * heavy NA incl. the ¬(x = v)-over-NA trap (BRIEF §22-A2), and duplicated
 * rows with repeated numeric values (equal-frequency cutpoint collapse,
 * BRIEF §22-A8). Deterministic given the seed; frozen as fixtures by
 * scripts/gen-synth-fixtures.mjs (hash-checked, BRIEF §21).
 */

import { type CellValue, type DataTable, fromColumns } from "../table/table.js";
import { Pcg32 } from "../util/rng.js";

/**
 * Tie-stress: 8 equal blocks of `blockSize` rows. c1/c2/c3 split the blocks
 * by bit; d1 mirrors c1 under different labels (identical covers ⇒ exact
 * ties decided only by the canonical order); c2/c3 slices tie by equal
 * (size, positives) on distinct covers. Per block, positives are the first
 * 6 (even blocks) / 3 (odd blocks) of 12 rows — integer counts, exact ties.
 */
export function tieStress(blockSize = 12): DataTable {
  const nBlocks = 8;
  const n = nBlocks * blockSize;
  const c1 = new Array<CellValue>(n);
  const c2 = new Array<CellValue>(n);
  const c3 = new Array<CellValue>(n);
  const d1 = new Array<CellValue>(n);
  const y = new Array<CellValue>(n);
  for (let i = 0; i < n; i++) {
    const b = i % nBlocks;
    const posInBlock = Math.floor(i / nBlocks);
    c1[i] = b & 1 ? "A1" : "A0";
    c2[i] = (b >> 1) & 1 ? "B1" : "B0";
    c3[i] = (b >> 2) & 1 ? "C1" : "C0";
    d1[i] = b & 1 ? "D1" : "D0";
    const positives = b % 2 === 0 ? Math.floor(blockSize / 2) : Math.floor(blockSize / 4);
    y[i] = posInBlock < positives ? 1 : 0;
  }
  return fromColumns({ c1, c2, c3, d1, y });
}

/**
 * NA-stress: ~35% NA in g1, ~25% in g2 (plus g2 forced to NA wherever
 * g1 = 'γ' — the conjunction g1='γ' ∧ g2=* is empty by construction),
 * 30% NaN in x1 (values from the small level set {0..4} — duplicate
 * quantiles), clean numeric x2 and t (targets must be NA-free, BRIEF §5.5).
 */
export function naStress(n: number, seed: bigint | number): DataTable {
  const rng = new Pcg32(BigInt(seed));
  const g1 = new Array<CellValue>(n);
  const g2 = new Array<CellValue>(n);
  const x1 = new Float64Array(n);
  const x2 = new Float64Array(n);
  const t = new Float64Array(n);
  const y = new Array<CellValue>(n);
  const G1 = ["α", "β", "γ"];
  const G2 = ["hi", "lo"];
  for (let i = 0; i < n; i++) {
    const v1 = rng.nextFloat() < 0.35 ? null : G1[rng.nextBounded(3)]!;
    g1[i] = v1;
    g2[i] = v1 === "γ" || rng.nextFloat() < 0.25 ? null : G2[rng.nextBounded(2)]!;
    x1[i] = rng.nextFloat() < 0.3 ? Number.NaN : rng.nextBounded(5);
    x2[i] = rng.nextGaussianPortable();
    t[i] = rng.nextGaussianPortable() + (g2[i] === "hi" ? 1.5 : 0);
    const pPos = (v1 === "α" ? 0.7 : 0.3) + (x1[i]! >= 3 ? 0.2 : 0);
    y[i] = rng.nextFloat() < pPos ? 1 : 0;
  }
  return fromColumns({ g1, g2, x1, x2, t, y } as never);
}

/**
 * Duplicate-row stress: `distinct` engineered rows, each replicated
 * 1 + PCG32-bounded(5) times contiguously. x takes values from {10, 20, 30}
 * with 20 twice as likely (repeated quantiles collapse equal-frequency
 * bins); h1/h2 small categoricals; y deterministic in (h1, x) with one
 * noise flip channel.
 */
export function dupRows(distinct: number, seed: bigint | number): DataTable {
  const rng = new Pcg32(BigInt(seed));
  const h1 = new Array<CellValue>(0);
  const h2 = new Array<CellValue>(0);
  const x = new Array<number>(0);
  const y = new Array<CellValue>(0);
  const H1 = ["r", "s", "t"];
  const H2 = ["k", "l"];
  const X = [10, 20, 20, 30];
  for (let d = 0; d < distinct; d++) {
    const v1 = H1[rng.nextBounded(3)]!;
    const v2 = H2[rng.nextBounded(2)]!;
    const xv = X[rng.nextBounded(4)]!;
    const base = (v1 === "r" ? 1 : 0) ^ (xv === 20 ? 1 : 0);
    const yv = rng.nextFloat() < 0.15 ? 1 - base : base;
    const copies = 1 + rng.nextBounded(5);
    for (let c = 0; c < copies; c++) {
      h1.push(v1);
      h2.push(v2);
      x.push(xv);
      y.push(yv);
    }
  }
  return fromColumns({ h1, h2, x: Float64Array.from(x), y } as never);
}
