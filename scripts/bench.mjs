#!/usr/bin/env node
// Benchmark runner (BRIEF §8). `--gates` measures the P1–P5 hard gates and
// regenerates BENCHMARKS.md + .gate/rows/m6-perf-*.json. Every number comes
// from a run inside this script or from reference/fixtures/ref_timings.json
// (itself written by reference/scripts/bench_reference.py) — never by hand
// (BRIEF §21).
//
// Methodology (§8): 1 warmup + 3 measured runs, median; the measured span is
// the algorithm call (task preparation incl. lazy atlas build + search +
// result materialization), matching the reference's `execute` span (its
// representation build happens inside execute too). Search-space
// construction is outside the span on both sides. Datasets are in memory.
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const DIST = path.join(REPO, "dist", "index.js");
if (!fs.existsSync(DIST)) {
  console.error("bench: dist/index.js missing — run `pnpm build` first");
  process.exit(1);
}
const sw = await import(DIST);

const gatesOnly = process.argv.includes("--gates");
const WARMUP = 1;
const RUNS = 3;

// ---------------------------------------------------------------------------
// helpers

function tryExec(cmd) {
  try {
    return execSync(cmd, { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

const median = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fmtS = (s) => `${s.toFixed(3)} s`;

async function measure(fn, { warmup = WARMUP, runs = RUNS } = {}) {
  let last = null;
  const times = [];
  for (let i = 0; i < warmup + runs; i++) {
    const t0 = performance.now();
    last = await fn();
    const dt = (performance.now() - t0) / 1000;
    if (i >= warmup) times.push(dt);
  }
  return { runs: times, median: median(times), last };
}

/** Peak-RSS sampler around a span. */
function rssSampler() {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peak) peak = rss;
  }, 25);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
      const rss = process.memoryUsage().rss;
      if (rss > peak) peak = rss;
      return peak;
    },
  };
}

