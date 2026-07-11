/** Helpers for loading reference fixtures and decoding their tagged values. */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const FIXTURES_DIR = path.join(REPO, "reference", "fixtures");
export const DATASETS_DIR = path.join(REPO, "reference", "datasets");

/** Decode the generator's non-finite-float tags: {"$f": "nan"|"inf"|"-inf"}. */
export function decodeTagged(v: unknown): unknown {
  if (v !== null && typeof v === "object") {
    if (Array.isArray(v)) return v.map(decodeTagged);
    const o = v as Record<string, unknown>;
    if (typeof o["$f"] === "string") {
      const t = o["$f"];
      if (t === "nan") return Number.NaN;
      if (t === "inf") return Number.POSITIVE_INFINITY;
      if (t === "-inf") return Number.NEGATIVE_INFINITY;
      throw new Error(`unknown $f tag: ${t}`);
    }
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o)) out[k] = decodeTagged(val);
    return out;
  }
  return v;
}

export function loadJson(relPath: string): unknown {
  const raw = fs.readFileSync(path.join(FIXTURES_DIR, relPath), "utf8");
  return decodeTagged(JSON.parse(raw));
}

export function loadTaskFixture(id: string): TaskFixture {
  return loadJson(`tasks/${id}.json`) as TaskFixture;
}

export function sha256File(absPath: string): string {
  return createHash("sha256").update(fs.readFileSync(absPath)).digest("hex");
}

/** Shapes mirrored from reference/scripts/gen_differential_fixtures.py. */
export interface FixtureBound {
  value: number;
  int: boolean;
}
export type FixtureValue =
  | { t: "str"; v: string }
  | { t: "bool"; v: boolean }
  | { t: "num"; v: FixtureBound }
  | { t: "nan" }
  | { t: "none" };
export type FixtureSelector =
  | { kind: "equality"; attribute: string; value: FixtureValue; repr: string; str: string }
  | {
      kind: "interval";
      attribute: string;
      lo: FixtureBound;
      hi: FixtureBound;
      repr: string;
      str: string;
    }
  | { kind: "negated"; inner: FixtureSelector; repr: string; str: string };

export interface FixtureConjunction {
  repr: string;
  str: string;
  selectors: FixtureSelector[];
}

export interface TaskFixture {
  id: string;
  cell: Record<string, unknown>;
  versions: Record<string, string>;
  data_shape: [number, number];
  search_space: FixtureSelector[];
  elapsed_seconds: number;
  results: { quality: number; description: FixtureConjunction; stats: Record<string, number> }[];
}
