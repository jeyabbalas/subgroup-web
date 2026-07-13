/**
 * §6.2 GPU exactness + cross-backend identity gates (browser, real GPU —
 * BRIEF §12: fail, don't skip) and the §12 empirical band validation.
 *
 * Node side computes the ground truth per cell — the exhaustive oracle and
 * single-thread CPU runs over the identical committed CSV bytes — then the
 * page (dist/ build, Chromium, Metal) runs the same cells with
 * backend: 'webgpu', in-browser workers (SAB and non-SAB), and in-browser
 * single-thread CPU. Every EXACT algorithm must equal the oracle exactly;
 * beamSearch (heuristic, fully specified) and generalizingBFS (disjunction
 * space) must be bit-identical to their Node CPU baselines.
 *
 * Band statistics (screened/rescored admissions; empirical |GPU−f64| vs the
 * derived bounds) are printed for the M6 acceptance record.
 */
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import {
  apriori,
  beamSearch,
  bestFirst,
  dfs,
  exhaustive,
  generalizingBFS,
  type SubgroupResults,
} from "../../src/index.js";
import { fingerprint } from "../exactness/runner.js";
import { buildTask, type CellSpec } from "../util/cells.js";
import { recordGateRow } from "../util/gaterow.js";
import { serveRepo, type TestServer } from "./serve.js";

const CELLS: (CellSpec & { algorithms: string[]; browserConfigs: string[] })[] = [
  {
    id: "b-titanic-wracc-d2-k5",
    dataset: "titanic",
    target: { type: "binary", attribute: "Survived", value: 1 },
    space: { ignore: ["Survived"], nbins: 5 },
    qf: { name: "wracc" },
    depth: 2,
    k: 5,
    minQuality: 0,
    algorithms: ["apriori", "dfs", "bestFirst", "beam", "generalizingBFS"],
    browserConfigs: ["gpu", "cpu", "workers-sab", "workers-nosab"],
  },
  {
    id: "b-creditg-stdnum-sum-d2-k10",
    dataset: "credit-g",
    target: { type: "numeric", attribute: "age" },
    space: { ignore: ["age", "class"], nbins: 5 },
    qf: { name: "standardNumeric", a: 1, estimator: "sum" },
    depth: 2,
    k: 10,
    minQuality: 0,
    algorithms: ["apriori", "dfs", "bestFirst", "beam"],
    browserConfigs: ["gpu", "cpu", "workers-sab", "workers-nosab"],
  },
  {
    id: "b-creditg-stdnum-a05-invert-d2-k10",
    dataset: "credit-g",
    target: { type: "numeric", attribute: "age" },
    space: { ignore: ["age", "class"], nbins: 5 },
    qf: { name: "standardNumeric", a: 0.5, invert: true },
    depth: 2,
    k: 10,
    minQuality: 0,
    algorithms: ["apriori"],
    browserConfigs: ["gpu"],
  },
  {
    id: "b-creditg-fi-area-d2-k10",
    dataset: "credit-g",
    target: { type: "fi" },
    space: { ignore: ["class"], nbins: 5 },
    qf: { name: "area" },
    depth: 2,
    k: 10,
    minQuality: 0,
    algorithms: ["apriori", "generalizingBFS"],
    browserConfigs: ["gpu"],
  },
  {
    id: "b-tie-stress-wracc-d3-k10",
    dataset: "synth:tie-stress",
    target: { type: "binary", attribute: "y", value: 1 },
    space: { ignore: ["y"] },
    qf: { name: "wracc" },
    depth: 3,
    k: 10,
    minQuality: Number.NEGATIVE_INFINITY,
    algorithms: ["apriori", "bestFirst"],
    browserConfigs: ["gpu"],
  },
  {
    id: "b-na-stress-wracc-negations-d2-k10",
    dataset: "synth:na-stress",
    target: { type: "binary", attribute: "y", value: 1 },
    space: { ignore: ["y", "t", "x2"], negations: true },
    qf: { name: "wracc" },
    depth: 2,
    k: 10,
    minQuality: Number.NEGATIVE_INFINITY,
    algorithms: ["apriori"],
    browserConfigs: ["gpu"],
  },
  {
    id: "b-planted-binary-500-wracc-d2-k5",
    dataset: "synth:planted-binary-500",
    target: { type: "binary", attribute: "y", value: 1 },
    space: { ignore: ["y"] },
    qf: { name: "wracc" },
    depth: 2,
    k: 5,
    minQuality: 0,
    algorithms: ["apriori"],
    browserConfigs: ["gpu"],
  },
  {
    id: "b-planted-numeric-500-stdnum-d2-k5",
    dataset: "synth:planted-numeric-500",
    target: { type: "numeric", attribute: "t" },
    space: { ignore: ["t"] },
    qf: { name: "standardNumeric", a: 1 },
    depth: 2,
    k: 5,
    minQuality: 0,
    algorithms: ["apriori"],
    browserConfigs: ["gpu"],
  },
];

