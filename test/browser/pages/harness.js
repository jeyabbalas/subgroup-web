/**
 * In-page harness for the §6.2 GPU exactness / cross-backend identity gates
 * (test/browser/backends.spec.ts drives it via page.evaluate).
 *
 * Mirrors test/util/cells.ts task materialization using the BUILT library
 * (dist/) — datasets arrive byte-identical over fetch, so tables, selector
 * spaces, and tasks are identical to the Node side's.
 */
import * as sw from "/dist/index.js";
import { registerWebGpu, requestSubgroupWebDevice, WebGpuEvaluator } from "/dist/webgpu.js";

const tables = new Map();

async function loadTable(name) {
  let table = tables.get(name);
  if (table !== undefined) return table;
  const url = name.startsWith("synth:")
    ? `/test/fixtures/datasets/${name.slice("synth:".length)}.csv`
    : `/reference/datasets/${name}.csv`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  table = sw.fromCSV(await res.text());
  tables.set(name, table);
  return table;
}

function buildSpace(table, spec) {
  const base = spec.nominalOnly
    ? sw.nominalSelectors(table, { ignore: spec.ignore ?? [] })
    : sw.allSelectors(table, {
        ignore: spec.ignore ?? [],
        bins: spec.nbins ?? 5,
        intervalsOnly: spec.intervalsOnly ?? true,
      });
  return spec.negations ? [...base, ...base.map((s) => sw.negated(s))] : base;
}

function makeTarget(spec) {
  switch (spec.type) {
    case "binary":
      return sw.binary({ attribute: spec.attribute, value: spec.value });
    case "numeric":
      return sw.numeric(spec.attribute);
    case "fi":
      return sw.frequentItemset();
    default:
      throw new Error(`harness target ${spec.type} not supported`);
  }
}

function makeQF(spec) {
  switch (spec.name) {
    case "wracc":
      return sw.wracc();
    case "standardNumeric":
      return sw.standardNumeric(spec.a, {
        ...(spec.invert !== undefined ? { invert: spec.invert } : {}),
        ...(spec.estimator !== undefined ? { estimator: spec.estimator } : {}),
      });
    case "count":
      return sw.count();
    case "area":
      return sw.area();
    default:
      throw new Error(`harness qf ${spec.name} not supported`);
  }
}

async function buildTask(cell) {
  const table = await loadTable(cell.dataset);
  return {
    table,
    target: makeTarget(cell.target),
    searchSpace: buildSpace(table, cell.space),
    qf: makeQF(cell.qf),
    resultSetSize: cell.k,
    depth: cell.depth,
    minQuality: cell.minQuality ?? Number.NEGATIVE_INFINITY,
    constraints: (cell.constraints ?? []).map((c) => sw.minSupport(c.count)),
  };
}

const ALGORITHMS = {
  apriori: (t, o) => sw.apriori(t, o),
  dfs: (t, o) => sw.dfs(t, o),
  bestFirst: (t, o) => sw.bestFirst(t, o),
  beam: (t, o) => sw.beamSearch(t, { ...o, width: Math.max(20, t.resultSetSize) }),
  generalizingBFS: (t, o) => sw.generalizingBFS(t, o),
};

/** Run one cell/algorithm/options; fingerprint + backend diagnostics. */
async function runCell(cell, algorithm, options) {
  const task = await buildTask(cell);
  const results = await ALGORITHMS[algorithm](task, options ?? {});
  return {
    fingerprint: results.entries.map((e) => ({
      key: e.description.canonicalKey(),
      quality: e.quality,
    })),
    backend: results.backend,
    evaluated: results.candidatesEvaluated,
    crossOriginIsolated: globalThis.crossOriginIsolated === true,
  };
}

/**
 * §12 empirical band validation: GPU screening statistics vs CPU f64 on
 * every 1- and 2-tuple of the cell's space (capped). Returns violation
 * counts (MUST be zero) and observed error magnitudes.
 */
async function validateBand(cell, cap = 4000) {
  const task = await buildTask(cell);
  const prepared = sw.prepareTask(task);
  const plan = prepared.qf.kind === "numeric" ? prepared.qf.plan : null;
  const device = await requestSubgroupWebDevice();
  const gpu = await WebGpuEvaluator.create(device, prepared);
  const cpu = new sw.CpuEvaluator(prepared.atlas, prepared.prepared, plan);
  const nSel = prepared.selectors.length;
  const tuples = [];
  for (let i = 0; i < nSel; i++) tuples.push([i]);
  for (let i = 0; i < nSel && tuples.length < cap; i++) {
    for (let j = i + 1; j < nSel && tuples.length < cap; j++) tuples.push([i, j]);
  }
  const stats = {
    candidates: 0,
    sizeMismatches: 0,
    sumViolations: 0,
    excessViolations: 0,
    maxSumErr: 0,
    maxSumEps: 0,
    maxRelSumErr: 0,
    screening: gpu.screening,
  };
  for (const arity of [1, 2]) {
    const list = tuples.filter((t) => t.length === arity);
    if (list.length === 0) continue;
    const flat = new Uint16Array(list.length * arity);
    list.forEach((t, i) => {
      flat.set(t, i * arity);
    });
    const g = await gpu.evaluateTuples(flat, arity, list.length);
    const c = cpu.evaluateTuples(flat, arity, list.length);
    for (let i = 0; i < list.length; i++) {
      stats.candidates++;
      if (g.size[i] !== c.size[i]) stats.sizeMismatches++;
      if (gpu.screening) {
        const sumErr = Math.abs(g.sum[i] - c.sum[i]);
        const sumEps = g.screening.sumEps[i];
        if (sumErr > sumEps) stats.sumViolations++;
        if (sumErr > stats.maxSumErr) stats.maxSumErr = sumErr;
        if (sumEps > stats.maxSumEps) stats.maxSumEps = sumEps;
        if (c.sum[i] !== 0) {
          stats.maxRelSumErr = Math.max(stats.maxRelSumErr, sumErr / Math.abs(c.sum[i]));
        }
        if (g.excessSum !== null && c.excessSum !== null) {
          const exErr = Math.abs(g.excessSum[i] - c.excessSum[i]);
          if (exErr > g.screening.excessEps[i]) stats.excessViolations++;
        }
      } else if (g.positives !== null && g.positives[i] !== c.positives[i]) {
        stats.sizeMismatches++;
      }
    }
  }
  gpu.dispose();
  cpu.dispose();
  return stats;
}

async function adapterInfo() {
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) return null;
  const i = adapter.info;
  return { vendor: i?.vendor ?? "", architecture: i?.architecture ?? "", device: i?.device ?? "" };
}

registerWebGpu();
globalThis.subgroupWebHarness = { runCell, validateBand, adapterInfo, registerWebGpu };
document.getElementById("status").textContent = "ready";
