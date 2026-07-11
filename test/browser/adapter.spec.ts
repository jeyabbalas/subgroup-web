/**
 * WebGPU adapter gate (BRIEF §12): the browser suite runs on a real GPU.
 * This test FAILS (never skips) if no adapter is present; the only sanctioned
 * skip is SUBGROUP_WEB_CI_CPU_ONLY=1, which skips the whole Playwright
 * project at the gate-orchestrator level, never here.
 *
 * Pages are served from 127.0.0.1 because WebGPU requires a secure context
 * (about:blank is not one — see test/browser/serve.ts).
 */
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { serveRepo, type TestServer } from "./serve.js";

let server: TestServer;
test.beforeAll(async () => {
  server = await serveRepo();
});
test.afterAll(async () => {
  await server?.close();
});

test("navigator.gpu yields a real adapter (fail, don't skip)", async ({ page }) => {
  await page.goto(`${server.baseUrl}/test/browser/pages/blank.html`);
  const info = await page.evaluate(async () => {
    if (!("gpu" in navigator)) {
      return { error: `navigator.gpu missing (secureContext=${window.isSecureContext})` };
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { error: "requestAdapter() returned null" };
    const ai = adapter.info;
    return {
      vendor: ai?.vendor ?? "",
      architecture: ai?.architecture ?? "",
      device: ai?.device ?? "",
      description: ai?.description ?? "",
      crossOriginIsolated: globalThis.crossOriginIsolated === true,
      limits: {
        maxBufferSize: adapter.limits.maxBufferSize,
        maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
        maxComputeWorkgroupStorageSize: adapter.limits.maxComputeWorkgroupStorageSize,
        maxComputeInvocationsPerWorkgroup: adapter.limits.maxComputeInvocationsPerWorkgroup,
      },
    };
  });

  if ("error" in info) {
    throw new Error(
      `WebGPU adapter unavailable: ${info.error}. The acceptance platform is Chromium+Metal ` +
        "on this machine; check launch flags (--enable-unsafe-webgpu) or fall back to " +
        "headed/channel:'chrome' per BRIEF §22-A15.",
    );
  }
  console.log(
    `WebGPU adapter: vendor=${info.vendor} arch=${info.architecture} device=${info.device} desc=${info.description}`,
  );
  console.log(
    `  limits: ${JSON.stringify(info.limits)} crossOriginIsolated=${info.crossOriginIsolated}`,
  );

  const gateDir = path.resolve(".gate");
  fs.mkdirSync(gateDir, { recursive: true });
  fs.writeFileSync(
    path.join(gateDir, "adapter.json"),
    JSON.stringify({
      vendor: info.vendor,
      architecture: info.architecture,
      description: info.description,
      limits: info.limits,
    }),
  );
  expect(info.vendor.length).toBeGreaterThan(0);
});
