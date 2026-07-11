/**
 * Planted-ground-truth gates (BRIEF §6.1): the exhaustive oracle recovers
 * every implanted subgroup at rank 1, with full dual-path cross-checking; the
 * frozen CSV fixtures regenerate byte-identically (hash manifest — fixtures
 * change only via scripts/gen-synth-fixtures.mjs, BRIEF §21).
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allSelectors,
  binary,
  exhaustive,
  numeric,
  plantedBinary,
  plantedNumeric,
  removeTargetAttributes,
  standardNumeric,
  tableToCSV,
  wracc,
} from "../../src/index.js";
import { REPO } from "../util/fixtures.js";
import { recordGateRow } from "../util/gaterow.js";

interface SynthManifest {
  fixtures: {
    name: string;
    file: string;
    kind: "binary" | "numeric";
    options: Record<string, number>;
    plant: string;
    rows: number;
    sha256: string;
  }[];
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO, "test", "fixtures", "synth-manifest.json"), "utf8"),
) as SynthManifest;

describe("planted fixtures: frozen bytes + rank-1 recovery", () => {
  let recovered = 0;
  for (const fixture of manifest.fixtures) {
    const generate = fixture.kind === "binary" ? plantedBinary : plantedNumeric;
    const planted = generate(fixture.options as never);

    it(`${fixture.name}: regenerates byte-identically (sha256 frozen)`, () => {
      const csv = tableToCSV(planted.table);
      expect(createHash("sha256").update(csv).digest("hex")).toBe(fixture.sha256);
      const committed = fs.readFileSync(path.join(REPO, "test", "fixtures", fixture.file), "utf8");
      expect(createHash("sha256").update(committed).digest("hex")).toBe(fixture.sha256);
      expect(planted.plant.toString("display")).toBe(fixture.plant);
    });

    it(`${fixture.name}: oracle recovers the plant at rank 1 (full cross-check)`, async () => {
      const target =
        fixture.kind === "binary"
          ? binary({ attribute: "y", value: 1 })
          : numeric(planted.targetAttribute);
      const qf = fixture.kind === "binary" ? wracc() : standardNumeric(1, { estimator: "sum" });
      const space = removeTargetAttributes(allSelectors(planted.table, {}), target);
      const res = await exhaustive(
        {
          table: planted.table,
          target,
          searchSpace: space,
          qf,
          resultSetSize: 5,
          depth: 2,
        },
        { crossCheck: "full" },
      );
      expect(res.entries.length).toBeGreaterThan(0);
      expect(res.entries[0]!.description.canonicalKey()).toBe(planted.plant.canonicalKey());
      expect(res.crossCheckReport.checked).toBe(res.crossCheckReport.total);
      recovered++;
    });
  }

  it("records the gate row", () => {
    recordGateRow({
      id: "m3-planted-rank1",
      cell: manifest.fixtures.map((f) => f.name).join(","),
      check: "exhaustive oracle recovers implanted subgroup at rank 1 (dual-path full)",
      value: `${recovered}/${manifest.fixtures.length} plants at rank 1`,
      expected: `${manifest.fixtures.length}/${manifest.fixtures.length}`,
      gate: true,
      pass: recovered === manifest.fixtures.length,
    });
    expect(recovered).toBe(manifest.fixtures.length);
  });
});
