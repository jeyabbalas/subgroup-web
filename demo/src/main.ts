/**
 * subgroup-web demo (BRIEF §15): a privacy-preserving in-browser subgroup
 * discovery explorer. Everything — CSV parsing, search, rendering — runs
 * locally; no data ever leaves the page.
 */

import {
  allSelectors,
  apriori,
  area,
  beamSearch,
  bestFirst,
  binary,
  candidateSpaceSize,
  chiSquared,
  count,
  type DataTable,
  dfs,
  dfsNumeric,
  exhaustive,
  frequentItemset,
  fromCSV,
  generalizingBFS,
  lift,
  minimumQualityFilter,
  minimumStatisticFilter,
  minSupport,
  numeric,
  overlapFilter,
  patternTree,
  plantedBinary,
  type QF,
  type SearchOptions,
  type SearchProgress,
  type SubgroupResults,
  type SubgroupTask,
  serializeResults,
  simpleBinomial,
  standard,
  standardNumeric,
  type Target,
  uniqueAttributes,
  VERSION,
  wracc,
} from "subgroup-web";
import { registerWebGpu, webgpuSupported } from "subgroup-web/webgpu";
import { bar, clear, download, el, fmt, fmtMs } from "./dom.js";
import { drawHistogram, drawRoc, drawSgBars, drawShareComparison, rocPoints } from "./plots.js";
import workerScriptUrl from "./sw-worker.js?worker&url";
import "./style.css";

const BASE = import.meta.env.BASE_URL;

// ---------------------------------------------------------------------------
// App state

interface TargetChoice {
  kind: "binary" | "numeric" | "fi";
  attribute: string | null;
  value: CategoryValueLike | null;
}
type CategoryValueLike = string | number | boolean;

const state = {
  table: null as DataTable | null,
  datasetLabel: "",
  datasetNote: "",
  targetChoice: { kind: "binary", attribute: null, value: null } as TargetChoice,
  includedAttrs: new Set<string>(),
  results: null as SubgroupResults | null,
  filtered: null as SubgroupResults | null,
  selected: -1,
  controller: null as AbortController | null,
  sort: { key: "rank", dir: 1 },
  gpuAdapter: "",
};

if (webgpuSupported()) {
  registerWebGpu();
  void navigator.gpu.requestAdapter({ powerPreference: "high-performance" }).then((a) => {
    if (a) {
      state.gpuAdapter = `${a.info?.vendor ?? "?"}/${a.info?.architecture ?? "?"}`;
      const elBadge = document.querySelector("#gpu-badge");
      if (elBadge) elBadge.textContent = `WebGPU: ${state.gpuAdapter}`;
    }
  });
}

// ---------------------------------------------------------------------------
// Layout

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("missing #app");

const coiBadge = el("span", {
  class: `badge ${globalThis.crossOriginIsolated ? "on" : "off"}`,
  title: globalThis.crossOriginIsolated
    ? "SharedArrayBuffer available: workers share the bitset atlas zero-copy"
    : "No COOP/COEP headers (e.g. GitHub Pages): workers receive a transferred copy — results identical",
  text: `crossOriginIsolated: ${String(globalThis.crossOriginIsolated ?? false)}`,
});
const gpuBadge = el("span", {
  class: `badge ${webgpuSupported() ? "on" : "off"}`,
  id: "gpu-badge",
  text: webgpuSupported() ? "WebGPU: probing…" : "WebGPU: unavailable",
});

const header = el(
  "header",
  { class: "app" },
  el("h1", { text: `subgroup-web` }),
  el("span", { class: "sub", text: `v${VERSION} — in-browser subgroup discovery` }),
  el("span", {
    class: "badge on",
    text: "100% local — your data never leaves this page",
    title: "CSV parsing, search and rendering all run in this tab; there is no server.",
  }),
  el("span", { class: "spacer" }),
  coiBadge,
  gpuBadge,
  el("a", { href: `${BASE}api/`, target: "_blank", rel: "noreferrer", text: "API docs" }),
  el("a", {
    href: "https://github.com/jeyabbalas/subgroup-web",
    target: "_blank",
    rel: "noreferrer",
    text: "GitHub",
  }),
);

const panelDataset = el("section", { class: "panel" }, el("h2", { text: "1 · Dataset" }));
const panelTarget = el("section", { class: "panel" }, el("h2", { text: "2 · Target" }));
const panelSpace = el("section", { class: "panel" }, el("h2", { text: "3 · Search space" }));
const panelTask = el("section", { class: "panel" }, el("h2", { text: "4 · Task" }));
const panelRun = el("section", { class: "panel" }, el("h2", { text: "5 · Run" }));
const panelResults = el("section", { class: "panel" }, el("h2", { text: "Results" }));
const panelPlots = el("section", { class: "panel" }, el("h2", { text: "Views" }));
const panelDetail = el("section", { class: "panel" }, el("h2", { text: "Subgroup detail" }));

root.append(
  header,
  el(
    "main",
    {},
    el("div", { class: "col" }, panelDataset, panelTarget, panelSpace, panelTask, panelRun),
    el("div", { class: "col" }, panelResults, panelPlots, panelDetail),
  ),
);

// ---------------------------------------------------------------------------
// 1 · Dataset panel

const SAMPLES: Record<string, { file: string; note: string }> = {
  titanic: { file: "titanic.csv", note: "156 passengers (pysubgroup sample) — who survived?" },
  "credit-g": { file: "credit-g.csv", note: "1000 German credit applications — good vs bad risk" },
  "adult-sample": { file: "adult-sample.csv", note: "2000-row sample of UCI adult — income >50K" },
};

const datasetSelect = el("select", { "data-testid": "dataset-select" });
datasetSelect.append(el("option", { value: "", text: "— choose a dataset —" }));
for (const name of Object.keys(SAMPLES))
  datasetSelect.append(el("option", { value: name, text: name }));
datasetSelect.append(el("option", { value: "synthetic", text: "synthetic (planted subgroup)" }));

