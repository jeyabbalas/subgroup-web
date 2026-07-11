/**
 * Gate-row recorder: tests append machine-readable rows that
 * scripts/reports.mjs assembles into PARITY.md during `pnpm gate` (§6.5).
 */
import fs from "node:fs";
import path from "node:path";
import { REPO } from "./fixtures.js";

export interface GateRow {
  /** Unique row id (also the file name). */
  id: string;
  /** Matrix cell or suite the row belongs to. */
  cell: string;
  /** What was checked. */
  check: string;
  /** Observed value (short, human-readable). */
  value: string;
  /** Expected value. */
  expected: string;
  /** Goal-blocking gate row (true) vs informational (false). */
  gate: boolean;
  pass: boolean;
  /** Adjudication id when the expectation is adjudicated (COMPATIBILITY.md). */
  adj?: string;
}

export function recordGateRow(row: GateRow): void {
  const dir = path.join(REPO, ".gate", "rows");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${row.id.replace(/[^a-zA-Z0-9_-]+/g, "_")}.json`);
  fs.writeFileSync(file, JSON.stringify(row, null, 1));
}

/** Record a divergence found by the differential runner (must cite an adjudication). */
export function recordDivergence(d: {
  id: string;
  cell: string;
  summary: string;
  adjudication?: string;
}): void {
  const dir = path.join(REPO, ".gate");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "divergences.json");
  const existing: unknown[] = fs.existsSync(file)
    ? (JSON.parse(fs.readFileSync(file, "utf8")) as unknown[])
    : [];
  existing.push(d);
  fs.writeFileSync(file, JSON.stringify(existing, null, 1));
}
