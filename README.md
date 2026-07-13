# subgroup-web

Privacy-preserving **subgroup discovery and exceptional model mining** for web
browsers and Node.js — a stand-alone, spec-first TypeScript implementation of
the complete [pysubgroup](https://github.com/flemmerich/pysubgroup) 0.9.0
feature set, with bitset kernels, worker parallelism, and WebGPU acceleration.
Your data never leaves your device.

Subgroup discovery finds interpretable descriptions (`Sex=='female' AND
Pclass==1`) of data regions where a target behaves unusually — a survival
rate, a mean, an itemset frequency, a regression model. subgroup-web brings
the reference Python library's capability to the browser for zero-upload data
analysis: faster, memory-lean, and provably exact where the algorithm class
allows it.

- **Zero runtime dependencies**, ESM-only, TypeScript strict, Node ≥ 20.
- **Exact algorithms are provably exact** against a shipped exhaustive oracle,
  with pruning-on/off identity gates; heuristics are fully specified and
  deterministic ([docs/spec.md](docs/spec.md)).
- **Bit-identical across backends**: single-thread CPU, CPU worker pool, and
  WebGPU return the same ranked results down to the last bit (see
  [docs/design.md](docs/design.md) for the §12 GPU exactness band).
- **Differentially tested** against pinned `pysubgroup==0.9.0`; every
  intentional divergence is adjudicated in `COMPATIBILITY.md` with a runnable
  repro (`reference/repros/`); gate results live in `PARITY.md`.

## Install

```sh
npm install subgroup-web        # or pnpm add / yarn add
```

## 30 seconds

```ts
import { allSelectors, apriori, binary, fromCSV, standard } from "subgroup-web";

const table = fromCSV(await (await fetch("titanic.csv")).text());
const results = await apriori({
  table,
  target: binary({ attribute: "Survived", value: 1 }),
  searchSpace: allSelectors(table, { ignore: ["Survived"], bins: 5 }),
  qf: standard(0.5),
  resultSetSize: 10,
  depth: 2,
});
for (const e of results.entries) {
  console.log(e.quality.toFixed(4), e.description.toString(), e.stats.target_share_sg);
}
// 0.2206 Sex=='female' 0.714…
```

WebGPU (browser or Node ≥ 24 with a GPU): register once, then request it per
search — statistics are computed on the GPU, ranked centrally in f64, and
boundary decisions are re-scored exactly on the CPU, so results stay
bit-identical.

```ts
import { registerWebGpu } from "subgroup-web/webgpu";
registerWebGpu();
const results = await apriori(task, { backend: "webgpu" }); // or "auto"
```

CPU worker pool (Node or browser; browsers pass a bundled worker URL):

```ts
const results = await apriori(task, { workers: true });
```

## Targets and quality functions

| target | quality functions |
|---|---|
| `binary({attribute, value})` | `standard(a)` (`wracc` = a·1, `simpleBinomial` = a·0.5, `lift` = a·0), `chiSquared({stat, direction})`, `generalizationAware(qf)`, `gaStandard(a)` |
| `numeric(attribute)` | `standardNumeric(a, {estimator: "sum"\|"average"\|"max"\|"order", invert})`, `standardNumericMedian(a)`, `standardNumericTscore()`, `gaStandardNumeric(a)` |
| `frequentItemset()` | `count()`, `area(maxDepth?)` |
| `emm(polyRegression(x, y, degree))` | `emmLikelihood()` |
| any | `combined([{qf, weight}, …])` |

All statistic tables of the reference (13-field binary, 14-field numeric) are
computed per subgroup; `describeStats` evaluates them for arbitrary
descriptions.

## Algorithms and exactness classes

| algorithm | class | notes |
|---|---|---|
| `exhaustive` | oracle | full enumeration, dual cross-checked statistics paths |
| `apriori` | exact | level-wise, optimistic-estimate + monotone-constraint pruning |
| `dfs` | exact | depth-first with pruning |
| `bestFirst` | exact | estimate-ordered expansion |
| `dfsNumeric` | exact | target-sorted prefix scoring; restricted to `standardNumeric` (typed error otherwise) |
| `patternTree` | exact | FP-growth-style with mergeable integer statistics; binary/FI targets |
| `generalizingBFS` | exact | searches the *disjunction* space D(S,d) |
| `beamSearch` | heuristic | fully determinized (width, tie handling, dedup pinned in the spec) |

Determinism guarantees: a canonical total order over selectors and
descriptions defines tie-breaking everywhere; results are reproducible
run-to-run, backend-to-backend, and machine-to-machine. Exact algorithms are
gated to equal the oracle's top-k exactly — including with pruning disabled —
across a fixture matrix of targets × QFs × NA/tie/negation stress cells.

## Backend and environment support

| environment | cpu | cpu + workers | webgpu |
|---|---|---|---|
| Node ≥ 20 | ✓ | ✓ (`node:worker_threads`, SharedArrayBuffer) | via injected `GPUDevice` (e.g. Dawn) |
| Chromium-family browsers | ✓ | ✓ (SAB when `crossOriginIsolated`, transferred copies otherwise — e.g. GitHub Pages) | ✓ |
| Safari / Firefox | ✓ | ✓ (copy regime) | where `navigator.gpu` ships |

GPU applicability is static per task: binary/FI counting is integer-exact on
the GPU; numeric sum-family statistics are f32-screened with derived error
bounds and re-scored on CPU f64 at admission (never a final decision); EMM
and order/median statistics stay on the CPU. Everything falls back to CPU
with a note in `results.backend`.

## Performance

Measured by `pnpm bench:gates` (regenerated into [BENCHMARKS.md](BENCHMARKS.md);
Apple M5 Pro, 18 cores, Metal 3, Chromium 149 vs pysubgroup 0.9.0 on the same
machine):

| task | subgroup-web | reference | speedup |
|---|---|---|---|
| adult (48842×15), apriori, standard(0.5), depth 3, k=100 | **0.017 s** (workers) | 0.316 s | **18.8×** |
| synthetic 2M×256 selectors, binary, apriori depth 2 | 0.609 s CPU pool / **0.095 s** WebGPU | — | GPU 6.4× over CPU pool |
| synthetic 2M numeric, standardNumeric(1, sum), beam(50), depth 3 | 1.722 s CPU pool / **0.936 s** WebGPU | — | — |

Memory stays O(atlas + batch): the 2M-row search above allocates 64 MB of
selector bitsets (98.8 % of search allocations) and never materializes
per-candidate covers.

## Correctness methodology

Spec-first: [docs/spec.md](docs/spec.md) pins every semantic (NA policy,
interval bounds, canonical order, QF formulas, algorithm contracts) with
citations into the reference source. The implementation is then gated three
ways: exactness against the exhaustive oracle, property/metamorphic suites,
and differential comparison against pinned pysubgroup 0.9.0 — divergences
fail the build unless adjudicated with a committed repro. See
[PARITY.md](PARITY.md) (gate rows), [COMPATIBILITY.md](COMPATIBILITY.md)
(adjudication ledger), and [docs/design.md](docs/design.md) (architecture and
the GPU exactness band).

## Demo

A full explorer (dataset picker, CSV upload — parsed locally, target/QF
builders, live progress, sortable results, ROC-space and subgroup-bars views,
export, backend toggle) ships in [`demo/`](https://github.com/jeyabbalas/subgroup-web/tree/main/demo) and deploys to GitHub Pages:
<https://jeyabbalas.github.io/subgroup-web/> (API docs under `/api`).

```sh
pnpm demo:dev      # local dev (COOP/COEP on, SAB workers exercised)
pnpm demo:build    # Pages build (BASE_PATH=/subgroup-web/)
pnpm demo:preview  # serve the build exactly like Pages (no COOP/COEP)
```

## Development

```sh
pnpm install          # toolchain
pnpm gate:quick       # inner-loop checks
pnpm gate             # the full acceptance pipeline (tests, browser gates, benchmarks)
pnpm fixtures         # regenerate reference datasets + differential fixtures (uv)
```

The `reference/` directory pins the Python reference via
[uv](https://docs.astral.sh/uv/); `uv run python -c "from importlib.metadata
import version; print(version('pysubgroup'))"` prints `0.9.0`.

## Roadmap

Instance weights (excluded from parity scope, spec §2), a WASM SIMD
evaluator between CPU and WebGPU, Roaring-style compressed bitmaps for sparse
selectors, tighter numeric optimistic estimates (KDD-style bounds) with
measured node reduction, and adopting the tight generalization bound
((n+P−p)/N)^a·(P/(n+P−p)−P/N) for generalizingBFS (spec §6.1 currently ships
a looser admissible closed form).

## License

Apache-2.0 (see `LICENSE`, `NOTICE`). subgroup-web is an independent
implementation; semantics were developed against pysubgroup 0.9.0 (Apache-2.0,
© Florian Lemmerich and contributors). Academic users should cite:
Lemmerich & Becker, *pysubgroup: Easy-to-Use Subgroup Discovery in Python*,
ECML-PKDD 2018.
