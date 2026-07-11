import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    webgpu: "src/webgpu.ts",
    // Self-contained worker-pool entry; addressed by URL from index.js
    // (src/backends/cpu/pool.ts resolveWorkerScript).
    worker: "src/backends/cpu/worker.ts",
  },
  format: ["esm"],
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: true,
  target: "es2022",
});
