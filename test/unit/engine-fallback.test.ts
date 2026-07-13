/**
 * Backend resolution (engine.ts resolveEvaluator): explicit requests are
 * binding, `backend: "auto"` degrades gpu → workers → cpu with the reasons
 * accumulated in results.backend.note, and `workers: false` opts out of
 * auto's workers tier (BRIEF §6.2 treats it as the single-thread spelling).
 *
 * Hermetic: the GPU tier is driven through the public factory registry (no
 * GPU needed); auto runs pass `workers: false` and the explicit-workers
 * rejection uses a nonexistent script, so no dist/worker.js is required.
 * The worker-tier degradation itself is covered by
 * engine-fallback-workers.test.ts (mocked pool).
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  apriori,
  BackendError,
  binary,
  fromColumns,
  nominalSelectors,
  registerGpuEvaluatorFactory,
  type SubgroupResults,
  wracc,
} from "../../src/index.js";

// 'auto' reaches for accelerators at rows × selectors ≥ 1<<24 (engine.ts
// AUTO_HEAVY_CELLS). 4100 rows × 4100 single-row selectors = 16,810,000
// cells ≥ 16,777,216, while staying trivial to evaluate at depth 1.
const N = 4100;
const v: string[] = [];
const y: number[] = [];
for (let i = 0; i < N; i++) {
  v.push(`v${i}`);
  y.push(i % 3 === 0 ? 1 : 0);
}
const table = fromColumns({ v, y });
const searchSpace = nominalSelectors(table, { ignore: ["y"] });

const task = () => ({
  table,
  target: binary({ attribute: "y", value: 1 }),
  searchSpace,
  qf: wracc(),
  resultSetSize: 5,
  depth: 1,
});

afterEach(() => {
  registerGpuEvaluatorFactory(null);
});

function expectIdenticalResults(a: SubgroupResults, b: SubgroupResults): void {
  expect(a.entries.map((e) => e.description.canonicalKey())).toEqual(
    b.entries.map((e) => e.description.canonicalKey()),
  );
  for (let i = 0; i < a.entries.length; i++) {
    expect(Object.is(a.entries[i]!.quality, b.entries[i]!.quality)).toBe(true);
  }
  expect(a.candidatesEvaluated).toBe(b.candidatesEvaluated);
  expect(a.candidatesPruned).toBe(b.candidatesPruned);
}

describe("backend 'auto' degradation (engine.ts resolveEvaluator)", () => {
  it("throwing GPU factory: auto degrades to cpu with a note, bit-identical results", async () => {
    registerGpuEvaluatorFactory(async () => {
      throw new BackendError("requestAdapter() returned null");
    });
    const auto = await apriori(task(), { backend: "auto", workers: false });
    registerGpuEvaluatorFactory(null);
    const cpu = await apriori(task(), { backend: "cpu" });

    expect(auto.backend?.name).toBe("cpu");
    expect(auto.backend?.note).toContain("auto: webgpu unavailable");
    expect(auto.backend?.note).toContain("requestAdapter() returned null");
    expectIdenticalResults(auto, cpu);
  });

  it("factory returning null (outside applicability): auto stays silent, note null", async () => {
    registerGpuEvaluatorFactory(async () => null);
    const auto = await apriori(task(), { backend: "auto", workers: false });
    expect(auto.backend?.name).toBe("cpu");
    expect(auto.backend?.note).toBeNull();
  });

  it("no factory registered: auto uses cpu silently", async () => {
    const auto = await apriori(task(), { backend: "auto", workers: false });
    expect(auto.backend?.name).toBe("cpu");
    expect(auto.backend?.note).toBeNull();
  });

  it("workers: false opts out of auto's workers tier (single-thread cpu)", async () => {
    // No GPU factory; heavy task; workers explicitly false → the run must
    // resolve to the single-thread evaluator, not the pool.
    const auto = await apriori(task(), { backend: "auto", workers: false });
    expect(auto.backend?.name).toBe("cpu");
  });
});

describe("explicit backend requests keep throwing", () => {
  it("backend 'webgpu' with a throwing factory rejects", async () => {
    registerGpuEvaluatorFactory(async () => {
      throw new BackendError("requestAdapter() returned null");
    });
    await expect(apriori(task(), { backend: "webgpu" })).rejects.toThrow(
      /requestAdapter\(\) returned null/,
    );
  });

  it("backend 'webgpu' with no factory registered rejects", async () => {
    await expect(apriori(task(), { backend: "webgpu" })).rejects.toThrow(
      /no GPU factory is registered/,
    );
  });

  it("explicit workers with a nonexistent script rejects (spawn failure is binding)", async () => {
    await expect(
      apriori(task(), {
        workers: {
          script: "./nonexistent-worker-for-engine-fallback-test.js",
          count: 1,
          spawnTimeoutMs: 500,
          noCache: true,
        },
      }),
    ).rejects.toThrow(/worker/);
  });
});
