/**
 * gate:quick exactness subset (BRIEF §16.3): one cell per structural family
 * through the full §6.2 assertion battery. The full matrix runs in
 * test/exactness/exact-cpu.test.ts.
 */
import { describe, it } from "vitest";
import { EXACTNESS_CELLS, QUICK_CELL_IDS } from "../cells.js";
import { runExactnessCell } from "../runner.js";

describe("exactness quick subset", () => {
  for (const id of QUICK_CELL_IDS) {
    const cell = EXACTNESS_CELLS.find((c) => c.id === id);
    if (!cell) throw new Error(`quick cell ${id} missing from EXACTNESS_CELLS`);
    it(id, async () => {
      await runExactnessCell(cell);
    });
  }
});
