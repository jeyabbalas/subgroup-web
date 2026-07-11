/**
 * Top-k differential gate (BRIEF §6.3; spec §3.3, §6.11): the exhaustive
 * oracle's results vs the pinned reference's per-cell fixtures.
 *
 * Tie mapping rule (class (c), BRIEF §22-A1, COMPATIBILITY.md "Mapping
 * rules"): results are compared as quality groups. Every complete group must
 * match as a set of canonical descriptions; the final (possibly boundary-cut)
 * group must have matching group quality, and every reference member must be
 * a genuine tie (we re-evaluate its quality ourselves) — the reference cuts
 * ties by heap-order artifacts, subgroup-web by the canonical order.
 * Reference `Dataset` rows would be dropped citing ADJ-002.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoverEvalContext, exhaustive, prepareTarget } from "../../src/index.js";
import { buildTask, type CellSpec } from "../util/cells.js";
import { FIXTURES_DIR, loadTaskFixture, type TaskFixture } from "../util/fixtures.js";
import { recordDivergence, recordGateRow } from "../util/gaterow.js";
import { fixtureConjunction, makeQF, valuesAgree } from "../util/qf.js";

const cellFiles = fs
  .readdirSync(path.join(FIXTURES_DIR, "tasks"))
  .filter((f) => f.endsWith(".json"))
  .sort();

let cellsCompared = 0;
let rowsMatched = 0;
let dualChecked = 0;
let dualTotal = 0;
const failures: string[] = [];

describe("top-k differential vs pysubgroup 0.9.0 (tie-tolerant)", () => {
  for (const file of cellFiles) {
    const fixture = loadTaskFixture(file.replace(".json", "")) as TaskFixture & {
      cell: CellSpec;
    };
    const cell = fixture.cell;

    it(`${cell.id}: ${fixture.results.length} reference rows`, async () => {
      const task = buildTask(cell);
      const { table, target } = task;
      const qf = makeQF(cell.qf, cell.depth);

      const ours = await exhaustive(task);
      expect(ours.crossCheckReport.mode).toBe("full");
      dualChecked += ours.crossCheckReport.checked;
      dualTotal += ours.crossCheckReport.total;

      // Reference rows -> canonical keys + qualities (drop Dataset rows, ADJ-002).
      const refRows = fixture.results
        .filter((r) => {
          if (r.description.selectors.length === 0) {
            recordDivergence({
              id: `topk:${cell.id}:dataset-row`,
              cell: cell.id,
              summary: "reference returned the empty description",
              adjudication: "ADJ-002-empty-conjunction",
            });
            return false;
          }
          return true;
        })
        .map((r) => ({
          key: fixtureConjunction(r.description.selectors).canonicalKey(),
          conj: fixtureConjunction(r.description.selectors),
          quality: r.quality,
          str: r.description.str,
        }));
      const ourRows = ours.entries.map((e) => ({
        key: e.description.canonicalKey(),
        quality: e.quality,
        str: e.description.toString("display"),
      }));

      expect(ourRows.length, "result count").toBe(refRows.length);

      // Group both by quality (walk in order; group = maximal tie run).
      const groups = <T extends { quality: number }>(rows: T[]): T[][] => {
        const out: T[][] = [];
        for (const row of rows) {
          const last = out[out.length - 1];
          if (last && valuesAgree(last[0]!.quality, row.quality)) last.push(row);
          else out.push([row]);
        }
        return out;
      };
      const refGroups = groups(refRows);
      const ourGroups = groups(ourRows);

      const ctx = new CoverEvalContext(table, prepareTarget(table, target));
      let gi = 0;
      for (; gi < Math.min(refGroups.length, ourGroups.length); gi++) {
        const rg = refGroups[gi]!;
        const og = ourGroups[gi]!;
        const isLastRef = gi === refGroups.length - 1;
        const isLastOur = gi === ourGroups.length - 1;
        expect(
          valuesAgree(og[0]!.quality, rg[0]!.quality),
          `${cell.id} group ${gi} quality: ours ${og[0]!.quality} vs ref ${rg[0]!.quality}`,
        ).toBe(true);
        if (!isLastRef && !isLastOur) {
          const refKeys = new Set(rg.map((r) => r.key));
          const ourKeys = new Set(og.map((r) => r.key));
          expect(ourKeys, `${cell.id} group ${gi} description sets`).toEqual(refKeys);
          rowsMatched += rg.length;
        } else {
          // Boundary group: sizes match (equal counts + equal earlier groups);
          // verify every reference member is a genuine tie at this quality.
          expect(og.length, `${cell.id} boundary group size`).toBe(rg.length);
          for (const r of rg) {
            const q = ctx.evaluate(qf, r.conj);
            expect(
              valuesAgree(q, rg[0]!.quality),
              `${cell.id}: reference boundary member ${r.str} re-evaluates to ${q}, group quality ${rg[0]!.quality}`,
            ).toBe(true);
            rowsMatched++;
          }
          break;
        }
      }
      cellsCompared++;
    });
  }

  it("records the gate row", () => {
    recordGateRow({
      id: "m3-topk-differential",
      cell: cellFiles.map((f) => f.replace(".json", "")).join(","),
      check: "exhaustive top-k == reference fixtures (tie-tolerant groups, rel<=1e-9)",
      value: `${cellsCompared}/${cellFiles.length} cells, ${rowsMatched} rows matched`,
      expected: `${cellFiles.length} cells`,
      gate: true,
      pass: cellsCompared === cellFiles.length && failures.length === 0,
    });
    expect(cellsCompared).toBe(cellFiles.length);
    recordGateRow({
      id: "m3-dualpath-oracle",
      cell: "all-task-cells",
      check: "oracle dual statistics paths agree (bitset vs row-scan, every candidate)",
      value: `${dualChecked}/${dualTotal} candidates cross-checked`,
      expected: "full coverage, zero disagreements",
      gate: true,
      pass: dualChecked === dualTotal && dualTotal > 0,
    });
  });
});
