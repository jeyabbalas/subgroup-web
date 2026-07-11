/**
 * §6.2 exactness assertions: an exact algorithm's result must equal the
 * exhaustive oracle's top-k EXACTLY — same descriptions, same canonical
 * order, and (CPU) bit-identical qualities: every engine computes statistics
 * through the same kernels and qualities through the same QF code path, so
 * the gate asserts Object.is equality, strictly tighter than the BRIEF's
 * rel ≤ 1e-9 allowance. Pruning-disabled runs must additionally evaluate the
 * entire candidate space (structural check: counts match the oracle's).
 */
import { expect } from "vitest";
import { apriori, bestFirst, dfs, exhaustive, type SubgroupResults } from "../../src/index.js";
import { buildTask, type CellSpec } from "../util/cells.js";

export const EXACT_ALGORITHMS = { apriori, dfs, bestFirst } as const;
export type ExactAlgorithmName = keyof typeof EXACT_ALGORITHMS;

export function fingerprint(results: SubgroupResults): { key: string; quality: number }[] {
  return results.entries.map((e) => ({
    key: e.description.canonicalKey(),
    quality: e.quality,
  }));
}

export function assertSameResults(
  label: string,
  ours: SubgroupResults,
  oracle: SubgroupResults,
): void {
  const a = fingerprint(ours);
  const b = fingerprint(oracle);
  expect(
    a.map((r) => `${r.key} @ ${r.quality}`),
    `${label}: result list must equal the oracle's exactly`,
  ).toEqual(b.map((r) => `${r.key} @ ${r.quality}`));
  for (let i = 0; i < a.length; i++) {
    expect(
      Object.is(a[i]!.quality, b[i]!.quality),
      `${label} rank ${i}: quality ${a[i]!.quality} must be bit-identical to oracle ${b[i]!.quality}`,
    ).toBe(true);
  }
}

export interface CellOutcome {
  cellId: string;
  candidates: number;
  /** evaluated with pruning on, per algorithm. */
  evaluatedOn: Record<ExactAlgorithmName, number>;
}

/** Run one cell through oracle + every algorithm × pruning on/off. */
export async function runExactnessCell(cell: CellSpec): Promise<CellOutcome> {
  const oracle = await exhaustive(buildTask(cell));
  const outcome: CellOutcome = {
    cellId: cell.id,
    candidates: oracle.candidatesEvaluated,
    evaluatedOn: { apriori: 0, dfs: 0, bestFirst: 0 },
  };
  for (const [name, algorithm] of Object.entries(EXACT_ALGORITHMS) as [
    ExactAlgorithmName,
    (typeof EXACT_ALGORITHMS)[ExactAlgorithmName],
  ][]) {
    const on = await algorithm(buildTask(cell));
    const off = await algorithm(buildTask(cell), { pruning: false });
    assertSameResults(`${cell.id}/${name}/pruning-on`, on, oracle);
    assertSameResults(`${cell.id}/${name}/pruning-off`, off, oracle);
    expect(
      off.candidatesEvaluated,
      `${cell.id}/${name}: pruning-off must enumerate the full candidate space`,
    ).toBe(oracle.candidatesEvaluated);
    expect(
      on.candidatesEvaluated,
      `${cell.id}/${name}: pruning must never evaluate more than full enumeration`,
    ).toBeLessThanOrEqual(off.candidatesEvaluated);
    outcome.evaluatedOn[name] = on.candidatesEvaluated;
  }
  return outcome;
}
