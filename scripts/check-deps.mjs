#!/usr/bin/env node
// Gate: the published package has ZERO runtime dependencies (BRIEF §16.1).
import fs from "node:fs";

const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const problems = [];

if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  problems.push(
    `package.json has runtime dependencies: ${Object.keys(pkg.dependencies).join(", ")}`,
  );
}
if (pkg.peerDependencies && Object.keys(pkg.peerDependencies).length > 0) {
  problems.push(
    `package.json has peerDependencies: ${Object.keys(pkg.peerDependencies).join(", ")}`,
  );
}
if (pkg.optionalDependencies && Object.keys(pkg.optionalDependencies).length > 0) {
  problems.push(
    `package.json has optionalDependencies: ${Object.keys(pkg.optionalDependencies).join(", ")}`,
  );
}
if (pkg.type !== "module")
  problems.push(`"type" must be "module", got ${JSON.stringify(pkg.type)}`);
if (pkg.sideEffects !== false) problems.push(`"sideEffects" must be false`);
if (!pkg.engines || !/>=\s*20/.test(pkg.engines.node ?? "")) {
  problems.push(`"engines.node" must require >= 20`);
}
for (const entry of [".", "./webgpu"]) {
  if (!pkg.exports?.[entry]) problems.push(`missing exports entry "${entry}"`);
}

if (problems.length > 0) {
  console.error("check:deps FAIL");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(
  "check:deps OK — zero runtime dependencies; ESM-only; engines/node >=20; exports intact",
);