const uploadInput = el("input", { type: "file", accept: ".csv,text/csv" });
const datasetInfo = el("p", {
  class: "note",
  text: "Samples ship with the app; uploads are parsed locally in this tab and never leave your machine.",
});
const datasetError = el("p", { class: "error" });

panelDataset.append(
  el("div", { class: "row" }, el("label", { text: "Sample" }), datasetSelect),
  el("div", { class: "row" }, el("label", { text: "Upload CSV" }), uploadInput),
  datasetInfo,
  datasetError,
);

datasetSelect.addEventListener("change", () => {
  const v = datasetSelect.value;
  if (v === "") return;
  if (v === "synthetic") {
    const planted = plantedBinary({ n: 5000, seed: 20260711 });
    setTable(
      planted.table,
      "synthetic (planted)",
      `plant: ${planted.plant.toString()} — the search should recover it at rank 1`,
    );
    return;
  }
  const sample = SAMPLES[v];
  if (!sample) return;
  datasetError.textContent = "";
  fetch(`${BASE}data/${sample.file}`)
    .then((r) => {
      if (!r.ok) throw new Error(`fetch ${sample.file}: HTTP ${r.status}`);
      return r.text();
    })
    .then((text) => setTable(fromCSV(text), v, sample.note))
    .catch((e) => {
      datasetError.textContent = String(e);
    });
});

uploadInput.addEventListener("change", () => {
  const file = uploadInput.files?.[0];
  if (!file) return;
  datasetError.textContent = "";
  file
    .text()
    .then((text) =>
      setTable(fromCSV(text), file.name, "uploaded — parsed locally, not sent anywhere"),
    )
    .catch((e) => {
      datasetError.textContent = `CSV parse failed: ${String(e)}`;
    });
});

function setTable(table: DataTable, label: string, note: string): void {
  state.table = table;
  state.datasetLabel = label;
  state.datasetNote = note;
  state.results = null;
  state.filtered = null;
  state.selected = -1;
  datasetInfo.textContent = `${label}: ${table.nRows.toLocaleString("en-US")} rows × ${table.names.length} columns. ${note}`;
  state.targetChoice = autoTarget(table, label);
  rebuildTargetPanel();
  rebuildSpacePanel();
  rebuildTaskPanel();
  renderResults();
  renderPlots();
  renderDetail();
  runButton.disabled = false;
}

// ---------------------------------------------------------------------------
// 2 · Target panel (auto-detection: binary value picker / numeric column)

function distinctValues(table: DataTable, name: string): CategoryValueLike[] {
  const col = table.column(name);
  if (col.kind === "categorical") return [...col.categories];
  if (col.kind === "boolean") return [true, false];
  const seen = new Set<number>();
  for (const v of col.values) {
    if (!Number.isNaN(v)) seen.add(v);
    if (seen.size > 24) break;
  }
  return [...seen].sort((a, b) => a - b);
}

/** Count rows equal to `value` (for the minority-value default). */
function valueCount(table: DataTable, name: string, value: CategoryValueLike): number {
  let c = 0;
  for (let i = 0; i < table.nRows; i++) if (table.value(name, i) === value) c++;
  return c;
}

function autoTarget(table: DataTable, label: string): TargetChoice {
  if (label === "synthetic (planted)") return { kind: "binary", attribute: "y", value: 1 };
  const preferredNames = /^(class|target|label|outcome|income|survived|y)$/i;
  const binaryish = (name: string) => distinctValues(table, name).length === 2;
  const named = table.names.find((n) => preferredNames.test(n));
  const attr = named ?? table.names.find(binaryish) ?? table.names[table.names.length - 1]!;
  const col = table.column(attr);
  if (col.kind === "numeric" && distinctValues(table, attr).length > 12) {
    return { kind: "numeric", attribute: attr, value: null };
  }
  const values = distinctValues(table, attr);
  let minority = values[0] ?? null;
  if (values.length >= 2 && values.length <= 12) {
    minority = values.reduce((best, v) =>
      valueCount(table, attr, v) < valueCount(table, attr, best) ? v : best,
    );
  }
  return { kind: "binary", attribute: attr, value: minority };
}

function targetFromChoice(c: TargetChoice): Target {
  if (c.kind === "fi") return frequentItemset();
  if (c.kind === "numeric") return numeric(c.attribute!);
  return binary({ attribute: c.attribute!, value: c.value! });
}

