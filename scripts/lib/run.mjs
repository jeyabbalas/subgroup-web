// Shared step runner for gate scripts: streams a step's full output to
// .logs/<name>.log, prints a compact verdict line, and returns pass/fail.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
export const LOGS = path.join(REPO, ".logs");

export function runStep(name, command, args, opts = {}) {
  fs.mkdirSync(LOGS, { recursive: true });
  const logFile = path.join(LOGS, `${name.replace(/[^a-z0-9_-]+/gi, "_")}.log`);
  const started = Date.now();
  const res = spawnSync(command, args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
    env: { ...process.env, ...(opts.env ?? {}), FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  fs.writeFileSync(logFile, out);
  const ok = res.status === 0;
  const summary = opts.summarize ? opts.summarize(out) : "";
  console.log(`${ok ? "✓" : "✗"} ${name} (${secs}s)${summary ? ` — ${summary}` : ""}`);
  if (!ok) {
    const tail = out
      .split("\n")
      .slice(-Number(opts.tailOnFail ?? 40))
      .join("\n");
    console.log(`--- tail of ${path.relative(REPO, logFile)} ---`);
    console.log(tail);
  }
  return { ok, out, logFile, secs };
}

/** Extract vitest "Tests  N passed" style summary. */
export function vitestSummary(out) {
  const tests = out.match(/Tests\s+([^\n]*)/);
  const files = out.match(/Test Files\s+([^\n]*)/);
  return [files?.[1]?.trim(), tests?.[1]?.trim()].filter(Boolean).join(" | ");
}

/** Extract Playwright "N passed" summary. */
export function playwrightSummary(out) {
  const m = out.match(/(\d+ passed[^\n]*)/);
  return m?.[1]?.trim() ?? "";
}
