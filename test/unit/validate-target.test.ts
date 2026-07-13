/**
 * Stats-QF task-setup target validation (spec §6.2): chiSquared requires
 * 0 < P < N at task setup — a degenerate target must fail prepareTask
 * synchronously, not per-candidate mid-search. The per-candidate guard in
 * evaluate() stays as a backstop for direct callers.
 */
import { describe, expect, it } from "vitest";
import {
  apriori,
  binary,
  chiSquared,
  fromColumns,
  nominalSelectors,
  type PreparedBinary,
  prepareTarget,
  prepareTask,
  ValidationError,
} from "../../src/index.js";

// All-positive target: P = N = 6 → the 2×2 table is degenerate.
const degenerate = fromColumns({
  x: ["a", "a", "b", "b", "a", "b"],
  y: [1, 1, 1, 1, 1, 1],
});
// Healthy control: mixed target on the same shape.
const healthy = fromColumns({
  x: ["a", "a", "b", "b", "a", "b"],
  y: [1, 0, 1, 0, 1, 1],
});

const taskFor = (table: typeof degenerate) => ({
  table,
  target: binary({ attribute: "y", value: 1 }),
  searchSpace: nominalSelectors(table, { ignore: ["y"] }),
  qf: chiSquared({ minInstances: 1 }),
  resultSetSize: 3,
  depth: 1,
});

describe("chiSquared degenerate-target validation at task setup (spec §6.2)", () => {
  it("prepareTask throws ValidationError synchronously on an all-positive target", () => {
    expect(() => prepareTask(taskFor(degenerate))).toThrowError(ValidationError);
    expect(() => prepareTask(taskFor(degenerate))).toThrowError(/both positives and negatives/);
  });

  it("the engine path rejects before any candidate is evaluated", async () => {
    await expect(apriori(taskFor(degenerate))).rejects.toThrowError(
      /both positives and negatives/,
    );
  });

  it("evaluate() keeps the per-candidate backstop for direct callers", () => {
    const prep = prepareTarget(degenerate, binary({ attribute: "y", value: 1 }));
    expect(prep.kind).toBe("binary");
    expect(() =>
      chiSquared({ minInstances: 1 }).evaluate(2, 2, prep as PreparedBinary),
    ).toThrowError(/both positives and negatives/);
  });

  it("a healthy target passes setup validation and searches normally", async () => {
    expect(() => prepareTask(taskFor(healthy))).not.toThrow();
    const results = await apriori(taskFor(healthy));
    expect(results.entries.length).toBeGreaterThan(0);
  });
});
