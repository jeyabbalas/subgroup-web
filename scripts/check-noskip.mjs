#!/usr/bin/env node
// Gate (BRIEF §21): no .skip/.only/.todo/.fixme or early-return stubs in gate
// suites; a test that cannot run is a failing test. Also enforces the
// Math.random ban in src/ as a belt-and-braces backstop to the Biome plugin.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const repo = path.resolve(ROOT, "..");

const offenders = [];

function walk(dir, cb) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, cb);
    else cb(p);
  }
}

const SKIP_PATTERNS = [
  /\b(?:it|test|describe)\s*\.\s*(?:skip|only|todo|fixme|skipIf|runIf|todoIf)\s*\(/,
  /\b(?:it|test|describe)\s*\.\s*concurrent\s*\.\s*(?:skip|only|todo)\s*\(/,
  /\bxit\s*\(|\bxdescribe\s*\(|\bfit\s*\(|\bfdescribe\s*\(/,
];

const testDir = path.join(repo, "test");
if (fs.existsSync(testDir)) {
  walk(testDir, (p) => {
    if (!/\.(?:ts|mts|js|mjs)$/.test(p)) return;
    const lines = fs.readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const re of SKIP_PATTERNS) {
        if (re.test(line)) offenders.push(`${path.relative(repo, p)}:${i + 1}: ${line.trim()}`);
      }
    });
  });
}

const srcDir = path.join(repo, "src");
if (fs.existsSync(srcDir)) {
  walk(srcDir, (p) => {
    if (!/\.(?:ts|mts)$/.test(p)) return;
    const lines = fs.readFileSync(p, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (/Math\s*\.\s*random\s*\(/.test(line)) {
        offenders.push(`${path.relative(repo, p)}:${i + 1}: Math.random banned in src/ (§7)`);
      }
    });
  });
}

if (offenders.length > 0) {
  console.error("check:noskip FAIL");
  for (const o of offenders) console.error(`  - ${o}`);
  process.exit(1);
}
console.log("check:noskip OK — no .skip/.only/.todo/.fixme in test/, no Math.random in src/");
