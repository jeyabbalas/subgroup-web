#!/usr/bin/env node
// Inner-loop gate (BRIEF §16.3): typecheck + spec/unit suites + a small
// exactness subset. Fast; run after every meaningful change.
import { runStep, vitestSummary } from "./lib/run.mjs";

const steps = [
  ["typecheck", "pnpm", ["exec", "tsc", "-p", "tsconfig.json", "--noEmit"]],
  [
    "test:quick",
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "test/spec",
      "test/unit",
      "test/exactness/quick",
      "--passWithNoTests",
    ],
    { summarize: vitestSummary },
  ],
];

let allOk = true;
for (const [name, cmd, args, opts] of steps) {
  const { ok } = runStep(name, cmd, args, opts);
  if (!ok) {
    allOk = false;
    break;
  }
}
console.log(`gate:quick ${allOk ? "PASS" : "FAIL"}`);
process.exit(allOk ? 0 : 1);
