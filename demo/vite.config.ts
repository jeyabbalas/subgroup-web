import { defineConfig } from "vite";

// GitHub Pages constraint (BRIEF §15): base path comes from BASE_PATH
// (default "/subgroup-web/" for builds, "/" in dev). The local dev server
// sets COOP/COEP so SharedArrayBuffer worker paths are exercised in
// development; Pages cannot send these headers, so the demo must also run
// fully without SAB (verified by the preview smoke, which serves without
// these headers).
export default defineConfig(({ command, isPreview }) => ({
  // `vite preview` must serve under the SAME base the build used, or every
  // asset request misses the static handler and 404s (the SPA fallback
  // masks it for curl but not for real <script> loads).
  base: process.env.BASE_PATH ?? (command === "build" || isPreview ? "/subgroup-web/" : "/"),
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  // `vite preview` would inherit server.headers; Pages cannot send COOP/COEP,
  // so the preview (the smoke-test target) must not either — the smoke then
  // exercises exactly the deployed regime: copy-mode workers, no SAB.
  preview: {
    headers: {},
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
  // The library creates browser workers with { type: "module" } (pool.ts).
  // subgroup-web's sideEffects allowlists dist/worker.js, so the worker
  // bundle survives tree-shaking without any consumer-side plugin — the
  // demo build exercises the real unpatched consumer path.
  worker: {
    format: "es",
  },
}));