function rebuildTargetPanel(): void {
  clear(panelTarget);
  panelTarget.append(el("h2", { text: "2 · Target" }));
  const table = state.table;
  if (!table) {
    panelTarget.append(el("p", { class: "note", text: "Load a dataset first." }));
    return;
  }
  const kindSel = el("select", { "data-testid": "target-kind" });
  for (const [v, label] of [
    ["binary", "binary — share of a value"],
    ["numeric", "numeric — mean shift"],
    ["fi", "frequent itemsets — no target"],
  ] as const) {
    kindSel.append(
      el("option", { value: v, text: label, selected: state.targetChoice.kind === v }),
    );
  }
  const attrSel = el("select", { "data-testid": "target-attribute" });
  const valueSel = el("select", { "data-testid": "target-value" });
  const info = el("p", { class: "note" });

  const numericAttrs = table.names.filter((n) => table.column(n).kind === "numeric");
  const fillAttrs = () => {
    clear(attrSel);
    const names = state.targetChoice.kind === "numeric" ? numericAttrs : table.names;
    for (const n of names) {
      attrSel.append(
        el("option", { value: n, text: n, selected: n === state.targetChoice.attribute }),
      );
    }
    if (!names.includes(state.targetChoice.attribute ?? "")) {
      state.targetChoice.attribute = names[0] ?? null;
    }
  };
  const fillValues = () => {
    clear(valueSel);
    if (state.targetChoice.kind !== "binary" || !state.targetChoice.attribute) return;
    const values = distinctValues(table, state.targetChoice.attribute);
    for (const v of values) {
      const n = valueCount(table, state.targetChoice.attribute, v);
      valueSel.append(
        el("option", {
          value: String(v),
          text: `${String(v)}  (${n.toLocaleString("en-US")} rows)`,
          selected: v === state.targetChoice.value,
        }),
      );
    }
    if (!values.some((v) => v === state.targetChoice.value))
      state.targetChoice.value = values[0] ?? null;
    // <option value> stringifies; keep the typed value by index.
    valueSel.addEventListener("change", () => {
      state.targetChoice.value = values[valueSel.selectedIndex] ?? null;
      refreshInfo();
      rebuildTaskPanel();
    });
  };
  const refreshInfo = () => {
    if (state.targetChoice.kind === "binary" && state.targetChoice.attribute) {
      const p = valueCount(table, state.targetChoice.attribute, state.targetChoice.value!);
      info.textContent = `positives: ${p.toLocaleString("en-US")} of ${table.nRows.toLocaleString("en-US")} rows (${((100 * p) / table.nRows).toFixed(1)}%)`;
    } else if (state.targetChoice.kind === "numeric") {
      info.textContent = "quality functions compare the subgroup mean against the population mean";
    } else {
      info.textContent = "mines large itemsets (count / area quality)";
    }
  };

  kindSel.addEventListener("change", () => {
    state.targetChoice.kind = kindSel.value as TargetChoice["kind"];
    fillAttrs();
    fillValues();
    refreshInfo();
    rebuildSpacePanel();
    rebuildTaskPanel();
  });
  attrSel.addEventListener("change", () => {
    state.targetChoice.attribute = attrSel.value;
    fillValues();
    refreshInfo();
    rebuildSpacePanel();
    rebuildTaskPanel();
  });

  fillAttrs();
  fillValues();
  refreshInfo();

  panelTarget.append(
    el("div", { class: "row" }, el("label", { text: "Kind" }), kindSel),
    el("div", { class: "row" }, el("label", { text: "Attribute" }), attrSel),
    el("div", { class: "row" }, el("label", { text: "Value" }), valueSel),
    info,
  );
  valueSel.style.display = state.targetChoice.kind === "binary" ? "" : "none";
  valueSel.previousSibling as HTMLElement | null /* label row handled via display above */;
}

// ---------------------------------------------------------------------------
// 3 · Search-space panel

const spaceControls = {
  bins: 5,
  intervalsOnly: true,
  negations: false,
};

function defaultIncluded(table: DataTable, name: string): boolean {
  const col = table.column(name);
  if (col.kind === "categorical") {
    if (col.categories.length > 25) return false;
    return true;
  }
  if (col.kind === "numeric") {
    // id-like heuristic: all-distinct integers carry no subgroup signal.
    if (col.integerLike) {
      const seen = new Set<number>();
      for (const v of col.values) seen.add(v);
      if (seen.size === col.values.length) return false;
    }
    return true;
  }
  return true;
}

function currentIgnore(): string[] {
  const table = state.table!;
  const ignore = table.names.filter((n) => !state.includedAttrs.has(n));
  const t = state.targetChoice;
  if (t.kind !== "fi" && t.attribute && !ignore.includes(t.attribute)) ignore.push(t.attribute);
  return ignore;
}

function buildSpace() {
  return allSelectors(state.table!, {
    ignore: currentIgnore(),
    bins: spaceControls.bins,
    intervalsOnly: spaceControls.intervalsOnly,
    negations: spaceControls.negations,
  });
}

function rebuildSpacePanel(): void {
  clear(panelSpace);
  panelSpace.append(el("h2", { text: "3 · Search space" }));
  const table = state.table;
  if (!table) {
    panelSpace.append(el("p", { class: "note", text: "Load a dataset first." }));
    return;
  }
  state.includedAttrs = new Set(table.names.filter((n) => defaultIncluded(table, n)));
  if (state.targetChoice.attribute) state.includedAttrs.delete(state.targetChoice.attribute);

  const list = el("div", { class: "attr-list", "data-testid": "attr-list" });
  const counter = el("p", { class: "note" });
  const refreshCount = () => {
    try {
      const space = buildSpace();
      counter.textContent = `${space.length} selectors → ${fmt(candidateSpaceSize(space.length, taskControls.depth))} candidates at depth ${taskControls.depth}`;
      counter.classList.remove("error");
    } catch (e) {
      counter.textContent = String(e);
      counter.classList.add("error");
    }
  };
  refreshCountHook = refreshCount;

  for (const name of table.names) {
    if (name === state.targetChoice.attribute && state.targetChoice.kind !== "fi") continue;
    const col = table.column(name);
    const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
    cb.checked = state.includedAttrs.has(name);
    cb.addEventListener("change", () => {
      if (cb.checked) state.includedAttrs.add(name);
      else state.includedAttrs.delete(name);
      refreshCount();
    });
    const kindLabel = col.kind === "categorical" ? `${col.categories.length} cats` : col.kind;
    list.append(
      el(
        "label",
        {},
        cb,
        el("span", { text: name }),
        el("span", { class: "kind", text: kindLabel }),
      ),
    );
  }

  const binsInput = el("input", {
    type: "number",
    min: 2,
    max: 20,
    value: spaceControls.bins,
  }) as HTMLInputElement;
  binsInput.addEventListener("change", () => {
    spaceControls.bins = Math.max(2, Math.min(20, Number(binsInput.value) || 5));
    refreshCount();
  });
  const intervalsCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  intervalsCb.checked = spaceControls.intervalsOnly;
  intervalsCb.addEventListener("change", () => {
    spaceControls.intervalsOnly = intervalsCb.checked;
    refreshCount();
  });
  const negationsCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  negationsCb.checked = spaceControls.negations;
  negationsCb.addEventListener("change", () => {
    spaceControls.negations = negationsCb.checked;
    refreshCount();
  });

  panelSpace.append(
    list,
    el(
      "div",
      { class: "row" },
      el("label", { text: "Bins" }),
      binsInput,
      el("label", { text: "intervals only" }),
      intervalsCb,
      el("label", { text: "negations" }),
      negationsCb,
    ),
    counter,
  );
  refreshCount();
}