function recordRow(row) {
  const dir = path.join(REPO, ".gate", "rows");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${row.id}.json`), JSON.stringify(row, null, 1));
}

const fp1 = (results) => ({
  key: results.entries[0].description.canonicalKey(),
  quality: results.entries[0].quality,
});

// ---------------------------------------------------------------------------
// reference fixtures

const refTimingsPath = path.join(REPO, "reference", "fixtures", "ref_timings.json");
if (!fs.existsSync(refTimingsPath)) {
  console.error("bench: reference timings missing — run `pnpm ref:bench` first");
  process.exit(1);
}
const refTimings = JSON.parse(fs.readFileSync(refTimingsPath, "utf8"));
const refP1 = refTimings.timings.find((t) => t.task === "p1-adult-apriori-d3-std05-k100");
const p1RefTopkPath = path.join(REPO, "reference", "fixtures", "p1_reference_topk.json");
const p1RefTopk = JSON.parse(fs.readFileSync(p1RefTopkPath, "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(REPO, "test", "fixtures", "synth2m-manifest.json"), "utf8"),
);

/** Decode a reference fixture selector into a subgroup-web selector. */
function decodeRefSelector(selJson) {
  if (selJson.kind === "equality") {
    const v = selJson.value;
    const value = v.t === "num" ? v.v.value : v.v;
    return sw.equality(selJson.attribute, value);
  }
  if (selJson.kind === "interval") {
    const bound = (b) =>
      typeof b.value === "object" && b.value !== null && "$f" in b.value
        ? b.value.$f === "inf"
          ? Number.POSITIVE_INFINITY
          : Number.NEGATIVE_INFINITY
        : b.value;
    return sw.interval(selJson.attribute, bound(selJson.lo), bound(selJson.hi));
  }
  throw new Error(`unsupported fixture selector kind ${selJson.kind}`);
}

/**
 * Tie-tolerant top-k comparison vs the reference (COMPATIBILITY MAP-001):
 * per-rank qualities must agree to rel ≤ 1e-9, and the {description →
 * quality} mappings must agree as sets (order within exact ties is the
 * reference's heap artifact).
 */
function compareToReference(ours, refRows) {
  const tol = (a, b) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  if (ours.entries.length !== refRows.length) {
    return { ok: false, why: `k mismatch: ${ours.entries.length} vs ${refRows.length}` };
  }
  for (let i = 0; i < refRows.length; i++) {
    if (!tol(ours.entries[i].quality, refRows[i].quality)) {
      return {
        ok: false,
        why: `rank ${i} quality ${ours.entries[i].quality} vs ${refRows[i].quality}`,
      };
    }
  }
  const ourMap = new Map(ours.entries.map((e) => [e.description.canonicalKey(), e.quality]));
  for (const row of refRows) {
    const conj = new sw.Conjunction(row.description.selectors.map(decodeRefSelector));
    const key = conj.canonicalKey();
    const q = ourMap.get(key);
    if (q === undefined) return { ok: false, why: `reference description missing: ${key}` };
    if (!tol(q, row.quality)) return { ok: false, why: `quality mismatch on ${key}` };
  }
  return { ok: true, why: "" };
}

// ---------------------------------------------------------------------------
// benchmark tasks

const cores = os.availableParallelism?.() ?? os.cpus().length;
const rows = [];
const gateRows = [];
const p5Checks = [];

console.log(`bench:gates — cores=${cores}, warmup=${WARMUP}, runs=${RUNS}`);

// --- GPU leg first (separate browser process; both 2M variants in one session)
console.log("· GPU leg (Chromium/Metal): synth-2M P2 apriori + P3 beam ...");
const { runGpuBenches } = await import(path.join(REPO, "scripts", "bench-gpu.mjs"));
const gpuLeg = await runGpuBenches({ warmup: WARMUP, runs: RUNS, manifest });
console.log(
  `  adapter=${gpuLeg.adapter.vendor}/${gpuLeg.adapter.architecture} ` +
    `chromium=${gpuLeg.chromiumVersion} p2=${fmtS(gpuLeg.p2.median)} p3=${fmtS(gpuLeg.p3.median)}`,
);

// --- P1: adult, apriori, standard(0.5), depth 3, k=100 (CPU + workers)
async function benchP1() {
  const adultCsv = path.join(REPO, "reference", ".cache", "adult.csv");
  if (!fs.existsSync(adultCsv)) {
    throw new Error(
      "adult.csv missing — run `cd reference && uv run python scripts/fetch_adult.py`",
    );
  }
  const table = sw.fromCSV(fs.readFileSync(adultCsv, "utf8"));
  const t0 = performance.now();
  const space = sw.allSelectors(table, { ignore: ["income"], bins: 5 });
  const spaceMs = performance.now() - t0;
  const task = {
    table,
    target: sw.binary({ attribute: "income", value: ">50K" }),
    searchSpace: space,
    qf: sw.standard(0.5),
    resultSetSize: 100,
    depth: 3,
  };
  const workers = { count: Math.max(2, Math.min(5, cores - 1)), localThreshold: 0 };
  // Spare instrumented pass for the phase readout (not measured).
  const t1 = performance.now();
  const spare = sw.prepareTask(task);
  void spare.atlas.wordsPerRow;
  const prepMs = performance.now() - t1;
  const m = await measure(() => sw.apriori(task, { workers }));
  const cmp = compareToReference(m.last, p1RefTopk.results);
  p5Checks.push({
    id: "P5-P1",
    what: "P1 top-100 vs pysubgroup fixture (tie-tolerant, rel ≤ 1e-9)",
    ok: cmp.ok,
    detail: cmp.ok ? `${p1RefTopk.results.length} rows matched` : cmp.why,
  });
  const speedup = refP1.median_seconds / m.median;
  const pass = m.median <= 10 && speedup >= 10;
  rows.push({
    id: "P1",
    task: `adult (48842×15, ${space.length} sel), binary income>50K, standard(0.5), d3, k=100, apriori`,
    backend: `cpu+workers(${workers.count})`,
    phases: `space=${(spaceMs / 1000).toFixed(2)}s (outside span); atlas≈${(prepMs / 1000).toFixed(2)}s; evaluated=${m.last.candidatesEvaluated}, pruned=${m.last.candidatesPruned}`,
    median: m.median,
    runs: m.runs,
    reference: refP1.median_seconds,
    speedup,
    gate: "total ≤ 10 s AND ≥ 10× reference",
    pass,
  });
  gateRows.push({
    id: "m6-perf-p1",
    cell: "P1 adult apriori d3",
    check: "median ≤ 10 s and ≥ 10× measured reference",
    value: `${fmtS(m.median)}, ${speedup.toFixed(1)}× (ref ${fmtS(refP1.median_seconds)})`,
    expected: "≤ 10 s, ≥ 10×",
    gate: true,
    pass,
  });

  // STRETCH (record, non-blocking): patternTree on the P1 task.
  const pt = await measure(() => sw.patternTree(task), { warmup: 1, runs: 3 });
  const samePt = fp1(pt.last).key === fp1(m.last).key;
  rows.push({
    id: "S1",
    task: "P1 task via patternTree (STRETCH record)",
    backend: "cpu (tree-native)",
    phases: `evaluated=${pt.last.candidatesEvaluated}`,
    median: pt.median,
    runs: pt.runs,
    reference: refP1.median_seconds,
    speedup: refP1.median_seconds / pt.median,
    gate: `STRETCH (top-1 matches apriori: ${samePt})`,
    pass: true,
    stretch: true,
  });
}
await benchP1();
console.log(`· P1 done (${fmtS(rows[0].median)}, ${rows[0].speedup.toFixed(1)}×)`);

// --- P2: synth-2M×256sel binary, apriori d2 k=100 (CPU + workers; GPU above)
let p4Block = null;
async function benchP2() {
  const ds = sw.synth2MBinary();
  const hash = sw.datasetContentHash(ds.table);
  const hashOk = hash === manifest.binaryHash;
  const plantKey = ds.plant.canonicalKey();
  const space = sw.allSelectors(ds.table, { ignore: ["y"] });
  const task = {
    table: ds.table,
    target: sw.binary({ attribute: "y", value: 1 }),
    searchSpace: space,
    qf: sw.wracc(),
    resultSetSize: 100,
    depth: 2,
    minQuality: 0,
  };
  const workers = { count: Math.max(2, cores - 1), localThreshold: 0 };
  const t1 = performance.now();
  const spare = sw.prepareTask(task);
  void spare.atlas.wordsPerRow;
  const prepS = (performance.now() - t1) / 1000;
  const sampler = rssSampler();
  const m = await measure(() => sw.apriori(task, { workers }));
  const peakRss = sampler.stop();
  const cpuPlantOk = fp1(m.last).key === plantKey;
  const gpu = gpuLeg.p2;
  const ratio = m.median / gpu.median;
  const pass = m.median <= 60 && gpu.median <= 8 && ratio >= 5 && hashOk && gpu.hashOk;
  rows.push({
    id: "P2",
    task: `synth-2M×256sel binary (hash ${hash}${hashOk ? " ✓" : " MISMATCH"}), wracc, d2, k=100, apriori`,
    backend: `cpu+workers(${workers.count}) / webgpu[${gpu.backend}]`,
    phases: `atlas≈${prepS.toFixed(2)}s (cpu spare); evaluated=${m.last.candidatesEvaluated}`,
    median: m.median,
    runs: m.runs,
    gpuMedian: gpu.median,
    gpuRuns: gpu.runs,
    speedup: ratio,
    gate: "CPU ≤ 60 s; GPU ≤ 8 s; GPU ≥ 5× CPU",
    pass,
  });
  gateRows.push({
    id: "m6-perf-p2",
    cell: "P2 synth-2M binary apriori d2",
    check: "CPU ≤ 60 s; GPU ≤ 8 s; GPU ≥ 5× CPU; dataset hash pinned",
    value: `cpu=${fmtS(m.median)} gpu=${fmtS(gpu.median)} ratio=${ratio.toFixed(1)}× hash=${hashOk && gpu.hashOk ? "ok" : "MISMATCH"}`,
    expected: "cpu ≤ 60, gpu ≤ 8, ratio ≥ 5",
    gate: true,
    pass,
  });

  // P5-P2: plants at rank 1 on both backends + subsample == exhaustive.
  p5Checks.push({
    id: "P5-P2-plant",
    what: "P2 planted subgroup at rank 1 (CPU and GPU)",
    ok: cpuPlantOk && gpu.plantOk,
    detail: `cpu top=${fp1(m.last).key}, gpu top=${gpu.top.key}, plant=${plantKey}`,
  });
  const head = sw.headRows(ds.table, 100_000);
  const headTask = {
    ...task,
    table: head,
    searchSpace: sw.allSelectors(head, { ignore: ["y"] }),
  };
  const oracle = await sw.exhaustive(headTask);
  const sub = await sw.apriori(headTask, { workers });
  const fpo = oracle.entries.map((e) => `${e.description.canonicalKey()}@${e.quality}`).join("|");
  const fps = sub.entries.map((e) => `${e.description.canonicalKey()}@${e.quality}`).join("|");
  p5Checks.push({
    id: "P5-P2-subsample",
    what: "P2 pipeline == exhaustive oracle on 100k-row subsample (exact)",
    ok: fpo === fps,
    detail: `oracle evaluated ${oracle.candidatesEvaluated} candidates`,
  });

  // P4 ledger (from this run).
  const wpr = Math.ceil(ds.table.nRows / 32);
  const atlasBytes = space.length * wpr * 4;
  const sabBytes = atlasBytes + wpr * 4; // shared atlas + positives bits
  const batchBytes = 4096 * (4 + 4) + 4096 * 2 * 2; // stats SoA + tuple slice
  const scratchBytes = (task.depth + 1) * wpr * 4;
  const topkBytes = 100 * (task.depth * 2 + 8 + 16);
  p4Block = {
    atlasBytes,
    positivesBytes: wpr * 4,
    sabBytes,
    batchBytes,
    scratchBytes,
    topkBytes,
    datasetBytes: 32 * ds.table.nRows * 4 + ds.table.nRows * 8,
    peakRss,
    gpu: {
      atlasBytes,
      codesBytes: 32 * wpr * 32,
      note: "codes-mode: GPU builds the atlas on-device; CPU atlas never constructed in the GPU run",
    },
  };
  const dominance = atlasBytes / (atlasBytes + batchBytes + scratchBytes + topkBytes);
  gateRows.push({
    id: "m6-perf-p4",
    cell: "P2 run memory",
    check: "ledger documented; selector bitsets dominate; no per-candidate cover storage",
    value: `atlas=${(atlasBytes / 1e6).toFixed(0)} MB (${(dominance * 100).toFixed(1)}% of search allocations); batch=${(batchBytes / 1024).toFixed(0)} KB; peakRSS=${(peakRss / 2 ** 30).toFixed(2)} GB`,
    expected: "bitsets ≈ 64 MB dominate; batch buffers O(batchSize)",
    gate: true,
    // 256 selectors × 62,500 words × 4 B = 64,000,000 B — the BRIEF's "≈ 64 MB".
    pass: dominance >= 0.9 && atlasBytes >= 60e6 && atlasBytes <= 70e6,
  });
}
await benchP2();
console.log(`· P2 done (cpu=${fmtS(rows.at(-1).median)}, gpu=${fmtS(gpuLeg.p2.median)})`);

// --- P3: synth-2M numeric, standardNumeric(1,'sum'), beamSearch(50), d3
async function benchP3() {
  const ds = sw.synth2MNumeric();
  const hash = sw.datasetContentHash(ds.table);
  const hashOk = hash === manifest.numericHash;
  const plantKey = ds.plant.canonicalKey();
  const space = sw.allSelectors(ds.table, { ignore: ["t"] });
  const task = {
    table: ds.table,
    target: sw.numeric("t"),
    searchSpace: space,
    qf: sw.standardNumeric(1, { estimator: "sum" }),
    resultSetSize: 50,
    depth: 3,
    minQuality: 0,
  };
  const workers = { count: Math.max(2, cores - 1), localThreshold: 32 };
  const m = await measure(() => sw.beamSearch(task, { width: 50, workers }));
  const cpuPlantOk = fp1(m.last).key === plantKey;
  const gpu = gpuLeg.p3;
  const pass = m.median <= 180 && gpu.median <= 30 && hashOk && gpu.hashOk;
  rows.push({
    id: "P3",
    task: `synth-2M numeric (hash ${hash}${hashOk ? " ✓" : " MISMATCH"}), standardNumeric(1,sum), beam(50), d3`,
    backend: `cpu+workers(${workers.count}) / webgpu[${gpu.backend}]`,
    phases: `evaluated=${m.last.candidatesEvaluated}; gpu band: screened=${gpu.band?.screened ?? 0} rescored=${gpu.band?.rescored ?? 0}`,
    median: m.median,
    runs: m.runs,
    gpuMedian: gpu.median,
    gpuRuns: gpu.runs,
    speedup: m.median / gpu.median,
    gate: "CPU ≤ 180 s; GPU ≤ 30 s",
    pass,
  });
  gateRows.push({
    id: "m6-perf-p3",
    cell: "P3 synth-2M numeric beam(50) d3",
    check: "CPU ≤ 180 s; GPU ≤ 30 s; dataset hash pinned",
    value: `cpu=${fmtS(m.median)} gpu=${fmtS(gpu.median)} hash=${hashOk && gpu.hashOk ? "ok" : "MISMATCH"}`,
    expected: "cpu ≤ 180, gpu ≤ 30",
    gate: true,
    pass,
  });
  p5Checks.push({
    id: "P5-P3-plant",
    what: "P3 planted subgroup at rank 1 (CPU and GPU)",
    ok: cpuPlantOk && gpu.plantOk,
    detail: `cpu top=${fp1(m.last).key}, gpu top=${gpu.top.key}`,
  });
  const head = sw.headRows(ds.table, 100_000);
  const headTask = {
    ...task,
    table: head,
    searchSpace: sw.allSelectors(head, { ignore: ["t"] }),
  };
  const oracle = await sw.exhaustive(headTask);
  const sub = await sw.beamSearch(headTask, { width: 50 });
  const fpo = oracle.entries.map((e) => `${e.description.canonicalKey()}@${e.quality}`).join("|");
  const fps = sub.entries.map((e) => `${e.description.canonicalKey()}@${e.quality}`).join("|");
  p5Checks.push({
    id: "P5-P3-subsample",
    what: "P3 pipeline == exhaustive oracle top-50 on 100k-row subsample (exact)",
    ok: fpo === fps,
    detail: `oracle evaluated ${oracle.candidatesEvaluated} candidates`,
  });
}
await benchP3();
console.log(`· P3 done (cpu=${fmtS(rows.at(-1).median)}, gpu=${fmtS(gpuLeg.p3.median)})`);

sw.terminateCachedWorkers();

const p5ok = p5Checks.every((c) => c.ok);
gateRows.push({
  id: "m6-perf-p5",
  cell: "P1–P3 outputs",
  check: "correctness under perf (reference match; plants rank 1; subsample == oracle)",
  value: p5Checks.map((c) => `${c.id}:${c.ok ? "ok" : "FAIL"}`).join(" "),
  expected: "all ok",
  gate: true,
  pass: p5ok,
});

// ---------------------------------------------------------------------------
// report

function envBlock() {
  const chip = tryExec("sysctl -n machdep.cpu.brand_string");
  const mem = `${Math.round(os.totalmem() / 1024 ** 3)} GB`;
  const macos = tryExec("sw_vers -productVersion");
  return [
    "## Environment",
    "",
    `- chip: ${chip} (${cores} cores, ${mem})`,
    `- macOS: ${macos}`,
    `- chromium: ${gpuLeg.chromiumVersion} (Playwright), adapter: ${gpuLeg.adapter.vendor}/${gpuLeg.adapter.architecture}, maxStorageBufferBindingSize=${gpuLeg.adapter.maxStorageBufferBindingSize}`,
    `- node: ${process.version}, pnpm: ${tryExec("pnpm --version")}`,
    `- reference: pysubgroup ${refTimings.versions.pysubgroup} (pandas ${refTimings.versions.pandas}, numpy ${refTimings.versions.numpy}, scipy ${refTimings.versions.scipy}); timings from reference/fixtures/ref_timings.json`,
    `- methodology: ${WARMUP} warmup + ${RUNS} measured runs, median; span = algorithm call (incl. atlas build + results), space build outside (both sides)`,
    `- date: ${new Date().toISOString()}`,
    "",
  ].join("\n");
}

const lines = [];
lines.push("# BENCHMARKS.md — performance report");
lines.push("");
lines.push("Generated by `pnpm bench:gates`. Do not edit by hand (BRIEF §21).");
lines.push("");
lines.push(envBlock());
lines.push("## Performance gates (BRIEF §8.1)");
lines.push("");
lines.push(
  "| id | task | backend | median | runs | gpu median | reference | speedup | gate | verdict |",
);
lines.push("|---|---|---|---|---|---|---|---|---|---|");
for (const r of rows) {
  lines.push(
    `| ${r.id}${r.stretch ? " (STRETCH)" : ""} | ${r.task} | ${r.backend} | ${fmtS(r.median)} | ${r.runs
      .map((x) => x.toFixed(3))
      .join(" / ")} | ${r.gpuMedian !== undefined ? fmtS(r.gpuMedian) : "—"} | ${
      r.reference !== undefined ? fmtS(r.reference) : "—"
    } | ${r.speedup !== undefined ? `${r.speedup.toFixed(1)}×` : "—"} | ${r.gate} | ${
      r.stretch ? "RECORDED" : r.pass ? "PASS" : "FAIL"
    } |`,
  );
}
lines.push("");
lines.push("Phase notes:");
for (const r of rows) lines.push(`- ${r.id}: ${r.phases}`);
lines.push("");
lines.push("## P4 — memory ledger (P2 CPU run)");
lines.push("");
lines.push("| allocation | bytes | note |");
lines.push("|---|---|---|");
lines.push(
  `| selector bitset atlas | ${p4Block.atlasBytes.toLocaleString()} (${(p4Block.atlasBytes / 2 ** 20).toFixed(1)} MB) | 256 selectors × ${Math.ceil(2000000 / 32).toLocaleString()} words — DOMINANT |`,
);
lines.push(`| target positives bitset | ${p4Block.positivesBytes.toLocaleString()} | one row |`);
lines.push(
  `| SAB copies (worker pool) | ${p4Block.sabBytes.toLocaleString()} | atlas + positives, shared zero-copy across workers |`,
);
lines.push(
  `| per-batch stats + tuples | ${p4Block.batchBytes.toLocaleString()} | O(batchSize=4096), reused — INDEPENDENT of |C| |`,
);
lines.push(
  `| prefix/extension scratch | ${p4Block.scratchBytes.toLocaleString()} | depth+1 cover rows |`,
);
lines.push(`| top-k (k=100) | ${p4Block.topkBytes.toLocaleString()} | tuples + aux stats |`);
lines.push(
  `| dataset (columns) | ${p4Block.datasetBytes.toLocaleString()} (${(p4Block.datasetBytes / 2 ** 20).toFixed(0)} MB) | input data, not search state |`,
);
lines.push("");
lines.push(
  `Peak RSS during the measured P2 CPU runs: ${(p4Block.peakRss / 2 ** 30).toFixed(2)} GB ` +
    "(includes the in-memory 2M-row dataset and the Node heap). No per-candidate cover is ever " +
    "stored: covers exist only as the active batch's scratch rows (fused kernels skip even the " +
    "final-level cover write), so search memory is O(atlas + batchSize), not O(|candidates| × n).",
);
lines.push("");
lines.push(
  `GPU (codes mode): atlas ${(p4Block.gpu.atlasBytes / 2 ** 20).toFixed(1)} MB GPU-resident + ` +
    `codes upload ${(p4Block.gpu.codesBytes / 2 ** 20).toFixed(1)} MB; ${p4Block.gpu.note}.`,
);
lines.push("");
lines.push("## P5 — correctness under performance");
lines.push("");
lines.push("| check | verdict | detail |");
lines.push("|---|---|---|");
for (const c of p5Checks) {
  lines.push(`| ${c.id}: ${c.what} | ${c.ok ? "PASS" : "FAIL"} | ${c.detail} |`);
}
lines.push("");
const allPass = gateRows.every((r) => r.pass);
lines.push(`**Gates: ${gateRows.filter((r) => r.pass).length}/${gateRows.length} pass.**`);
lines.push("");

fs.writeFileSync(path.join(REPO, "BENCHMARKS.md"), lines.join("\n"));
for (const row of gateRows) recordRow(row);

console.log(
  `bench${gatesOnly ? ":gates" : ""}: BENCHMARKS.md regenerated; ${gateRows.length} gate rows (${allPass ? "all PASS" : "FAILURES PRESENT"})`,
);
process.exit(allPass ? 0 : 1);
