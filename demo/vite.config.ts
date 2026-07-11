import { defineConfig, type Plugin } from "vite";

/**
 * subgroup-web ships `sideEffects: false` (fully tree-shakeable), but its
 * `./worker` entry works BY side effect (it attaches onmessage at module
 * scope). Without this override Rollup would tree-shake the worker bundle
 * to an empty chunk. Consumer bundler config is the right place to say so.
 */
function keepWorkerSideEffects(): Plugin {
  return {
    name: "subgroup-web-worker-side-effects",
    enforce: "pre",
    async resolveId(source, importer, options) {
      if (source !== "subgroup-web/worker") return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      return resolved && { ...resolved, moduleSideEffects: true };
    },
  };
}

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
  worker: {
    format: "es",
    plugins: () => [keepWorkerSideEffects()],
  },
  plugins: [keepWorkerSideEffects()],
}));