let refreshCountHook: (() => void) | null = null;

// ---------------------------------------------------------------------------
// 4 · Task panel (QF, algorithm, depth, k, min-support, min-quality, backend)

const taskControls = {
  qf: "standard",
  qfA: 0.5,
  chiDirection: "both" as "both" | "positive",
  estimator: "sum" as "sum" | "average" | "max" | "order",
  invert: false,
  algorithm: "apriori",
  depth: 2,
  k: 20,
  minQuality: 0,
  minSupportRows: 0,
  beamWidth: 20,
  backend: "auto" as "auto" | "cpu" | "workers" | "webgpu",
  pruning: true,
};

const QFS: Record<string, { label: string; kinds: TargetChoice["kind"][] }> = {
  standard: { label: "standard(a) — share lift × sizeᵃ", kinds: ["binary"] },
  wracc: { label: "wracc — weighted relative accuracy", kinds: ["binary"] },
  simpleBinomial: { label: "simple binomial (a=0.5)", kinds: ["binary"] },
  lift: { label: "lift (a=0)", kinds: ["binary"] },
  chiSquared: { label: "chi² statistic", kinds: ["binary"] },
  standardNumeric: { label: "standardNumeric(a) — mean shift × sizeᵃ", kinds: ["numeric"] },
  count: { label: "count — itemset support", kinds: ["fi"] },
  area: { label: "area — support × depth", kinds: ["fi"] },
};

const ALGORITHMS: Record<
  string,
  { label: string; kinds?: TargetChoice["kind"][]; qfs?: string[] }
> = {
  apriori: { label: "apriori — exact, level-wise" },
  dfs: { label: "dfs — exact, depth-first" },
  bestFirst: { label: "bestFirst — exact, estimate-ordered" },
  beamSearch: { label: "beamSearch — heuristic beam" },
  dfsNumeric: {
    label: "dfsNumeric — exact, numeric-sorted",
    kinds: ["numeric"],
    qfs: ["standardNumeric"],
  },
  patternTree: { label: "patternTree — exact FP-growth", kinds: ["binary", "fi"] },
  generalizingBFS: {
    label: "generalizingBFS — exact, disjunctions",
    kinds: ["binary"],
    qfs: ["standard", "wracc", "simpleBinomial", "lift"],
  },
  exhaustive: { label: "exhaustive — the oracle (slow)" },
};

function qfFromControls(): QF {
  switch (taskControls.qf) {
    case "standard":
      return standard(taskControls.qfA);
    case "wracc":
      return wracc();
    case "simpleBinomial":
      return simpleBinomial();
    case "lift":
      return lift();
    case "chiSquared":
      return chiSquared({ direction: taskControls.chiDirection });
    case "standardNumeric":
      return standardNumeric(taskControls.qfA, {
        estimator: taskControls.estimator,
        invert: taskControls.invert,
      });
    case "count":
      return count();
    default:
      return area();
  }
}

