#!/usr/bin/env node
// The one-command acceptance gate (BRIEF §16.3):
//   check:deps → check:noskip → typecheck → lint → build → test → pack:test
//   → test:browser → bench:gates → PARITY.md + COMPATIBILITY summary +
//   BENCHMARKS.md + GATE verdict.
// Output stays compact (~<=300 lines); full logs in .logs/.
import fs from "node:fs";
import path from "node:path";
import { playwrightSummary, REPO, runStep, vitestSummary } from "./lib/run.mjs";
import { assemble } from "./reports.mjs";

const cpuOnly = process.env.SUBGROUP_WEB_CI_CPU_ONLY;
console.log(`pnpm gate — subgroup-web acceptance pipeline`);
console.log(
  `env: SUBGROUP_WEB_CI_CPU_ONLY=${cpuOnly === undefined ? "<unset>" : JSON.stringify(cpuOnly)} (must be <unset> for the goal-proving run)`,
);

// Fresh gate-row store for this run.
fs.rmSync(path.join(REPO, ".gate"), { recursive: true, force: true });
fs.mkdirSync(path.join(REPO, ".gate", "rows"), { recursive: true });

const steps = [
  ["check:deps", "node", ["scripts/check-deps.mjs"]],
  ["check:noskip", "node", ["scripts/check-noskip.mjs"]],
  ["typecheck", "pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"]],
  ["lint", "pnpm", ["exec", "biome", "check", "."]],
  ["build", "pnpm", ["exec", "tsdown"]],
  ["test", "pnpm", ["exec", "vitest", "run"], { summarize: vitestSummary }],
  ["pack:test", "node", ["scripts/pack-test.mjs"]],
  ["test:browser", "pnpm", ["exec", "playwright", "test"], { summarize: playwrightSummary }],
  ["bench:gates", "node", ["scripts/bench.mjs", "--gates"]],
];

let failedStep = null;
for (const [name, cmd, args, opts] of steps) {
  // The browser project — Playwright GPU exactness (test:browser) and the
  // Chromium/WebGPU benchmark leg (bench:gates) — cannot run on GitHub's
  // GPU-less runners. SUBGROUP_WEB_CI_CPU_ONLY=1 is the one sanctioned skip
  // (BRIEF §16.2); it is never valid for a local acceptance run.
  if ((name === "test:browser" || name === "bench:gates") && cpuOnly === "1") {
    console.log(
      `- ${name} SKIPPED (SUBGROUP_WEB_CI_CPU_ONLY=1 — GPU/browser leg; CI-only escape, never valid for acceptance)`,
    );
    continue;
  }
  const { ok } = runStep(name, cmd, args, opts);
  if (!ok) {
    failedStep = name;
    break;
  }
}

// Assemble and print reports even on failure (they aid diagnosis), but the
// verdict reflects both step success and gate-row status.
const { parity, compatSummary, allPass } = assemble();
console.log("");
console.log("================ PARITY.md ================");
console.log(parity);
console.log("============ COMPATIBILITY.md =============");
console.log(compatSummary);
console.log("");
const benchPath = path.join(REPO, "BENCHMARKS.md");
if (fs.existsSync(benchPath)) {
  console.log("=============== BENCHMARKS.md =============");
  console.log(fs.readFileSync(benchPath, "utf8"));
}

// Adapter info recorded by the browser suite (must show a real GPU).
const adapterPath = path.join(REPO, ".gate", "adapter.json");
if (fs.existsSync(adapterPath)) {
  console.log(`WebGPU adapter: ${fs.readFileSync(adapterPath, "utf8").trim()}`);
}

console.log(
  `env recheck: SUBGROUP_WEB_CI_CPU_ONLY=${cpuOnly === undefined ? "<unset>" : JSON.stringify(cpuOnly)}`,
);
const verdict = failedStep === null && allPass;
console.log(
  `GATE: ${verdict ? "PASS" : "FAIL"}${failedStep ? ` (failed step: ${failedStep})` : ""}`,
);
process.exit(verdict ? 0 : 1);
