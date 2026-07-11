// Browser (WebGPU) leg of the benchmark runner: serves the repo, launches
// Chromium with WebGPU on Metal, generates the synth-2M datasets IN PAGE
// (seeded — byte-identical to the Node side, verified by content hash), and
// measures the GPU gate tasks. Numbers come exclusively from these runs
// (BRIEF §21).
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { chromium } from "playwright";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".map": "application/json",
  ".json": "application/json",
  ".csv": "text/csv; charset=utf-8",
};

function serveRepo() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const file = path.normalize(path.join(REPO, decodeURIComponent(url.pathname)));
    if (!file.startsWith(REPO) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
      "cross-origin-opener-policy": "same-origin",
      "cross-origin-embedder-policy": "require-corp",
      "cache-control": "no-store",
    });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Run the P2/P3 GPU benchmarks in one Chromium session.
 * Returns { adapter, chromiumVersion, p2, p3 } where each pN carries
 * { runs, median, top, plantOk, hashOk, backend, gpuLedger }.
 */
export async function runGpuBenches({ warmup = 1, runs = 3, manifest }) {
  const server = await serveRepo();
  const port = server.address().port;
  const browser = await chromium.launch({
    headless: true,
    args: ["--enable-unsafe-webgpu", "--enable-features=WebGPU", "--use-angle=metal"],
  });
  const page = await browser.newPage();
  const pageErrors = [];
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.goto(`http://127.0.0.1:${port}/test/browser/pages/blank.html`);

  const result = await page.evaluate(
    async ([cfg]) => {
      const sw = await import("/dist/index.js");
      const gpu = await import("/dist/webgpu.js");
      gpu.registerWebGpu();
      const adapter = await navigator.gpu.requestAdapter({
        powerPreference: "high-performance",
      });
      const adapterInfo = adapter
        ? {
            vendor: adapter.info?.vendor ?? "",
            architecture: adapter.info?.architecture ?? "",
            device: adapter.info?.device ?? "",
            maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
          }
        : null;
      if (!adapterInfo) throw new Error("no WebGPU adapter (fail, don't skip)");

      const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];

      async function bench(variant) {
        const ds = variant === "binary" ? sw.synth2MBinary() : sw.synth2MNumeric();
        const hash = sw.datasetContentHash(ds.table);
        const hashOk =
          hash === (variant === "binary" ? cfg.manifest.binaryHash : cfg.manifest.numericHash);
        const plantKey = ds.plant.canonicalKey();
        const ignore = variant === "binary" ? ["y"] : ["t"];
        const space = sw.allSelectors(ds.table, { ignore });
        const task =
          variant === "binary"
            ? {
                table: ds.table,
                target: sw.binary({ attribute: "y", value: 1 }),
                searchSpace: space,
                qf: sw.wracc(),
                resultSetSize: 100,
                depth: 2,
                minQuality: 0,
              }
            : {
                table: ds.table,
                target: sw.numeric("t"),
                searchSpace: space,
                qf: sw.standardNumeric(1, { estimator: "sum" }),
                resultSetSize: 50,
                depth: 3,
                minQuality: 0,
              };
        const algo =
          variant === "binary"
            ? (t, o) => sw.apriori(t, o)
            : (t, o) => sw.beamSearch(t, { ...o, width: 50 });
        const times = [];
        let last = null;
        for (let i = 0; i < cfg.warmup + cfg.runs; i++) {
          const t0 = performance.now();
          last = await algo(task, { backend: "webgpu" });
          const dt = (performance.now() - t0) / 1000;
          if (i >= cfg.warmup) times.push(dt);
        }
        return {
          selectors: space.length,
          runs: times,
          median: median(times),
          top: {
            key: last.entries[0].description.canonicalKey(),
            quality: last.entries[0].quality,
          },
          plantOk: last.entries[0].description.canonicalKey() === plantKey,
          evaluated: last.candidatesEvaluated,
          band: last.backend?.band ?? null,
          hash,
          hashOk,
          backend: last.backend?.name ?? "?",
        };
      }

      const p2 = await bench("binary");
      const p3 = await bench("numeric");
      return { adapter: adapterInfo, p2, p3 };
    },
    [{ warmup, runs, manifest }],
  );

  const chromiumVersion = browser.version();
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
  if (pageErrors.length > 0) {
    throw new Error(`GPU bench page errors: ${pageErrors.join("; ")}`);
  }
  return { ...result, chromiumVersion };
}