function rebuildTaskPanel(): void {
  clear(panelTask);
  panelTask.append(el("h2", { text: "4 · Task" }));
  if (!state.table) {
    panelTask.append(el("p", { class: "note", text: "Load a dataset first." }));
    return;
  }
  const kind = state.targetChoice.kind;
  const qfNames = Object.keys(QFS).filter((q) => QFS[q]!.kinds.includes(kind));
  if (!qfNames.includes(taskControls.qf)) taskControls.qf = qfNames[0]!;

  const qfSel = el("select", { "data-testid": "qf-select" });
  for (const q of qfNames)
    qfSel.append(el("option", { value: q, text: QFS[q]!.label, selected: q === taskControls.qf }));

  const aInput = el("input", {
    type: "number",
    step: 0.1,
    min: 0,
    max: 2,
    value: taskControls.qfA,
    "data-testid": "qf-a",
  }) as HTMLInputElement;
  const aRow = el("div", { class: "row" }, el("label", { text: "exponent a" }), aInput);
  const estSel = el("select");
  for (const e of ["sum", "average", "max", "order"] as const) {
    estSel.append(
      el("option", { value: e, text: `estimator: ${e}`, selected: e === taskControls.estimator }),
    );
  }
  const invertCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  invertCb.checked = taskControls.invert;
  const numRow = el(
    "div",
    { class: "row" },
    estSel,
    el("label", { text: "invert (low means)" }),
    invertCb,
  );

  const algoSel = el("select", { "data-testid": "algorithm-select" });
  const refreshAlgos = () => {
    clear(algoSel);
    for (const [name, meta] of Object.entries(ALGORITHMS)) {
      if (meta.kinds && !meta.kinds.includes(kind)) continue;
      if (meta.qfs && !meta.qfs.includes(taskControls.qf)) continue;
      algoSel.append(
        el("option", { value: name, text: meta.label, selected: name === taskControls.algorithm }),
      );
    }
    if (![...algoSel.options].some((o) => o.value === taskControls.algorithm)) {
      taskControls.algorithm = algoSel.options[0]!.value;
      algoSel.value = taskControls.algorithm;
    }
  };
  refreshAlgos();

  const widthInput = el("input", {
    type: "number",
    min: 1,
    max: 500,
    value: taskControls.beamWidth,
  }) as HTMLInputElement;
  const widthRow = el("div", { class: "row" }, el("label", { text: "beam width" }), widthInput);

  const depthInput = el("input", {
    type: "number",
    min: 1,
    max: 5,
    value: taskControls.depth,
    "data-testid": "depth-input",
  }) as HTMLInputElement;
  const kInput = el("input", {
    type: "number",
    min: 1,
    max: 500,
    value: taskControls.k,
    "data-testid": "k-input",
  }) as HTMLInputElement;
  const minQInput = el("input", {
    type: "number",
    step: 0.01,
    value: taskControls.minQuality,
  }) as HTMLInputElement;
  const minSupInput = el("input", {
    type: "number",
    min: 0,
    value: taskControls.minSupportRows,
  }) as HTMLInputElement;

  const backendSel = el("select", { "data-testid": "backend-select" });
  for (const [v, label] of [
    ["auto", "auto — GPU when it helps"],
    ["cpu", "cpu — single thread"],
    ["workers", `cpu + workers (${workerCount()} threads)`],
    ["webgpu", webgpuSupported() ? "webgpu" : "webgpu (unavailable)"],
  ] as const) {
    const opt = el("option", { value: v, text: label, selected: v === taskControls.backend });
    if (v === "webgpu" && !webgpuSupported()) opt.disabled = true;
    backendSel.append(opt);
  }
  const pruningCb = el("input", { type: "checkbox" }) as HTMLInputElement;
  pruningCb.checked = taskControls.pruning;

  const syncVisibility = () => {
    aRow.style.display =
      taskControls.qf === "standard" || taskControls.qf === "standardNumeric" ? "" : "none";
    numRow.style.display = taskControls.qf === "standardNumeric" ? "" : "none";
    widthRow.style.display = taskControls.algorithm === "beamSearch" ? "" : "none";
  };

  qfSel.addEventListener("change", () => {
    taskControls.qf = qfSel.value;
    refreshAlgos();
    syncVisibility();
  });
  aInput.addEventListener("change", () => {
    taskControls.qfA = Number(aInput.value) || 0.5;
  });
  estSel.addEventListener("change", () => {
    taskControls.estimator = estSel.value as typeof taskControls.estimator;
  });
  invertCb.addEventListener("change", () => {
    taskControls.invert = invertCb.checked;
  });
  algoSel.addEventListener("change", () => {
    taskControls.algorithm = algoSel.value;
    syncVisibility();
  });
  widthInput.addEventListener("change", () => {
    taskControls.beamWidth = Math.max(1, Number(widthInput.value) || 20);
  });
  depthInput.addEventListener("change", () => {
    taskControls.depth = Math.max(1, Math.min(5, Number(depthInput.value) || 2));
    refreshCountHook?.();
  });
  kInput.addEventListener("change", () => {
    taskControls.k = Math.max(1, Number(kInput.value) || 20);
  });
  minQInput.addEventListener("change", () => {
    taskControls.minQuality = Number(minQInput.value) || 0;
  });
  minSupInput.addEventListener("change", () => {
    taskControls.minSupportRows = Math.max(0, Number(minSupInput.value) || 0);
  });
  backendSel.addEventListener("change", () => {
    taskControls.backend = backendSel.value as typeof taskControls.backend;
  });
  pruningCb.addEventListener("change", () => {
    taskControls.pruning = pruningCb.checked;
  });

  panelTask.append(
    el("div", { class: "row" }, el("label", { text: "Quality fn" }), qfSel),
    aRow,
    numRow,
    el("div", { class: "row" }, el("label", { text: "Algorithm" }), algoSel),
    widthRow,
    el(
      "div",
      { class: "row" },
      el("label", { text: "Depth" }),
      depthInput,
      el("label", { text: "top k" }),
      kInput,
    ),
    el(
      "div",
      { class: "row" },
      el("label", { text: "min quality" }),
      minQInput,
      el("label", { text: "min support" }),
      minSupInput,
    ),
    el("div", { class: "row" }, el("label", { text: "Backend" }), backendSel),
    el(
      "div",
      { class: "row" },
      el("label", { text: "pruning" }),
      pruningCb,
      el("span", { class: "pill", text: "off = audit mode (identical results, slower)" }),
    ),
  );
  syncVisibility();
}

