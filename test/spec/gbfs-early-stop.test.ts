/**
 * generalizingBFS frontier early-stop (spec §7.11): the generalization
 * bound og = ((n+P−p)/N)^a·(1−p0) never exceeds 1−p0 (n−p ≤ N−P), so a
 * minQuality ABOVE 1−p0 makes every seed's subtree §3.4-prunable at push
 * time — the search evaluates exactly the seed layer, prunes everything
 * expandable, and returns nothing. This is the one regime where
 * standard(a)'s vacuous mid-search bound (spec §7.11 vacuity note)
 * actually prunes; the m5 gate pins candidatesPruned = 0 for ordinary
 * tasks.
 */
import { describe, expect, it } from "vitest";
import {
  binary,
  fromColumns,
  generalizingBFS,
  nominalSelectors,
  standard,
} from "../../src/index.js";

const g: string[] = [];
const h: string[] = [];
const y: number[] = [];
for (let i = 0; i < 40; i++) {
  g.push(`g${i % 4}`);
  h.push(`h${(i * 3 + 1) % 3}`);
  y.push(i % 2); // P = 20, N = 40, p0 = 0.5 → global max = 0.25 at a = 1
}
const table = fromColumns({ g, h, y });
const searchSpace = nominalSelectors(table, { ignore: ["y"] });
const nSel = searchSpace.length;

describe("generalizingBFS early-stop above the global bound (spec §7.11)", () => {
  it("minQuality above 1−p0: seed layer only, pruning fires, 0 entries", async () => {
    const results = await generalizingBFS({
      table,
      target: binary({ attribute: "y", value: 1 }),
      searchSpace,
      qf: standard(1),
      resultSetSize: 5,
      depth: 3,
      minQuality: 0.6, // > 1−p0 = 0.5 ≥ og of every node
    });
    expect(results.entries.length).toBe(0);
    expect(results.candidatesEvaluated).toBe(nSel);
    expect(results.candidatesPruned).toBeGreaterThan(0);
  });

  it("the same task below the bound explores past the seed layer", async () => {
    const results = await generalizingBFS({
      table,
      target: binary({ attribute: "y", value: 1 }),
      searchSpace,
      qf: standard(1),
      resultSetSize: 5,
      depth: 3,
      minQuality: 0,
    });
    expect(results.candidatesEvaluated).toBeGreaterThan(nSel);
    expect(results.entries.length).toBeGreaterThan(0);
  });
});
