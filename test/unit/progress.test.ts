/**
 * SearchProgress carries best-so-far (BRIEF §5.4): bestDescription is the
 * top item's display string (disjunctions render " OR " in generalizingBFS),
 * bestQuality reads the pool the engine actually fills — beamSearch's beam,
 * not run.topk (which beam never populates). Empty results stay null/NaN.
 */
import { describe, expect, it } from "vitest";
import {
  apriori,
  beamSearch,
  binary,
  exhaustive,
  fromColumns,
  generalizingBFS,
  nominalSelectors,
  type SearchProgress,
  type SubgroupResults,
  wracc,
} from "../../src/index.js";

// 40 rows, one column with 4 levels of 10 rows each; g0 and g1 all
// positive, g2/g3 all negative (p0 = 0.5). The best conjunction is a
// single selector (0.125); the best disjunction is g==g0 OR g==g1
// (n = p = 20 → wracc 0.25), so gbfs's top description is depth 2.
const g: string[] = [];
const y: number[] = [];
for (let i = 0; i < 40; i++) {
  const level = Math.floor(i / 10);
  g.push(`g${level}`);
  y.push(level <= 1 ? 1 : 0);
}
const table = fromColumns({ g, y });

const task = (extra: object = {}) => ({
  table,
  target: binary({ attribute: "y", value: 1 }),
  searchSpace: nominalSelectors(table, { ignore: ["y"] }),
  qf: wracc(),
  resultSetSize: 3,
  depth: 2,
  ...extra,
});

function collect(): { events: SearchProgress[]; onProgress: (p: SearchProgress) => void } {
  const events: SearchProgress[] = [];
  return { events, onProgress: (p) => events.push(p) };
}

function expectFinalMatchesTop(events: SearchProgress[], results: SubgroupResults): void {
  expect(events.length).toBeGreaterThan(0);
  const last = events[events.length - 1]!;
  const top = results.entries[0]!;
  expect(last.bestDescription).toBe(top.description.toString("display"));
  expect(Object.is(last.bestQuality, top.quality)).toBe(true);
}

describe("progress best-so-far (BRIEF §5.4)", () => {
  it("apriori reports a non-null bestDescription that matches the final top-1", async () => {
    const { events, onProgress } = collect();
    const results = await apriori(task({ onProgress }), { batchSize: 1 });
    expect(events.length).toBeGreaterThan(1);
    expectFinalMatchesTop(events, results);
  });

  it("generalizingBFS renders the top disjunction with ' OR '", async () => {
    const { events, onProgress } = collect();
    const results = await generalizingBFS(task({ onProgress }), { batchSize: 1 });
    expectFinalMatchesTop(events, results);
    expect(events[events.length - 1]!.bestDescription).toContain(" OR ");
  });

  it("exhaustive reports best-so-far too", async () => {
    const { events, onProgress } = collect();
    const results = await exhaustive(task({ onProgress }), { batchSize: 1 });
    expectFinalMatchesTop(events, results);
  });

  it("beamSearch reports finite bestQuality from its beam (regression)", async () => {
    const { events, onProgress } = collect();
    const results = await beamSearch(task({ onProgress }), { batchSize: 1 });
    expectFinalMatchesTop(events, results);
    expect(Number.isFinite(events[events.length - 1]!.bestQuality)).toBe(true);
  });

  it("empty result set: bestQuality stays NaN, bestDescription stays null", async () => {
    const { events, onProgress } = collect();
    const results = await apriori(task({ onProgress, minQuality: 100 }), { batchSize: 1 });
    expect(results.entries.length).toBe(0);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(e.bestDescription).toBeNull();
      expect(Number.isNaN(e.bestQuality)).toBe(true);
    }
  });
});
