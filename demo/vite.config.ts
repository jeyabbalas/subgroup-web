import { defineConfig } from "vite";

// GitHub Pages constraint (BRIEF §15): base path comes from BASE_PATH
// (default "/subgroup-web/" for builds, "/" in dev). The local dev server
// sets COOP/COEP so SharedArrayBuffer worker paths are exercised in
// development; Pages cannot send these headers, so the demo must also run
// fully without SAB (verified by the preview smoke, which serves without
// these headers).
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === "build" ? "/subgroup-web/" : "/"),
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
}));