const NODE_ALGOS: Record<string, (t: ReturnType<typeof buildTask>) => Promise<SubgroupResults>> = {
  apriori: (t) => apriori(t),
  dfs: (t) => dfs(t),
  bestFirst: (t) => bestFirst(t),
  beam: (t) => beamSearch(t, { width: Math.max(20, t.resultSetSize ?? 10) }),
  generalizingBFS: (t) => generalizingBFS(t),
};

/** Algorithms whose results must equal the conjunction-space oracle. */
const EXACT_VS_ORACLE = new Set(["apriori", "dfs", "bestFirst"]);

const BROWSER_OPTIONS: Record<string, object> = {
  gpu: { backend: "webgpu" },
  cpu: {},
  "workers-sab": { workers: { count: 2, localThreshold: 0 } },
  "workers-nosab": { workers: { count: 2, sharedMemory: false, localThreshold: 0 } },
};

interface PageRun {
  fingerprint: { key: string; quality: number }[];
  backend: {
    name: string;
    note: string | null;
    band: { screened: number; rescored: number } | null;
  } | null;
  evaluated: number;
  crossOriginIsolated: boolean;
}

let server: TestServer;
test.beforeAll(async () => {
  server = await serveRepo();
});
test.afterAll(async () => {
  await server?.close();
});

async function openHarness(page: Page): Promise<void> {
  page.on("console", (m) => {
    if (m.type() === "error" || m.type() === "warning") {
      console.log(`[page ${m.type()}] ${m.text()}`);
    }
  });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto(`${server.baseUrl}/test/browser/pages/harness.html`);
  await page.waitForFunction(() => document.getElementById("status")?.textContent === "ready");
}

function sameFp(
  a: { key: string; quality: number }[],
  b: { key: string; quality: number }[],
): boolean {
  return (
    a.length === b.length &&
    a.every((x, i) => x.key === b[i]!.key && Object.is(x.quality, b[i]!.quality))
  );
}

test("GPU exactness + cross-backend identity across the browser matrix", async ({ page }) => {
  test.setTimeout(900_000);
  await openHarness(page);
  const adapter = await page.evaluate(() =>
    (
      globalThis as never as { subgroupWebHarness: { adapterInfo(): Promise<unknown> } }
    ).subgroupWebHarness.adapterInfo(),
  );
  console.log(`adapter: ${JSON.stringify(adapter)}`);
  expect(adapter, "a real GPU adapter is required (fail, don't skip)").not.toBeNull();

  let comparisons = 0;
  const failuresList: string[] = [];
  let gpuRuns = 0;
  let bandScreened = 0;
  let bandRescored = 0;

  for (const cell of CELLS) {
    const oracle = fingerprint(await exhaustive(buildTask(cell)));
    for (const algo of cell.algorithms) {
      const nodeBase = fingerprint(await NODE_ALGOS[algo]!(buildTask(cell)));
      // The Node baseline of an exact algorithm must equal the oracle
      // (belt-and-braces; the Node suite gates this too).
      if (EXACT_VS_ORACLE.has(algo)) {
        expect(sameFp(nodeBase, oracle), `${cell.id}/${algo}: node baseline vs oracle`).toBe(true);
      }
      for (const config of cell.browserConfigs) {
        const run = (await page.evaluate(
          ([c, a, o]) =>
            (
              globalThis as never as {
                subgroupWebHarness: {
                  runCell(c: unknown, a: unknown, o: unknown): Promise<unknown>;
                };
              }
            ).subgroupWebHarness.runCell(c, a, o),
          [cell, algo, BROWSER_OPTIONS[config]] as const,
        )) as PageRun;
        comparisons++;
        const label = `${cell.id}/${algo}/${config}`;
        if (config === "gpu") {
          gpuRuns++;
          expect(
            run.backend?.name.startsWith("webgpu("),
            `${label}: GPU backend must engage (got ${run.backend?.name})`,
          ).toBe(true);
          if (run.backend?.band) {
            bandScreened += run.backend.band.screened;
            bandRescored += run.backend.band.rescored;
          }
        }
        if (config.startsWith("workers")) {
          expect(
            run.backend?.name.startsWith("cpu-workers("),
            `${label}: worker pool must engage (got ${run.backend?.name})`,
          ).toBe(true);
          expect(run.backend?.name.includes("sab")).toBe(config === "workers-sab");
        }
        const same = sameFp(run.fingerprint, nodeBase);
        if (!same) failuresList.push(label);
        expect(same, `${label}: browser result must be bit-identical to Node baseline`).toBe(true);
        if (EXACT_VS_ORACLE.has(algo)) {
          expect(
            sameFp(run.fingerprint, oracle),
            `${label}: exact algorithm must equal the oracle exactly`,
          ).toBe(true);
        }
      }
    }
  }

  console.log(
    `backend-identity: ${comparisons} browser runs compared, ${failuresList.length} mismatches; ` +
      `gpu band totals: screened=${bandScreened} rescored=${bandRescored}`,
  );
  recordGateRow({
    id: "m6-backend-identity",
    cell: `${CELLS.length} cells × algos × {gpu, cpu, workers±sab}`,
    check: "browser backends bit-identical to Node baseline (exact algos: == oracle)",
    value: `${comparisons - failuresList.length}/${comparisons} identical`,
    expected: `${comparisons}/${comparisons}`,
    gate: true,
    pass: failuresList.length === 0 && comparisons > 0,
  });
  recordGateRow({
    id: "m6-exactness-gpu",
    cell: `${CELLS.length} browser cells`,
    check: "webgpu-backed runs green on a real adapter",
    value: `${gpuRuns} gpu runs; band screened=${bandScreened} rescored=${bandRescored}`,
    expected: `>= ${CELLS.length} gpu runs`,
    gate: true,
    pass: gpuRuns >= CELLS.length && failuresList.length === 0,
  });
});

