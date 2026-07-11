/**
 * M4 §6.2 exactness gates: apriori / dfs / bestFirst vs the exhaustive
 * oracle across the full exactness matrix (incl. tie/NA/duplicate-row
 * stress cells), each with pruning on AND off (pruning-identity gate:
 * estimate pruning and monotone-constraint interaction are sound).
 */
import { describe, expect, it } from "vitest";
import { recordGateRow } from "../util/gaterow.js";
import { EXACTNESS_CELLS } from "./cells.js";
import { runExactnessCell } from "./runner.js";

const done: string[] = [];
let prunedSomewhere = 0;

describe("M4 exactness: exact CPU algorithms == oracle top-k (pruning on/off)", () => {
  for (const cell of EXACTNESS_CELLS) {
    it(`${cell.id}`, async () => {
      const outcome = await runExactnessCell(cell);
      done.push(cell.id);
      const anyPruned = Object.values(outcome.evaluatedOn).some((n) => n < outcome.candidates);
      if (anyPruned) prunedSomewhere++;
    });
  }

  it("records the gate rows", () => {
    recordGateRow({
      id: "m4-exactness-cpu",
      cell: "exactness-matrix",
      check:
        "apriori/dfs/bestFirst top-k == exhaustive oracle exactly (descriptions, order, " +
        "bit-identical qualities) on every cell",
      value: `${done.length}/${EXACTNESS_CELLS.length} cells × 3 algorithms`,
      expected: `${EXACTNESS_CELLS.length} cells`,
      gate: true,
      pass: done.length === EXACTNESS_CELLS.length,
    });
    recordGateRow({
      id: "m4-pruning-identity",
      cell: "exactness-matrix",
      check:
        "pruning-disabled == pruning-enabled == oracle per algorithm; disabled runs " +
        "enumerate the full space (estimate admissibility + constraint soundness)",
      value: `${done.length}/${EXACTNESS_CELLS.length} cells, pruning engaged on ${prunedSomewhere}`,
      expected: `${EXACTNESS_CELLS.length} cells identical`,
      gate: true,
      pass: done.length === EXACTNESS_CELLS.length && prunedSomewhere > 0,
    });
    expect(done.length).toBe(EXACTNESS_CELLS.length);
    expect(prunedSomewhere).toBeGreaterThan(0);
  });
});
