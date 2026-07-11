/**
 * M2 differential formula gate (BRIEF §6.3, spec §6): per-subgroup QF values
 * on fixed description lists vs the pinned reference. Agreement is rel ≤ 1e-9
 * (abs floor 1e-15 for mathematically-zero quantities, spec §6.11); any
 * disagreeing row must carry an adjudication id from the generator
 * (COMPATIBILITY.md), else the gate fails.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CoverEvalContext, prepareTarget } from "../../src/index.js";
import { loadDataset } from "../util/datasets.js";
import { FIXTURES_DIR, type FixtureConjunction, loadJson } from "../util/fixtures.js";
import { recordDivergence, recordGateRow } from "../util/gaterow.js";
import {
  fixtureConjunction,
  makeQF,
  makeTarget,
  type QfSpec,
  type TargetSpec,
  valuesAgree,
} from "../util/qf.js";

interface QfValuesFixture {
  id: string;
  config: {
    dataset: string;
    target: TargetSpec;
    ignore: string[];
  };
  descriptions: { description: FixtureConjunction; cover_size: number; adj: string[] }[];
  qfs: { qf: QfSpec; values: number[]; adjAllRows?: string }[];
}

const files = fs
  .readdirSync(path.join(FIXTURES_DIR, "qfvalues"))
  .filter((f) => f.endsWith(".json"))
  .sort();

let compared = 0;
let agreed = 0;
let adjudicated = 0;
const unadjudicated: string[] = [];

describe("differential QF values vs pysubgroup 0.9.0 (rel 1e-9)", () => {
  for (const file of files) {
    const fixture = loadJson(`qfvalues/${file}`) as QfValuesFixture;
    it(`${fixture.id}: ${fixture.descriptions.length} descriptions x ${fixture.qfs.length} qfs`, () => {
      const table = loadDataset(fixture.config.dataset);
      const target = makeTarget(fixture.config.target);
      const prepared = prepareTarget(table, target);
      const ctx = new CoverEvalContext(table, prepared);
      const descs = fixture.descriptions.map((d) => ({
        conj: fixtureConjunction(d.description.selectors),
        coverSize: d.cover_size,
        adj: d.adj,
        str: d.description.str,
      }));

      for (const block of fixture.qfs) {
        const qf = makeQF(block.qf, 3);
        for (let i = 0; i < descs.length; i++) {
          const d = descs[i]!;
          const ref = block.values[i]!;
          const ours = ctx.evaluate(qf, d.conj);
          compared++;
          if (valuesAgree(ours, ref)) {
            agreed++;
            continue;
          }
          const adjIds = [...d.adj];
          if (block.adjAllRows) adjIds.push(block.adjAllRows);
          if (adjIds.length > 0) {
            adjudicated++;
            recordDivergence({
              id: `qfvalues:${fixture.id}:${qf.name}:${i}`,
              cell: fixture.id,
              summary:
                `${qf.name} on ${d.str} (cover ${d.coverSize}): ` +
                `ours ${ours} vs reference ${ref}`,
              adjudication: adjIds[0]!,
            });
          } else {
            unadjudicated.push(
              `${fixture.id} ${qf.name} #${i} ${d.str}: ours ${ours} vs ref ${ref}`,
            );
          }
        }
      }
      expect(unadjudicated, unadjudicated.join("\n")).toEqual([]);
    });
  }

  it("records the gate row", () => {
    recordGateRow({
      id: "m2-qf-differential",
      cell: files.map((f) => f.replace(".json", "")).join(","),
      check: "per-subgroup QF values vs reference (rel<=1e-9; divergences adjudicated)",
      value: `${compared} values: ${agreed} agree, ${adjudicated} adjudicated, ${unadjudicated.length} unexplained`,
      expected: "0 unexplained",
      gate: true,
      pass: unadjudicated.length === 0 && compared > 0,
    });
    expect(unadjudicated.length).toBe(0);
    expect(compared).toBeGreaterThan(300);
  });
});
