#!/usr/bin/env node
// Regenerates the frozen planted-ground-truth dataset fixtures (BRIEF §6.1).
// Fixtures change ONLY by re-running this generator (BRIEF §21); tests verify
// the committed bytes against in-memory regeneration and the SHA-256 manifest.
// Usage: pnpm build && node scripts/gen-synth-fixtures.mjs
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  dupRows,
  naStress,
  plantedBinary,
  plantedNumeric,
  tableToCSV,
  tieStress,
} from "../dist/index.js";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const OUT = path.join(REPO, "test", "fixtures", "datasets");
fs.mkdirSync(OUT, { recursive: true });

/** Frozen fixture recipes — seeds are part of the contract. */
export const RECIPES = [
  {
    name: "planted-binary-3k",
    kind: "binary",
    options: { n: 3000, seed: 811, pocketProb: 0.95, baseProb: 0.25, noiseAttributes: 4 },
  },
  {
    name: "planted-binary-500",
    kind: "binary",
    options: { n: 500, seed: 812, pocketProb: 0.97, baseProb: 0.2, noiseAttributes: 3 },
  },
  {
    name: "planted-numeric-3k",
    kind: "numeric",
    options: { n: 3000, seed: 813, shift: 2.0, noiseAttributes: 4 },
  },
  {
    name: "planted-numeric-500",
    kind: "numeric",
    options: { n: 500, seed: 814, shift: 2.5, noiseAttributes: 3 },
  },
  // Stress fixtures (BRIEF §6.4): engineered ties / NA / duplicated rows.
  { name: "tie-stress", kind: "tie", options: { blockSize: 12 } },
  { name: "na-stress", kind: "na", options: { n: 240, seed: 821 } },
  { name: "dup-rows", kind: "dup", options: { distinct: 48, seed: 822 } },
];

function generate(recipe) {
  switch (recipe.kind) {
    case "binary":
      return plantedBinary(recipe.options);
    case "numeric":
      return plantedNumeric(recipe.options);
    case "tie":
      return { table: tieStress(recipe.options.blockSize), plant: null };
    case "na":
      return { table: naStress(recipe.options.n, recipe.options.seed), plant: null };
    case "dup":
      return { table: dupRows(recipe.options.distinct, recipe.options.seed), plant: null };
    default:
      throw new Error(`unknown recipe kind ${recipe.kind}`);
  }
}

const manifest = { generator: "scripts/gen-synth-fixtures.mjs", fixtures: [] };
for (const recipe of RECIPES) {
  const { table, plant } = generate(recipe);
  const csv = tableToCSV(table);
  const file = path.join(OUT, `${recipe.name}.csv`);
  fs.writeFileSync(file, csv);
  manifest.fixtures.push({
    name: recipe.name,
    file: `datasets/${recipe.name}.csv`,
    kind: recipe.kind,
    options: recipe.options,
    ...(plant ? { plant: plant.toString("display") } : {}),
    rows: table.nRows,
    sha256: createHash("sha256").update(csv).digest("hex"),
  });
  console.log(
    `${recipe.name}: ${table.nRows} rows${plant ? `, plant ${plant.toString("display")}` : ""}`,
  );
}
fs.writeFileSync(
  path.join(REPO, "test", "fixtures", "synth-manifest.json"),
  `${JSON.stringify(manifest, null, 1)}\n`,
);
console.log(`wrote ${manifest.fixtures.length} fixtures + manifest`);
