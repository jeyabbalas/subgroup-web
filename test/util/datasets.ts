/** Load the canonical committed datasets through subgroup-web's own fromCSV. */
import fs from "node:fs";
import path from "node:path";
import { type DataTable, fromCSV } from "../../src/index.js";
import { DATASETS_DIR, REPO } from "./fixtures.js";

const cache = new Map<string, DataTable>();

export function loadDataset(name: "titanic" | "credit-g" | "adult" | string): DataTable {
  let table = cache.get(name);
  if (table !== undefined) return table;
  let file: string;
  if (name === "adult") {
    file = path.join(REPO, "reference", ".cache", "adult.csv");
    if (!fs.existsSync(file)) {
      throw new Error(
        "adult.csv not fetched; run `cd reference && uv run python scripts/fetch_adult.py`",
      );
    }
  } else if (name.startsWith("synth:")) {
    file = path.join(REPO, "test", "fixtures", "datasets", `${name.slice("synth:".length)}.csv`);
  } else {
    file = path.join(DATASETS_DIR, `${name}.csv`);
  }
  table = fromCSV(fs.readFileSync(file, "utf8"));
  cache.set(name, table);
  return table;
}
