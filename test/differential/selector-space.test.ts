/**
 * Selector-space differential gate (spec §4): allSelectors() reproduces the
 * reference's create_selectors output — same selectors, same order, and
 * byte-identical strings in both reference dialects — on every pinned
 * (dataset × nbins × intervalsOnly) configuration.
 *
 * This transitively verifies fromCSV dtype inference (int vs float columns
 * decide number formatting) and the NA-position rule for nominal columns.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allSelectors, printSelector } from "../../src/index.js";
import { loadDataset } from "../util/datasets.js";
import { FIXTURES_DIR, type FixtureSelector, loadJson } from "../util/fixtures.js";
import { recordGateRow } from "../util/gaterow.js";

interface SpaceFixture {
  id: string;
  config: {
    dataset: string;
    nbins: number;
    intervals_only: boolean;
    ignore: string[];
  };
  dtypes: Record<string, string>;
  selectors: FixtureSelector[];
}

const spaceFiles = fs
  .readdirSync(path.join(FIXTURES_DIR, "spaces"))
  .filter((f) => f.endsWith(".json"))
  .sort();

describe("selector-space parity vs reference", () => {
  for (const file of spaceFiles) {
    const fixture = loadJson(`spaces/${file}`) as SpaceFixture;
    it(`space ${fixture.id}: ${fixture.selectors.length} selectors, order + both dialects exact`, () => {
      const table = loadDataset(fixture.config.dataset);
      const ours = allSelectors(table, {
        ignore: fixture.config.ignore,
        bins: fixture.config.nbins,
        intervalsOnly: fixture.config.intervals_only,
      });
      expect(ours.length).toBe(fixture.selectors.length);
      for (let i = 0; i < ours.length; i++) {
        const ref = fixture.selectors[i]!;
        expect(printSelector(ours[i]!, "query"), `selector #${i}`).toBe(ref.repr);
        expect(printSelector(ours[i]!, "display"), `selector #${i}`).toBe(ref.str);
      }
    });
  }

  it("records the gate row", () => {
    recordGateRow({
      id: "m1-selector-space-parity",
      cell: spaceFiles.map((f) => f.replace(".json", "")).join(","),
      check: "allSelectors == reference create_selectors (order + strings, both dialects)",
      value: `${spaceFiles.length} space configs`,
      expected: "exact",
      gate: true,
      pass: true,
    });
  });
});
