/**
 * Abort protocol (BRIEF §5.4): an AbortSignal firing mid-search surfaces as
 * a typed AbortedError from the yield/abort checkpoint (engine tick /
 * exhaustive batch boundary), and a follow-up search on the same inputs
 * succeeds — aborting disposes cleanly.
 */
import { describe, expect, it } from "vitest";
import {
  AbortedError,
  apriori,
  bestFirst,
  binary,
  exhaustive,
  fromColumns,
  nominalSelectors,
  type SubgroupTask,
  wracc,
} from "../../src/index.js";

// 60 rows, 3 columns × 3-4 levels — enough candidates at depth 2 that a
// batchSize-1 run crosses many abort checkpoints.
const c1: string[] = [];
const c2: string[] = [];
const c3: string[] = [];
const y: number[] = [];
for (let i = 0; i < 60; i++) {
  c1.push(`a${i % 4}`);
  c2.push(`b${(i * 7 + 1) % 3}`);
  c3.push(`c${(i * 11 + 2) % 3}`);
  y.push((i * 13 + 5) % 4 < 2 ? 1 : 0);
}
const table = fromColumns({ c1, c2, c3, y });

function abortingTask(afterEvents: number): { task: SubgroupTask; controller: AbortController } {
  const controller = new AbortController();
  let events = 0;
  const task: SubgroupTask = {
    table,
    target: binary({ attribute: "y", value: 1 }),
    searchSpace: nominalSelectors(table, { ignore: ["y"] }),
    qf: wracc(),
    resultSetSize: 3,
    depth: 2,
    signal: controller.signal,
    onProgress: () => {
      events++;
      if (events === afterEvents) controller.abort();
    },
  };
  return { task, controller };
}

describe("abort mid-search (BRIEF §5.4)", () => {
  it("apriori throws AbortedError after the signal fires", async () => {
    const { task } = abortingTask(2);
    await expect(apriori(task, { batchSize: 1 })).rejects.toThrow(AbortedError);
  });

  it("bestFirst throws AbortedError after the signal fires", async () => {
    const { task } = abortingTask(2);
    await expect(bestFirst(task, { batchSize: 1 })).rejects.toThrow(AbortedError);
  });

  it("exhaustive throws AbortedError after the signal fires", async () => {
    const { task } = abortingTask(2);
    await expect(exhaustive(task, { batchSize: 1 })).rejects.toThrow(AbortedError);
  });

  it("an already-aborted signal rejects at the first checkpoint", async () => {
    const controller = new AbortController();
    controller.abort();
    const { task } = abortingTask(Number.POSITIVE_INFINITY);
    await expect(apriori({ ...task, signal: controller.signal }, { batchSize: 1 })).rejects.toThrow(
      AbortedError,
    );
  });

  it("a follow-up search succeeds after an abort (clean disposal)", async () => {
    const { task } = abortingTask(2);
    await expect(apriori(task, { batchSize: 1 })).rejects.toThrow(AbortedError);
    const { signal: _s, onProgress: _p, ...clean } = task;
    const results = await apriori(clean);
    expect(results.entries.length).toBeGreaterThan(0);
  });
});
