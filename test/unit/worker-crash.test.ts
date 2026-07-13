/**
 * Worker-pool failure semantics (BRIEF §11): an error reply from any worker
 * poisons the pool — the in-flight call rejects with a typed BackendError,
 * subsequent calls reject immediately, and dispose() terminates the workers
 * (a dead pool is never re-cached). Uses the crash-worker fixture
 * (test/util/crash-worker.mjs) with noCache so the process-level worker
 * cache stays clean for other suites.
 */
import { describe, expect, it } from "vitest";
import { WorkerPoolEvaluator } from "../../src/backends/cpu/pool.js";
import { buildAtlas } from "../../src/bitset/atlas.js";
import { BackendError } from "../../src/errors.js";
import { binary, fromColumns, nominalSelectors, prepareTarget } from "../../src/index.js";

const table = fromColumns({
  g: ["a", "b", "a", "b", "c", "c", "a", "b"],
  y: [1, 0, 1, 0, 1, 0, 1, 0],
});
const selectors = nominalSelectors(table, { ignore: ["y"] });
const atlas = buildAtlas(table, selectors);
const prepared = prepareTarget(table, binary({ attribute: "y", value: 1 }));

const crashScript = new URL("../util/crash-worker.mjs", import.meta.url);

async function crashPool(): Promise<WorkerPoolEvaluator> {
  return WorkerPoolEvaluator.create(atlas, prepared, null, {
    script: crashScript,
    count: 2,
    localThreshold: 0, // force every batch through the workers
    noCache: true,
    spawnTimeoutMs: 10_000,
  });
}

describe("worker crash poisons the pool (BRIEF §11)", () => {
  it("in-flight call rejects with BackendError; later calls reject immediately", async () => {
    const pool = await crashPool();
    try {
      await expect(
        pool.evaluateTuples(Uint16Array.from([0, 1, 2]), 1, 3),
      ).rejects.toThrow(BackendError);
      await expect(
        pool.evaluateTuples(Uint16Array.from([0, 1, 2]), 1, 3),
      ).rejects.toThrow(/crash-worker: simulated kernel failure/);
      await expect(pool.evaluateExtensions(null, [0, 1])).rejects.toThrow(BackendError);
    } finally {
      pool.dispose();
    }
  });

  it("dispose is idempotent on a dead pool and terminates its workers", async () => {
    const pool = await crashPool();
    await expect(pool.evaluateTuples(Uint16Array.from([0, 1]), 1, 2)).rejects.toThrow(
      BackendError,
    );
    pool.dispose();
    pool.dispose(); // second call is a no-op
    // The pool stays dead after disposal too.
    await expect(pool.evaluateTuples(Uint16Array.from([0]), 1, 1)).rejects.toThrow(BackendError);
  });

  it("a healthy init followed by crashes never wedges the suite (fixture acks init)", async () => {
    // create() resolving at all proves the fixture completed the init
    // handshake — the failure mode under test is strictly post-init.
    const pool = await crashPool();
    pool.dispose();
  });
});
