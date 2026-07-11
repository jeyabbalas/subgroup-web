/**
 * M0 differential gate: the reference-dialect parser round-trips every
 * selector and description string in the first generated fixture, in both
 * dialects (repr/query and str/display), and the parsed structure matches the
 * generator's structured encoding exactly (BRIEF §22-A16).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseRefConjunction,
  parseRefSelector,
  printRefConjunction,
  printRefSelector,
  type RefSelector,
} from "../../src/desc/refdialect.js";
import {
  DATASETS_DIR,
  FIXTURES_DIR,
  type FixtureSelector,
  loadJson,
  loadTaskFixture,
  sha256File,
} from "../util/fixtures.js";
import { recordGateRow } from "../util/gaterow.js";

const FIXTURE_ID = "titanic-binary-wracc-apriori-d2-k5";

function stripStrings(sel: FixtureSelector): RefSelector {
  switch (sel.kind) {
    case "equality":
      return { kind: "equality", attribute: sel.attribute, value: sel.value };
    case "interval":
      return { kind: "interval", attribute: sel.attribute, lo: sel.lo, hi: sel.hi };
    case "negated":
      return { kind: "negated", inner: stripStrings(sel.inner) };
  }
}

describe(`refdialect round-trip on fixture ${FIXTURE_ID}`, () => {
  const fixture = loadTaskFixture(FIXTURE_ID);

  it("fixture and dataset hashes match their manifests (anti-tamper, §21)", () => {
    const fixtureManifest = loadJson("manifest.json") as {
      fixtures: { file: string; sha256: string }[];
    };
    for (const entry of fixtureManifest.fixtures) {
      expect(sha256File(path.join(FIXTURES_DIR, entry.file)), entry.file).toBe(entry.sha256);
    }
    const datasetManifest = JSON.parse(
      fs.readFileSync(path.join(DATASETS_DIR, "manifest.json"), "utf8"),
    ) as { datasets: { file: string; sha256: string }[] };
    for (const entry of datasetManifest.datasets) {
      expect(sha256File(path.join(DATASETS_DIR, entry.file)), entry.file).toBe(entry.sha256);
    }
  });

  it("round-trips all search-space selectors in both dialects", () => {
    expect(fixture.search_space.length).toBeGreaterThan(300);
    for (const sel of fixture.search_space) {
      const structural = stripStrings(sel);
      const fromRepr = parseRefSelector(sel.repr, "query");
      expect(fromRepr).toEqual(structural);
      expect(printRefSelector(fromRepr, "query")).toBe(sel.repr);
      const fromStr = parseRefSelector(sel.str, "display");
      expect(printRefSelector(fromStr, "display")).toBe(sel.str);
    }
  });

  it("round-trips all result descriptions in both dialects", () => {
    expect(fixture.results.length).toBe(5);
    for (const row of fixture.results) {
      const desc = row.description;
      const fromRepr = parseRefConjunction(desc.repr, "query");
      expect(fromRepr).toEqual(desc.selectors.map(stripStrings));
      expect(printRefConjunction(fromRepr, "query")).toBe(desc.repr);
      const fromStr = parseRefConjunction(desc.str, "display");
      expect(printRefConjunction(fromStr, "display")).toBe(desc.str);
    }
  });

  it("parses the empty description in both dialects", () => {
    expect(parseRefConjunction("True", "query")).toEqual([]);
    expect(parseRefConjunction("Dataset", "display")).toEqual([]);
    expect(printRefConjunction([], "query")).toBe("True");
    expect(printRefConjunction([], "display")).toBe("Dataset");
  });

  it("records the M0 gate row", () => {
    recordGateRow({
      id: "m0-refdialect-roundtrip",
      cell: FIXTURE_ID,
      check: "reference description strings parse+reprint exactly (both dialects)",
      value: `${fixture.search_space.length} selectors + ${fixture.results.length} results`,
      expected: "exact round-trip",
      gate: true,
      pass: true,
    });
  });
});
