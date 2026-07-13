/**
 * The workers tier of backend 'auto' degrades to single-thread CPU when the
 * pool cannot spawn (engine.ts resolveEvaluator). WorkerPoolEvaluator.create
 * is mocked to fail so the test is hermetic (no dist/worker.js, no threads);
 * the real spawn-failure path is covered by engine-fallback.test.ts's
 * explicit-workers rejection.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/backends/cpu/pool.js", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../../src/backends/cpu/pool.js")>();
  return {
    ...mod,
    WorkerPoolEvaluator: {
      create: async () => {
        throw new Error("mock: worker spawn failed");
      },
    },
  };
});

import {
  apriori,
  BackendError,
  binary,
  fromColumns,
  nominalSelectors,
  registerGpuEvaluatorFactory,
} from "../../src/index.js";

// Heavy per engine.ts AUTO_HEAVY_CELLS: 4100 × 4100 ≥ 1<<24.
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
  qf: {
    kind: "binary" as const,
    name: "share",
    pruningSafe: false,
    evaluate: (size: number, positives: number) => (size === 0 ? Number.NaN : positives / size),
  },
  resultSetSize: 5,
  depth: 1,
});

afterEach(() => {
  registerGpuEvaluatorFactory(null);
});

describe("auto's workers tier degrades to cpu (mocked pool)", () => {
  it("heavy auto task with failing pool → cpu with a workers note", async () => {
    const results = await apriori(task(), { backend: "auto" });
    expect(results.backend?.name).toBe("cpu");
    expect(results.backend?.note).toContain("auto: workers unavailable");
    expect(results.backend?.note).toContain("mock: worker spawn failed");
  });

  it("gpu + workers failures both land in the note, '; '-joined", async () => {
    registerGpuEvaluatorFactory(async () => {
      throw new BackendError("navigator.gpu missing");
    });
    const results = await apriori(task(), { backend: "auto" });
    expect(results.backend?.name).toBe("cpu");
    expect(results.backend?.note).toBe(
      "auto: webgpu unavailable (navigator.gpu missing); " +
        "auto: workers unavailable (mock: worker spawn failed)",
    );
  });

  it("explicit workers propagate the mocked failure", async () => {
    await expect(apriori(task(), { workers: true })).rejects.toThrow(
      /mock: worker spawn failed/,
    );
  });
});