test("GPU pruning-identity and forced atlas chunking", async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  const cells = [CELLS[0]!, CELLS[1]!];
  let ok = 0;
  let total = 0;
  for (const cell of cells) {
    const oracle = fingerprint(await exhaustive(buildTask(cell)));
    for (const options of [
      { backend: "webgpu", pruning: false },
      { backend: "webgpu", pruning: true },
    ]) {
      const run = (await page.evaluate(
        ([c, o]) =>
          (
            globalThis as never as {
              subgroupWebHarness: { runCell(c: unknown, a: unknown, o: unknown): Promise<unknown> };
            }
          ).subgroupWebHarness.runCell(c, "apriori", o),
        [cell, options] as const,
      )) as PageRun;
      total++;
      if (sameFp(run.fingerprint, oracle)) ok++;
    }
    // Forced multi-chunk atlas (A14 path): re-register with tiny chunks.
    const chunked = (await page.evaluate(
      async ([c]) => {
        const h = (
          globalThis as never as {
            subgroupWebHarness: {
              registerWebGpu(o: unknown): void;
              runCell(c: unknown, a: unknown, o: unknown): Promise<unknown>;
            };
          }
        ).subgroupWebHarness;
        h.registerWebGpu({ evaluator: { forceChunkBytes: 4096 } });
        const out = await h.runCell(c, "apriori", { backend: "webgpu" });
        h.registerWebGpu({});
        return out;
      },
      [cell] as const,
    )) as PageRun;
    total++;
    expect(
      chunked.backend?.name.includes("chunks=") && !chunked.backend.name.includes("chunks=1"),
      `${cell.id}: forced chunking must split the atlas (got ${chunked.backend?.name})`,
    ).toBe(true);
    if (sameFp(chunked.fingerprint, oracle)) ok++;

    // Forced multi-GROUP dispatches (A14 word budget): a tiny budget splits
    // each batch into many dispatch groups, exercising the candBase-offset
    // writes of the shared out buffer (single readback per call).
    const grouped = (await page.evaluate(
      async ([c]) => {
        const h = (
          globalThis as never as {
            subgroupWebHarness: {
              registerWebGpu(o: unknown): void;
              runCell(c: unknown, a: unknown, o: unknown): Promise<unknown>;
            };
          }
        ).subgroupWebHarness;
        h.registerWebGpu({ evaluator: { maxWordsPerDispatch: 4096 } });
        const out = await h.runCell(c, "apriori", { backend: "webgpu" });
        h.registerWebGpu({});
        return out;
      },
      [cell] as const,
    )) as PageRun;
    total++;
    if (sameFp(grouped.fingerprint, oracle)) ok++;

    // Forced pair-RUN chunking (Y workgroups/dimension ≤ 65535): a tiny
    // maxRunsPerDispatch splits the grouped arity-2 counts dispatches into
    // many queue-ordered submits over one cleared out buffer (absolute
    // indices). Only counts targets route through runPairs; the numeric
    // cell exercises the option being inert there.
    const runsChunked = (await page.evaluate(
      async ([c]) => {
        const h = (
          globalThis as never as {
            subgroupWebHarness: {
              registerWebGpu(o: unknown): void;
              runCell(c: unknown, a: unknown, o: unknown): Promise<unknown>;
            };
          }
        ).subgroupWebHarness;
        h.registerWebGpu({ evaluator: { maxRunsPerDispatch: 3 } });
        const out = await h.runCell(c, "apriori", { backend: "webgpu" });
        h.registerWebGpu({});
        return out;
      },
      [cell] as const,
    )) as PageRun;
    total++;
    if (sameFp(runsChunked.fingerprint, oracle)) ok++;
  }
  expect(ok).toBe(total);
  recordGateRow({
    id: "m6-gpu-pruning-chunking",
    cell: "titanic-wracc + creditg-stdnum",
    check:
      "GPU pruning on/off == oracle; forced atlas chunking + dispatch grouping + " +
      "pair-run chunking == oracle",
    value: `${ok}/${total} identical`,
    expected: `${total}/${total}`,
    gate: true,
    pass: ok === total && total > 0,
  });
});

