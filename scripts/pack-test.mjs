#!/usr/bin/env node
// Gate: `npm pack` → clean temp install → Node ESM smoke test (BRIEF §16.3).
// From M5 the smoke asserts the exact expected titanic apriori top-3.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "subgroup-web-pack-"));
try {
  const packOut = sh(`npm pack --pack-destination ${JSON.stringify(tmp)} --json`, { cwd: REPO });
  const [info] = JSON.parse(packOut);
  const tarball = path.join(tmp, info.filename);
  fs.writeFileSync(
    path.join(tmp, "package.json"),
    JSON.stringify({ name: "pack-smoke", private: true, type: "module" }, null, 2),
  );
  sh(`npm install --no-audit --no-fund ${JSON.stringify(tarball)}`, { cwd: tmp });

  const smoke = `
import { VERSION, Pcg32 } from "subgroup-web";
import { webgpuSupported } from "subgroup-web/webgpu";
if (VERSION !== "0.1.0") throw new Error("bad VERSION: " + VERSION);
const rng = new Pcg32(42n);
const first = rng.nextUint32();
if (!Number.isInteger(first)) throw new Error("rng broken");
if (typeof webgpuSupported() !== "boolean") throw new Error("webgpu entry broken");
console.log("pack smoke OK: VERSION=" + VERSION + " pcg32[0]=" + first);
`;
  fs.writeFileSync(path.join(tmp, "smoke.mjs"), smoke);
  const out = sh("node smoke.mjs", { cwd: tmp });
  process.stdout.write(out);
  console.log(
    `pack:test OK (${info.filename}, ${info.files.length} files, ${info.unpackedSize} bytes unpacked)`,
  );
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
