/**
 * Synthetic-fixture gates (BRIEF §6.1/§6.4): every frozen CSV fixture
 * (planted + stress) regenerates byte-identically (hash manifest — fixtures
 * change only via scripts/gen-synth-fixtures.mjs, BRIEF §21); the exhaustive
 * oracle recovers every implanted subgroup at rank 1 with full dual-path
 * cross-checking.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  allSelectors,
  binary,
  type DataTable,
  dupRows,
  exhaustive,
  naStress,
  numeric,
  plantedBinary,
  plantedNumeric,
  removeTargetAttributes,
  standardNumeric,
  tableToCSV,
  tieStress,
  wracc,
} from "../../src/index.js";
import { REPO } from "../util/fixtures.js";
import { recordGateRow } from "../util/gaterow.js";

interface SynthManifest {
  fixtures: {
    name: string;
    file: string;
    kind: "binary" | "numeric" | "tie" | "na" | "dup";
    options: Record<string, number>;
    plant?: string;
    rows: number;
    sha256: string;
  }[];
}

const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO, "test", "fixtures", "synth-manifest.json"), "utf8"),
) as SynthManifest;

/** Mirrors scripts/gen-synth-fixtures.mjs `generate`. */
function regenerate(fixture: SynthManifest["fixtures"][number]): {
  table: DataTable;
  plant: { toString(mode: "display"): string; canonicalKey(): string } | null;
  targetAttribute?: string;
} {
  const o = fixture.options;
  switch (fixture.kind) {
    case "binary":
      return plantedBinary(o as never);
    case "numeric":
      return plantedNumeric(o as never);
    case "tie":
      return { table: tieStress(o.blockSize), plant: null };
    case "na":
      return { table: naStress(o.n!, o.seed!), plant: null };
    case "dup":
      return { table: dupRows(o.distinct!, o.seed!), plant: null };
  }
}

describe("synthetic fixtures: frozen bytes + rank-1 plant recovery", () => {
  let recovered = 0;
  const planted = manifest.fixtures.filter((f) => f.plant !== undefined);
  for (const fixture of manifest.fixtures) {
    const regen = regenerate(fixture);

    it(`${fixture.name}: regenerates byte-identically (sha256 frozen)`, () => {
      const csv = tableToCSV(regen.table);
      expect(createHash("sha256").update(csv).digest("hex")).toBe(fixture.sha256);
      const committed = fs.readFileSync(path.join(REPO, "test", "fixtures", fixture.file), "utf8");
      expect(createHash("sha256").update(committed).digest("hex")).toBe(fixture.sha256);
      if (fixture.plant !== undefined) {
        expect(regen.plant!.toString("display")).toBe(fixture.plant);
      }
    });

    if (fixture.plant === undefined) continue;
    it(`${fixture.name}: oracle recovers the plant at rank 1 (full cross-check)`, async () => {
      const target =
        fixture.kind === "binary"
          ? binary({ attribute: "y", value: 1 })
          : numeric(regen.targetAttribute!);
      const qf = fixture.kind === "binary" ? wracc() : standardNumeric(1, { estimator: "sum" });
      const space = removeTargetAttributes(allSelectors(regen.table, {}), target);
      const res = await exhaustive(
        {
          table: regen.table,
          target,
          searchSpace: space,
          qf,
          resultSetSize: 5,
          depth: 2,
        },
        { crossCheck: "full" },
      );
      expect(res.entries.length).toBeGreaterThan(0);
      expect(res.entries[0]!.description.canonicalKey()).toBe(regen.plant!.canonicalKey());
      expect(res.crossCheckReport.checked).toBe(res.crossCheckReport.total);
      recovered++;
    });
  }

  it("records the gate row", () => {
    recordGateRow({
      id: "m3-planted-rank1",
      cell: planted.map((f) => f.name).join(","),
      check: "exhaustive oracle recovers implanted subgroup at rank 1 (dual-path full)",
      value: `${recovered}/${planted.length} plants at rank 1`,
      expected: `${planted.length}/${planted.length}`,
      gate: true,
      pass: recovered === planted.length && planted.length >= 4,
    });
    expect(recovered).toBe(planted.length);
  });
});