interface BandStats {
  candidates: number;
  sizeMismatches: number;
  sumViolations: number;
  excessViolations: number;
  maxSumErr: number;
  maxSumEps: number;
  maxRelSumErr: number;
  screening: boolean;
}

test("§12 empirical band validation (GPU screening vs f64 bounds)", async ({ page }) => {
  test.setTimeout(600_000);
  await openHarness(page);
  // Two numeric fixtures: credit-g age (integer values — f32-exact sums,
  // exercising the zero-error regime) and planted-numeric-500 (gaussian
  // values — real f32 rounding, exercising the bound itself).
  const numericCells = [CELLS[1]!, CELLS[7]!];
  const binaryCell = CELLS[0]!;
  const runBand = async (cell: CellSpec): Promise<BandStats> =>
    (await page.evaluate(
      ([c]) =>
        (
          globalThis as never as {
            subgroupWebHarness: { validateBand(c: unknown): Promise<unknown> };
          }
        ).subgroupWebHarness.validateBand(c),
      [cell] as const,
    )) as BandStats;

  let pass = true;
  let totalCandidates = 0;
  let worstRel = 0;
  for (const cell of numericCells) {
    const numeric = await runBand(cell);
    console.log(
      `band(numeric ${cell.id}): candidates=${numeric.candidates} ` +
        `sumViolations=${numeric.sumViolations} excessViolations=${numeric.excessViolations} ` +
        `sizeMismatches=${numeric.sizeMismatches} maxSumErr=${numeric.maxSumErr.toExponential(3)} ` +
        `maxSumEps=${numeric.maxSumEps.toExponential(3)} maxRelSumErr=${numeric.maxRelSumErr.toExponential(3)}`,
    );
    expect(numeric.screening, `${cell.id}: numeric GPU batches are screening`).toBe(true);
    expect(numeric.sizeMismatches, `${cell.id}: GPU sizes are u32-exact`).toBe(0);
    expect(numeric.sumViolations, `${cell.id}: |GPU sum − f64 sum| within sumEps`).toBe(0);
    expect(numeric.excessViolations, `${cell.id}: |GPU excess − f64| within excessEps`).toBe(0);
    expect(numeric.maxRelSumErr, `${cell.id}: empirical rel ≤ 1e-5 (BRIEF §12)`).toBeLessThan(1e-5);
    pass =
      pass &&
      numeric.sumViolations === 0 &&
      numeric.excessViolations === 0 &&
      numeric.sizeMismatches === 0 &&
      numeric.maxRelSumErr < 1e-5;
    totalCandidates += numeric.candidates;
    worstRel = Math.max(worstRel, numeric.maxRelSumErr);
  }

  const binary = (await runBand(binaryCell)) as unknown as {
    candidates: number;
    sizeMismatches: number;
    screening: boolean;
  };
  console.log(
    `band(binary ${binaryCell.id}): candidates=${binary.candidates} ` +
      `mismatches=${binary.sizeMismatches} (integer-exact regime)`,
  );
  expect(binary.screening).toBe(false);
  expect(binary.sizeMismatches, "binary counts integer-exact on GPU").toBe(0);
  pass = pass && binary.sizeMismatches === 0;
  totalCandidates += binary.candidates;

  recordGateRow({
    id: "m6-gpu-band",
    cell: `${numericCells.map((c) => c.id).join(" + ")} + ${binaryCell.id}`,
    check: "GPU screening errors within derived bounds; counts integer-exact; rel ≤ 1e-5",
    value: `${totalCandidates} candidates, 0 violations, maxRel=${worstRel.toExponential(2)}`,
    expected: "0 violations",
    gate: true,
    pass,
  });
});
