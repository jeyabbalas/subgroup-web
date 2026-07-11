/**
 * §6.2 cross-backend identity (CPU side): the worker-pool evaluator must
 * return BIT-IDENTICAL result lists to the single-thread evaluator — same
 * descriptions, same canonical order, Object.is-equal qualities — across
 * targets, QF plans, and algorithms, in both the SharedArrayBuffer and the
 * copy (GitHub-Pages, non-SAB) memory regimes. The GPU third of the identity
 * gate runs in the browser suite (test/browser/backends.spec.ts).
 *
 * Requires `dist/worker.js` (pnpm gate builds before testing).
 */
import { describe, expect, test } from "vitest";
import {
  apriori,
  beamSearch,
  bestFirst,
  dfs,
  generalizingBFS,
  type SearchOptions,
  type SubgroupResults,
} from "../../src/index.js";
import { buildTask, type CellSpec } from "../util/cells.js";
import { recordGateRow } from "../util/gaterow.js";
import { EXACTNESS_CELLS } from "./cells.js";
import { fingerprint } from "./runner.js";

const CELL_IDS = [
  "x-titanic-wracc-d2-k5",
  "x-creditg-wracc-negations-d2-k10",
  "x-creditg-stdnum-sum-d2-k10",
  "x-creditg-stdnum-average-d2-k10",
  "x-creditg-stdnum-order-d2-k10",
  "x-na-stress-median-d2-k8",
  "x-creditg-fi-area-d2-k10",
  "x-creditg-emm-d1-k5",
  "x-tie-stress-wracc-d3-k10",
  "x-titanic-gastandard-d2-k8",
] as const;

const cells: CellSpec[] = CELL_IDS.map((id) => {
  const cell = EXACTNESS_CELLS.find((c) => c.id === id);
  if (!cell) throw new Error(`unknown identity cell ${id}`);
  return cell;
});

type Algo = (
  task: ReturnType<typeof buildTask>,
  options: SearchOptions,
) => Promise<SubgroupResults>;

function algorithmsFor(cell: CellSpec): [string, Algo][] {
  const out: [string, Algo][] = [
    ["apriori", (t, o) => apriori(t, o)],
    ["dfs", (t, o) => dfs(t, o)],
    ["bestFirst", (t, o) => bestFirst(t, o)],
    ["beam", (t, o) => beamSearch(t, { ...o, width: Math.max(20, cell.k) })],
  ];
  // Disjunction engine: stats-level QFs only (spec §7.11).
  if (["wracc", "count", "area"].includes(cell.qf.name)) {
    out.push(["generalizingBFS", (t, o) => generalizingBFS(t, o)]);
  }
  return out;
}

/** SAB pool, then the copy-regime pool (browser-on-Pages semantics). */
const POOL_CONFIGS: [string, SearchOptions][] = [
  ["workers-sab", { workers: { count: 3, localThreshold: 0 } }],
  ["workers-nosab", { workers: { count: 2, sharedMemory: false, localThreshold: 0 } }],
];

let comparisons = 0;
let failures = 0;

describe("m6 cross-backend identity: single-thread vs worker pool", () => {
  for (const cell of cells) {
    test(`${cell.id}`, async () => {
      for (const [algoName, algo] of algorithmsFor(cell)) {
        const single = await algo(buildTask(cell), {});
        expect(single.backend?.name).toBe("cpu");
        const base = fingerprint(single);
        for (const [poolName, options] of POOL_CONFIGS) {
          const pooled = await algo(buildTask(cell), options);
          expect(
            pooled.backend?.name.startsWith("cpu-workers("),
            `${cell.id}/${algoName}/${poolName}: pool must actually engage ` +
              `(got ${pooled.backend?.name})`,
          ).toBe(true);
          expect(
            pooled.backend?.name.includes("sab"),
            `${cell.id}/${algoName}/${poolName}: memory regime must match the config`,
          ).toBe(poolName === "workers-sab");
          const got = fingerprint(pooled);
          comparisons++;
          const same =
            got.length === base.length &&
            got.every((g, i) => g.key === base[i]!.key && Object.is(g.quality, base[i]!.quality));
          if (!same) failures++;
          expect(
            same,
            `${cell.id}/${algoName}/${poolName}: worker-pool results must be bit-identical ` +
              `to single-thread`,
          ).toBe(true);
        }
      }
    });
  }

  test("gate row: m6-backend-identity-workers", () => {
    expect(comparisons).toBeGreaterThanOrEqual(cells.length * 4 * POOL_CONFIGS.length);
    recordGateRow({
      id: "m6-backend-identity-workers",
      cell: `${cells.length} cells × algos × {sab, nosab}`,
      check: "worker-pool results bit-identical to single-thread",
      value: `${comparisons - failures}/${comparisons} identical`,
      expected: `${comparisons}/${comparisons}`,
      gate: true,
      pass: failures === 0 && comparisons > 0,
    });
  });
});
