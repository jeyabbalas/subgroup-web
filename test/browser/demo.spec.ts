/**
 * Demo smoke gate (BRIEF §15): build the demo, serve it through `vite
 * preview` under the GitHub Pages base path (/subgroup-web/, no COOP/COEP —
 * the deployed regime), then drive it like a user: pick titanic, run apriori
 * with standard(0.5) at depth 2 on WebGPU, and assert a populated results
 * table with HUD timings > 0. Screenshot to test-results/demo-titanic.png
 * (inspected at M7 acceptance). A second run on copy-regime workers checks
 * the no-SAB path end-to-end and cross-backend agreement in the UI.
 */

import { type ChildProcess, execSync, spawn } from "node:child_process";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { recordGateRow } from "../util/gaterow.js";

const REPO = path.resolve(import.meta.dirname, "..", "..");
const PORT = 4179;
const BASE = `http://127.0.0.1:${PORT}/subgroup-web/`;

let preview: ChildProcess | null = null;

test.beforeAll(async () => {
  execSync("pnpm -C demo build", { cwd: REPO, stdio: "pipe" });
  preview = spawn(
    "pnpm",
    ["-C", "demo", "preview", "--port", String(PORT), "--strictPort", "--host", "127.0.0.1"],
    { cwd: REPO, stdio: "pipe" },
  );
  let up = false;
  for (let i = 0; i < 120 && !up; i++) {
    await new Promise((r) => setTimeout(r, 250));
    try {
      up = (await fetch(BASE)).ok;
    } catch {
      // not up yet
    }
  }
  if (!up) throw new Error("demo preview server did not come up");
});

test.afterAll(() => {
  preview?.kill();
});

test("demo smoke: titanic apriori standard(0.5) d2 on WebGPU populates results", async ({
  page,
}) => {
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  await page.goto(BASE);
  await page.waitForSelector('[data-testid="dataset-select"]');

  // Pages regime: preview sends no COOP/COEP, so the badge must read false.
  const coi = await page.evaluate(() => globalThis.crossOriginIsolated === true);
  expect(coi, "preview must not be cross-origin isolated (Pages regime)").toBe(false);

  await page.selectOption('[data-testid="dataset-select"]', "titanic");
  await expect(page.locator('[data-testid="target-attribute"]')).toHaveValue("Survived");
  await expect(page.locator('[data-testid="target-value"]')).toHaveValue("1");

  // The §15 smoke task is the app's default: apriori, standard(a=0.5), depth 2.
  await expect(page.locator('[data-testid="qf-select"]')).toHaveValue("standard");
  await expect(page.locator('[data-testid="qf-a"]')).toHaveValue("0.5");
  await expect(page.locator('[data-testid="algorithm-select"]')).toHaveValue("apriori");
  await expect(page.locator('[data-testid="depth-input"]')).toHaveValue("2");

  await page.selectOption('[data-testid="backend-select"]', "webgpu");
  await page.click('[data-testid="run-button"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="progress-text"]')?.textContent?.startsWith("done"),
    undefined,
    { timeout: 60_000 },
  );

  const rows = page.locator('[data-testid="result-row"]');
  const rowCount = await rows.count();
  expect(rowCount, "results table must be populated").toBeGreaterThan(0);
  const topRow = (await rows.first().textContent()) ?? "";
  expect(topRow, "classic titanic pattern at rank 1").toContain("Sex=='female'");

  const hudBackend = (await page.locator('[data-testid="hud-backend"]').textContent()) ?? "";
  expect(hudBackend, "run must have executed on the GPU backend").toContain("webgpu");
  const hudTime = (await page.locator('[data-testid="hud-time"]').textContent()) ?? "";
  const timeValue = Number.parseFloat(hudTime);
  expect(Number.isFinite(timeValue) && timeValue > 0, `HUD timing > 0 (got "${hudTime}")`).toBe(
    true,
  );

  // Detail view + plots rendered for the top subgroup.
  await expect(page.locator('[data-testid="detail-desc"]')).toContainText("Sex=='female'");
  await expect(page.locator('[data-testid="roc-canvas"]')).toBeVisible();
  await expect(page.locator('[data-testid="sgbars-canvas"]')).toBeVisible();

  await page.screenshot({ path: "test-results/demo-titanic.png", fullPage: true });

  // Second leg: copy-regime workers (no SAB on Pages) must agree in the UI.
  await page.selectOption('[data-testid="backend-select"]', "workers");
  await page.click('[data-testid="run-button"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="progress-text"]')?.textContent?.startsWith("done"),
    undefined,
    { timeout: 60_000 },
  );
  const workersBackend = (await page.locator('[data-testid="hud-backend"]').textContent()) ?? "";
  expect(workersBackend, "workers pool ran").toContain("cpu-workers(");
  expect(workersBackend, "no SAB without cross-origin isolation (copy regime)").not.toContain(
    "sab",
  );
  const workersTop = (await rows.first().textContent()) ?? "";
  expect(workersTop, "workers top row identical to GPU top row").toBe(topRow);

  const realErrors = consoleErrors.filter((e) => !e.includes("favicon"));
  expect(realErrors, `console must stay clean, got: ${realErrors.join(" | ")}`).toHaveLength(0);

  recordGateRow({
    id: "m7-demo-smoke",
    cell: "demo preview /subgroup-web/ (no COOP/COEP)",
    check:
      "titanic apriori standard(0.5) d2 on webgpu: results populated, HUD > 0, rank-1 = Sex=='female'; copy-regime workers agree; screenshot saved",
    value: `${rowCount} rows; gpu="${hudBackend}" ${hudTime}; workers="${workersBackend}"`,
    expected: "rows > 0; webgpu backend; time > 0; identical workers top row",
    gate: true,
    pass: true,
  });
});
