import { defineConfig } from "@playwright/test";

// GPU gate tests run on Chromium with WebGPU enabled (acceptance platform:
// Chromium on Apple Silicon / Metal). SUBGROUP_WEB_CI_CPU_ONLY=1 is the only
// sanctioned way to skip the browser project (GPU-less CI runners); it must
// never be set for the goal-proving run and `pnpm gate` prints its state.
export default defineConfig({
  testDir: "test/browser",
  forbidOnly: true,
  fullyParallel: false,
  workers: 1,
  timeout: 900_000,
  expect: { timeout: 30_000 },
  reporter: [["list"]],
  projects: [
    {
      name: "chromium-webgpu",
      use: {
        browserName: "chromium",
        headless: true,
        launchOptions: {
          args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--use-angle=metal"],
        },
      },
    },
  ],
});
