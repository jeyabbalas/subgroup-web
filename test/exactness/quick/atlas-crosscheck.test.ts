/**
 * Dual-path cross-check (BRIEF §6.1): the bitset atlas (path #2) agrees
 * bit-for-bit with the row-scan cover semantics (path #1) for every selector
 * of every pinned space config, including negations, on real data.
 */
import { describe, expect, it } from "vitest";
import { allSelectors, buildAtlas, selectorCover } from "../../../src/index.js";
import { loadDataset } from "../../util/datasets.js";
import { recordGateRow } from "../../util/gaterow.js";

const CONFIGS: {
  dataset: "titanic" | "credit-g";
  ignore: string[];
  bins: number;
  intervalsOnly: boolean;
  negations: boolean;
}[] = [
  { dataset: "titanic", ignore: ["Survived"], bins: 5, intervalsOnly: true, negations: true },
  { dataset: "titanic", ignore: ["Survived"], bins: 10, intervalsOnly: false, negations: false },
  { dataset: "credit-g", ignore: ["class"], bins: 5, intervalsOnly: false, negations: true },
];

describe("atlas vs row-scan cross-check", () => {
  for (const cfg of CONFIGS) {
    it(`${cfg.dataset} bins=${cfg.bins} intervalsOnly=${cfg.intervalsOnly} negations=${cfg.negations}`, () => {
      const table = loadDataset(cfg.dataset);
      const selectors = allSelectors(table, cfg);
      const atlas = buildAtlas(table, selectors);
      expect(atlas.selectors.length).toBe(selectors.length);
      for (let i = 0; i < selectors.length; i++) {
        const rowScan = selectorCover(table, selectors[i]!);
        const bits = atlas.row(i);
        let expectedCount = 0;
        for (let r = 0; r < table.nRows; r++) {
          const got = (bits[r >>> 5]! >>> (r & 31)) & 1;
          if (got !== rowScan[r]!) {
            expect.fail(`selector #${i} disagrees at row ${r}: atlas=${got} rowScan=${rowScan[r]}`);
          }
          expectedCount += rowScan[r]!;
        }
        expect(atlas.countOf(i)).toBe(expectedCount);
      }
    });
  }

  it("records the gate row", () => {
    recordGateRow({
      id: "m1-atlas-rowscan-crosscheck",
      cell: CONFIGS.map((c) => c.dataset).join(","),
      check: "bitset atlas == row-scan covers (bit-for-bit, incl. negations)",
      value: `${CONFIGS.length} configs`,
      expected: "identical",
      gate: true,
      pass: true,
    });
  });
});