function workerCount(): number {
  return Math.max(2, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
}

// ---------------------------------------------------------------------------
// 5 · Run panel (progress + abort + HUD)

const runButton = el("button", {
  class: "primary",
  "data-testid": "run-button",
  disabled: true,
  text: "Run search",
});
const abortButton = el("button", { class: "danger", disabled: true, text: "Abort" });
const progressBar = el("progress", { max: 1, value: 0 }) as HTMLProgressElement;
const progressText = el("p", { class: "note", "data-testid": "progress-text", text: "idle" });
const runError = el("p", { class: "error" });
const hud = el("div", { class: "hud", "data-testid": "hud" });

panelRun.append(
  el("div", { class: "row" }, runButton, abortButton),
  progressBar,
  progressText,
  runError,
  hud,
);

function hudCell(key: string, value: string, testid?: string): HTMLElement {
  return el(
    "div",
    { class: "cell" },
    el("div", { class: "k", text: key }),
    el("div", { class: "v", text: value, ...(testid ? { "data-testid": testid } : {}) }),
  );
}

runButton.addEventListener("click", () => {
  void runSearch();
});
abortButton.addEventListener("click", () => {
  state.controller?.abort();
});

async function runSearch(): Promise<void> {
  const table = state.table;
  if (!table || state.controller) return;
  runError.textContent = "";
  clear(hud);
  let space: ReturnType<typeof buildSpace>;
  try {
    space = buildSpace();
  } catch (e) {
    runError.textContent = String(e);
    return;
  }
  const totalCandidates = candidateSpaceSize(space.length, taskControls.depth);
  const controller = new AbortController();
  state.controller = controller;
  runButton.disabled = true;
  abortButton.disabled = false;

  const startedAt = performance.now();
  const progressState = { last: null as SearchProgress | null };
  const onProgress = (p: SearchProgress) => {
    progressState.last = p;
    const elapsed = (performance.now() - startedAt) / 1000;
    progressBar.value = Math.min(1, p.candidatesEvaluated / Math.max(1, totalCandidates));
    const prunedPct = totalCandidates > 0 ? (100 * p.candidatesPruned) / totalCandidates : 0;
    progressText.textContent =
      `layer ${p.layer} · ${p.candidatesEvaluated.toLocaleString("en-US")} evaluated` +
      ` · ${Math.round(p.candidatesEvaluated / Math.max(0.001, elapsed)).toLocaleString("en-US")} cand/s` +
      ` · ${prunedPct.toFixed(1)}% pruned · best ${Number.isFinite(p.bestQuality) ? fmt(p.bestQuality) : "—"}` +
      (p.bestDescription ? ` (${p.bestDescription})` : "");
  };

  const task: SubgroupTask = {
    table,
    target: targetFromChoice(state.targetChoice),
    searchSpace: space,
    qf: qfFromControls(),
    resultSetSize: taskControls.k,
    depth: taskControls.depth,
    minQuality: taskControls.minQuality,
    constraints: taskControls.minSupportRows > 0 ? [minSupport(taskControls.minSupportRows)] : [],
    onProgress,
    signal: controller.signal,
  };
  const options: SearchOptions = {
    pruning: taskControls.pruning,
    backend: taskControls.backend === "workers" ? "cpu" : taskControls.backend,
    workers:
      taskControls.backend === "workers"
        ? { count: workerCount(), script: workerScriptUrl }
        : undefined,
  };

  try {
    let results: SubgroupResults;
    switch (taskControls.algorithm) {
      case "apriori":
        results = await apriori(task, options);
        break;
      case "dfs":
        results = await dfs(task, options);
        break;
      case "bestFirst":
        results = await bestFirst(task, options);
        break;
      case "beamSearch":
        results = await beamSearch(task, { ...options, width: taskControls.beamWidth });
        break;
      case "dfsNumeric":
        results = await dfsNumeric(task, options);
        break;
      case "patternTree":
        results = await patternTree(task, options);
        break;
      case "generalizingBFS":
        results = await generalizingBFS(task, options);
        break;
      default:
        results = await exhaustive(task);
        break;
    }
    const wallMs = performance.now() - startedAt;
    state.results = results;
    state.selected = results.entries.length > 0 ? 0 : -1;
    applyFilters();
    progressBar.value = 1;
    progressText.textContent = `done: ${results.entries.length} subgroups · ${results.candidatesEvaluated.toLocaleString("en-US")} candidates evaluated in ${fmtMs(wallMs)}`;
    renderHud(results, wallMs, space.length);
  } catch (e) {
    const aborted = e instanceof Error && e.name === "AbortedError";
    runError.textContent = aborted ? "aborted" : String(e);
    progressText.textContent = aborted
      ? `aborted after ${progressState.last?.candidatesEvaluated.toLocaleString("en-US") ?? 0} candidates`
      : "failed";
  } finally {
    state.controller = null;
    runButton.disabled = false;
    abortButton.disabled = true;
  }
}

function renderHud(results: SubgroupResults, wallMs: number, nSel: number): void {
  clear(hud);
  const b = results.backend;
  hud.append(
    hudCell("backend", b ? b.name : "cpu (oracle)", "hud-backend"),
    hudCell("search time", fmtMs(wallMs), "hud-time"),
    hudCell("evaluated", results.candidatesEvaluated.toLocaleString("en-US")),
    hudCell("pruned", results.candidatesPruned.toLocaleString("en-US")),
    hudCell("selectors", String(nSel)),
    hudCell(
      "cand/s",
      Math.round(results.candidatesEvaluated / Math.max(0.001, wallMs / 1000)).toLocaleString(
        "en-US",
      ),
    ),
  );
  if (b?.band)
    hud.append(hudCell("§12 band", `screened ${b.band.screened} · rescored ${b.band.rescored}`));
  if (b?.note) hud.append(hudCell("note", b.note));
}

// ---------------------------------------------------------------------------
// Results panel: filters, sortable table, export

const filterControls = { minQuality: "", minSize: "", overlap: "", unique: false };

function applyFilters(): void {
  const base = state.results;
  if (!base) {
    state.filtered = null;
    renderResults();
    renderPlots();
    renderDetail();
    return;
  }
  let r = base;
  const table = state.table!;
  const minQ = Number(filterControls.minQuality);
  if (filterControls.minQuality !== "" && Number.isFinite(minQ)) r = minimumQualityFilter(r, minQ);
  const minSize = Number(filterControls.minSize);
  if (filterControls.minSize !== "" && Number.isFinite(minSize) && minSize > 0) {
    r = minimumStatisticFilter(r, "size_sg", minSize);
  }
  if (filterControls.unique) r = uniqueAttributes(r, table);
  const overlap = Number(filterControls.overlap);
  if (filterControls.overlap !== "" && Number.isFinite(overlap) && overlap > 0 && overlap < 1) {
    r = overlapFilter(r, { similarity: overlap });
  }
  state.filtered = r;
  if (state.selected >= r.entries.length) state.selected = r.entries.length > 0 ? 0 : -1;
  renderResults();
  renderPlots();
  renderDetail();
}

function renderResults(): void {
  clear(panelResults);
  panelResults.append(el("h2", { text: "Results" }));
  const r = state.filtered;
  if (!state.table || !r) {
    panelResults.append(el("p", { class: "note", text: "Run a search to see subgroups here." }));
    return;
  }
  const base = state.results!;
  const kind = state.targetChoice.kind;

  // Filter toolbar
  const minQIn = el("input", {
    type: "number",
    step: 0.01,
    placeholder: "min quality",
    value: filterControls.minQuality,
  }) as HTMLInputElement;
  const minSizeIn = el("input", {
    type: "number",
    min: 0,
    placeholder: "min size",
    value: filterControls.minSize,
  }) as HTMLInputElement;
  const overlapIn = el("input", {
    type: "number",
    step: 0.05,
    min: 0,
    max: 1,
    placeholder: "max overlap",
    value: filterControls.overlap,
    title: "greedy Jaccard-overlap filter: drop subgroups more similar than this to a kept one",
  }) as HTMLInputElement;
  const uniqueCb = el("input", {
    type: "checkbox",
    title: "keep the best subgroup per attribute set",
  }) as HTMLInputElement;
  uniqueCb.checked = filterControls.unique;
  const applyBtn = el("button", { text: "Apply filters" });
  const resetBtn = el("button", { text: "Reset" });
  applyBtn.addEventListener("click", () => {
    filterControls.minQuality = minQIn.value;
    filterControls.minSize = minSizeIn.value;
    filterControls.overlap = overlapIn.value;
    filterControls.unique = uniqueCb.checked;
    applyFilters();
  });
  resetBtn.addEventListener("click", () => {
    filterControls.minQuality = "";
    filterControls.minSize = "";
    filterControls.overlap = "";
    filterControls.unique = false;
    applyFilters();
  });
  const exportJson = el("button", { text: "Export JSON" });
  exportJson.addEventListener("click", () => {
    download("subgroups.json", serializeResults(r), "application/json");
  });
  const exportCsv = el("button", { text: "Export CSV" });
  exportCsv.addEventListener("click", () => {
    download("subgroups.csv", r.toCSV(), "text/csv");
  });

  panelResults.append(
    el(
      "div",
      { class: "row" },
      minQIn,
      minSizeIn,
      overlapIn,
      el("label", { text: "unique attrs" }),
      uniqueCb,
      applyBtn,
      resetBtn,
      el("span", { class: "spacer" }),
      exportJson,
      exportCsv,
    ),
    el("p", {
      class: "note",
      text: `showing ${r.entries.length} of ${base.entries.length} subgroups`,
    }),
  );

  // Sortable table
  const N = state.table.nRows;
  type Row = { i: number; desc: string; quality: number; size: number; stat: number; lift: number };
  const rows: Row[] = r.entries.map((e, i) => ({
    i,
    desc: e.description.toString(),
    quality: e.quality,
    size: e.stats.size_sg ?? Number.NaN,
    stat:
      kind === "binary"
        ? (e.stats.target_share_sg ?? Number.NaN)
        : kind === "numeric"
          ? (e.stats.mean_sg ?? Number.NaN)
          : (e.stats.size_sg ?? Number.NaN),
    lift: kind === "binary" ? (e.stats.lift ?? Number.NaN) : (e.stats.mean_lift ?? Number.NaN),
  }));
  const { key, dir } = state.sort;
  if (key !== "rank") {
    rows.sort((a, b) => {
      const av = a[key as keyof Row] as number | string;
      const bv = b[key as keyof Row] as number | string;
      const cmp =
        typeof av === "string" ? av.localeCompare(String(bv)) : (av as number) - (bv as number);
      return dir * (Number.isNaN(cmp as number) ? 0 : (cmp as number));
    });
  }

  const statHeader = kind === "binary" ? "target share" : kind === "numeric" ? "mean" : "size";
  const marker =
    kind === "binary" ? (r.entries[0]?.stats.target_share_dataset ?? Number.NaN) : Number.NaN;
  const datasetMean =
    kind === "numeric" ? (r.entries[0]?.stats.mean_dataset ?? Number.NaN) : Number.NaN;
  const statMax = kind === "numeric" ? Math.max(...rows.map((x) => x.stat), datasetMean) || 1 : 1;

  const thead = el("thead", {}, el("tr", {}));
  const headRow = thead.firstChild as HTMLElement;
  const columns: [string, string][] = [
    ["rank", "#"],
    ["desc", "subgroup"],
    ["quality", "quality"],
    ["size", "size"],
    ["stat", statHeader],
    ["lift", "lift"],
  ];
  for (const [k2, label] of columns) {
    const th = el("th", {
      text: label + (state.sort.key === k2 ? (state.sort.dir > 0 ? " ↑" : " ↓") : ""),
    });
    th.addEventListener("click", () => {
      state.sort =
        state.sort.key === k2
          ? { key: k2, dir: -state.sort.dir }
          : { key: k2, dir: k2 === "desc" ? 1 : -1 };
      renderResults();
    });
    headRow.append(th);
  }

  const tbody = el("tbody", {});
  rows.forEach((row, displayIdx) => {
    const tr = el(
      "tr",
      { class: row.i === state.selected ? "selected" : "", "data-testid": "result-row" },
      el("td", { text: String(displayIdx + 1) }),
      el("td", { class: "desc mono", text: row.desc }),
      el("td", { text: fmt(row.quality) }),
      el("td", {}, el("span", { class: "mono", text: `${fmt(row.size)} ` }), bar(row.size / N)),
      el(
        "td",
        {},
        el("span", { class: "mono", text: `${fmt(row.stat)} ` }),
        kind === "binary"
          ? bar(row.stat, marker, "share")
          : kind === "numeric"
            ? bar(row.stat / statMax, datasetMean / statMax, "share")
            : bar(row.stat / N),
      ),
      el("td", { text: Number.isNaN(row.lift) ? "—" : fmt(row.lift) }),
    );
    tr.addEventListener("click", () => {
      state.selected = row.i;
      renderResults();
      renderPlots();
      renderDetail();
    });
    tbody.append(tr);
  });

  panelResults.append(
    el(
      "div",
      { class: "tablewrap" },
      el("table", { class: "results", "data-testid": "results-table" }, thead, tbody),
    ),
  );
}

// ---------------------------------------------------------------------------
// Plots panel (ROC + sgbars)

function renderPlots(): void {
  clear(panelPlots);
  panelPlots.append(el("h2", { text: "Views" }));
  const r = state.filtered;
  if (!r || r.entries.length === 0 || !state.table) {
    panelPlots.append(
      el("p", {
        class: "note",
        text: "Views appear after a run (ROC space for binary targets; subgroup bars for all).",
      }),
    );
    return;
  }
  const kind = state.targetChoice.kind;
  const wrap = el("div", { class: "plots" });
  panelPlots.append(wrap);

  if (kind === "binary") {
    const rocCanvas = el("canvas", {
      class: "plot",
      "data-testid": "roc-canvas",
    }) as HTMLCanvasElement;
    const rocBox = el(
      "div",
      {},
      el("p", {
        class: "note",
        text: "ROC space (reference plot_roc): ↑ true-positive rate vs → false-positive rate",
      }),
      rocCanvas,
    );
    wrap.append(rocBox);
    requestAnimationFrame(() => {
      const hit = drawRoc(rocCanvas, rocPoints(r), state.selected);
      rocCanvas.onclick = (ev) => {
        const rect = rocCanvas.getBoundingClientRect();
        const i = hit(ev.clientX - rect.left, ev.clientY - rect.top);
        if (i >= 0) {
          state.selected = i;
          renderResults();
          renderPlots();
          renderDetail();
        }
      };
    });
  }

  const barsCanvas = el("canvas", {
    class: "plot",
    "data-testid": "sgbars-canvas",
  }) as HTMLCanvasElement;
  const top = r.entries.slice(0, 15);
  const barsBox = el(
    "div",
    {},
    el("p", { class: "note", text: `subgroup bars (reference plot_sgbars) — top ${top.length}` }),
    barsCanvas,
  );
  wrap.append(barsBox);
  const N = state.table.nRows;
  const bars = [
    kind === "binary"
      ? { label: "Dataset", relSize: 1, share: top[0]?.stats.target_share_dataset ?? Number.NaN }
      : { label: "Dataset", relSize: 1, share: Number.NaN },
    ...top.map((e) => ({
      label: e.description.toString(),
      relSize: (e.stats.size_sg ?? 0) / N,
      share: kind === "binary" ? (e.stats.target_share_sg ?? Number.NaN) : Number.NaN,
    })),
  ];
  requestAnimationFrame(() => {
    const hit = drawSgBars(barsCanvas, bars, state.selected + 1);
    barsCanvas.onclick = (ev) => {
      const rect = barsCanvas.getBoundingClientRect();
      const i = hit(ev.clientX - rect.left, ev.clientY - rect.top);
      if (i >= 1) {
        state.selected = i - 1;
        renderResults();
        renderPlots();
        renderDetail();
      }
    };
  });
}

// ---------------------------------------------------------------------------
// Detail panel

function renderDetail(): void {
  clear(panelDetail);
  panelDetail.append(el("h2", { text: "Subgroup detail" }));
  const r = state.filtered;
  const table = state.table;
  if (!r || !table || state.selected < 0 || state.selected >= r.entries.length) {
    panelDetail.append(
      el("p", { class: "note", text: "Select a subgroup in the table or a plot." }),
    );
    return;
  }
  const entry = r.entries[state.selected]!;
  panelDetail.append(
    el("p", {
      class: "mono",
      "data-testid": "detail-desc",
      text: `${entry.description.toString()} · quality ${fmt(entry.quality)}`,
    }),
  );

  const grid = el("div", { class: "detail-grid" });
  panelDetail.append(grid);

  // Stats table
  const statsTable = el("table", { class: "preview" });
  for (const [k, v] of Object.entries(entry.stats)) {
    statsTable.append(
      el("tr", {}, el("th", { text: k }), el("td", { class: "mono", text: fmt(v) })),
    );
  }
  grid.append(el("div", { class: "previewwrap" }, statsTable));

  const rightBox = el("div", {});
  grid.append(rightBox);

  const kind = state.targetChoice.kind;
  const canvas = el("canvas", { class: "plot" }) as HTMLCanvasElement;
  rightBox.append(canvas);
  const cover = entry.cover();
  const inCover = new Uint8Array(table.nRows);
  for (const i of cover) inCover[i] = 1;

  requestAnimationFrame(() => {
    if (kind === "binary") {
      const s = entry.stats;
      drawShareComparison(canvas, [
        { label: "subgroup", share: s.target_share_sg ?? Number.NaN, size: s.size_sg ?? 0 },
        {
          label: "complement",
          share: s.target_share_complement ?? Number.NaN,
          size: (s.size_dataset ?? 0) - (s.size_sg ?? 0),
        },
        {
          label: "dataset",
          share: s.target_share_dataset ?? Number.NaN,
          size: s.size_dataset ?? 0,
        },
      ]);
    } else if (kind === "numeric" && state.targetChoice.attribute) {
      const col = table.column(state.targetChoice.attribute);
      if (col.kind === "numeric") {
        const sg: number[] = [];
        const comp: number[] = [];
        for (let i = 0; i < table.nRows; i++) {
          const v = col.values[i]!;
          if (Number.isNaN(v)) continue;
          (inCover[i] ? sg : comp).push(v);
        }
        drawHistogram(canvas, sg, comp);
      }
    } else {
      drawShareComparison(canvas, [
        {
          label: "itemset",
          share: (entry.stats.size_sg ?? 0) / table.nRows,
          size: entry.stats.size_sg ?? 0,
        },
        { label: "dataset", share: 1, size: table.nRows },
      ]);
    }
  });

  // Covered-row preview
  const previewN = Math.min(10, cover.length);
  const prev = el("table", { class: "preview" });
  const head = el("tr", {}, el("th", { text: "row" }));
  for (const n of table.names) head.append(el("th", { text: n }));
  prev.append(head);
  for (let j = 0; j < previewN; j++) {
    const rowIdx = cover[j]!;
    const tr = el("tr", {}, el("td", { class: "mono", text: String(rowIdx) }));
    for (const n of table.names) {
      const v = table.value(n, rowIdx);
      tr.append(el("td", { text: v === undefined ? "NA" : String(v) }));
    }
    prev.append(tr);
  }
  rightBox.append(
    el("p", {
      class: "note",
      text: `covered rows (${cover.length.toLocaleString("en-US")} total, first ${previewN} shown)`,
    }),
    el("div", { class: "previewwrap" }, prev),
  );
}

// ---------------------------------------------------------------------------

renderResults();
renderPlots();
renderDetail();
rebuildTargetPanel();
rebuildSpacePanel();
rebuildTaskPanel();
