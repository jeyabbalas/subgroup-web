# subgroup-web — Build Brief

**Audience:** Claude Code (Claude Fable 5) running a long-horizon autonomous session under an active `/goal`.
**Workspace:** this directory is the repository root. **Package name:** `subgroup-web`. **Target version:** `0.1.0`.

---

## 0. How to use this document

- This brief is the project constitution. The `/goal` condition references it; §19 acceptance criteria and the gates in §6 and §8 define "done."
- **Source-of-truth hierarchy — note this differs from a faithful-port project:**
  1. **The executable specification** (§6.1): the mathematical definitions in `docs/spec.md`, the exhaustive-enumeration oracle, hand-computed micro-fixtures, planted-ground-truth datasets, and the property/metamorphic suites. This is normative for *what the correct answer is*.
  2. This brief: normative for scope, engineering constraints, and gates.
  3. The pinned reference implementation `pysubgroup==0.9.0` (installed under `reference/.venv/` — read its source directly): normative for *intended semantics and API coverage*, but it is a self-described prototype-phase library and **may be wrong**. Where reference behavior conflicts with the spec, the spec wins and the divergence is adjudicated per §6.3. Never silently copy a reference behavior you cannot justify from the spec.
- You are explicitly licensed to redesign algorithms and data structures for correctness, memory, and speed. The contract is on *results and semantics*, never on internal structure.
- At the start of each milestone, re-read that milestone's §19 entry plus every section it references. Do not work from memory of this file.

## 1. Mission

Build **subgroup-web**: a stand-alone, production-grade TypeScript library providing the complete functionality of `pysubgroup` 0.9.0 — subgroup discovery and exceptional model mining over tabular data: selector spaces, conjunctive (and disjunctive) descriptions, binary / numeric / frequent-itemset / model targets, the full quality-function set with optimistic estimates, exhaustive and heuristic search algorithms, constraints, result statistics, and result filtering.

- **Primary target:** web browsers, for privacy-preserving in-browser data analysis — the user's data never leaves their device. **Also supported:** Node.js ≥ 20.
- **Zero runtime dependencies**, ESM-only, TypeScript strict.
- **Memory-efficient by design** (bitset-based vertical layout, streaming candidate batches) and **WebGPU-accelerated** where it wins, with a clean CPU fallback.
- **Better than the original where the original is wrong or slow.** Exact algorithms must be provably exact; performance should embarrass the reference (§8). Deviations are deliberate, documented, and adjudicated — never accidental.

## 2. Non-goals (do not build)

- `pysubgroup.visualization` (matplotlib module). The demo app (§15) replaces it, including ROC-space and subgroup-bars views.
- pandas emulation. Data enters through the §5.1 table model; pandas-specific quirks are mapped, not reproduced.
- Instance weighting (`weighting_attribute`, effective-sample-size code paths). It is vestigial/partial in the reference; verify in M2, exclude from v1 unless trivially sound, and record the decision. Document as roadmap.
- A WASM backend (backend interface must remain pluggable), npm publishing, Windows/Linux GPU debugging (capability detection + CPU fallback only; acceptance GPU is Chromium on this Apple Silicon machine).

## 3. Normative references

- **Reference implementation:** `reference/` pins `pysubgroup==0.9.0` (PyPI, Apache-2.0) with `pandas`/`numpy`/`scipy` resolved in `uv.lock`. Read the installed source; do not rely on memory of it.
- **Literature (for the spec):** Lemmerich & Becker, *pysubgroup* (ECML-PKDD 2018); Atzmüller, *Subgroup Discovery* (WIREs DMKD 2015); Lemmerich, Atzmüller & Puppe, *Fast subgroup discovery for continuous target concepts* / Lemmerich's dissertation (tight optimistic estimates, numeric targets); Klösgen's Explora measures; Han et al. FP-growth (for the pattern-tree engine).
- Docs site (sparse; source wins): https://pysubgroup.readthedocs.io

## 4. Deliverables

1. `subgroup-web` npm package (ESM, zero runtime deps, full types).
2. `docs/spec.md` — the executable mathematical specification (§6.1), with citations.
3. `reference/` harness: pinned env, dataset exporters, differential-fixture and reference-timing generators (§14).
4. Test suites and one `pnpm gate` command (§16.3).
5. `PARITY.md` (gate report) and `COMPATIBILITY.md` (adjudicated divergence ledger, §6.3) — both generated.
6. `BENCHMARKS.md` incl. measured speedups vs the reference (§8).
7. Demo app deployable to GitHub Pages + `.github/workflows/pages.yml` (§15).
8. TypeDoc API reference deployed with the demo under `/api`; `README.md`; `LICENSE` (Apache-2.0) + `NOTICE` (§18).
9. Maintained `STATUS.md` / `DECISIONS.md`; git tags `m0`…`m7` (§20).

## 5. Public API contract

Design exact signatures yourself; the following is binding as to capability and semantics, indicative as to shape. Everything long-running is **async**, chunked (UI-responsive), abortable via `AbortSignal`, and reports progress (`onProgress`: layer/depth, candidates evaluated, pruned counts, best-so-far).

### 5.1 Data model

Column-oriented `DataTable`:

```ts
type Column =
  | { kind: 'categorical'; codes: Int32Array; categories: (string | number | boolean)[] } // code -1 = NA
  | { kind: 'numeric'; values: Float64Array }                                             // NaN = NA
  | { kind: 'boolean'; values: Uint8Array; na: Uint8Array | null };
```

Constructors: `fromColumns`, `fromRows`, and `fromCSV` (strict RFC-4180 subset, type inference with per-column overrides; zero-dep, part of the library — in-browser analysis needs it). **NA policy (spec-level):** NA satisfies no selector (equality, interval, or negation) — matching the reference's effective pandas behavior; verify against the reference in M1 and adjudicate any mismatch.

### 5.2 Descriptions and selector spaces

- Selectors: `equality(attr, value)`, `interval(attr, lo, hi)` (bound convention taken from the reference source — expected left-closed/right-open with ±∞ allowed; pin it in the spec in M1), `negated(selector)`.
- `Conjunction`, `Disjunction`, `DNF` — evaluable and stat-computable like the reference's `subgroup_description` module; **search** operates over conjunctions.
- Space builders mirroring `create_selectors` / `create_nominal_selectors` / `create_numeric_selectors`: `allSelectors(table, { ignore })`, `nominalSelectors(...)`, `numericSelectors(table, { bins: 5, method: 'equalFrequency' | 'equalWidth' | number[], intervalsOnly: true })`, plus `removeTargetAttributes`. Equal-frequency edge behavior (duplicate quantiles collapsing bins) is spec'd from the reference and adjudicated.
- **Canonical form:** selectors have a total order (attribute, kind, operands); conjunctions are stored sorted and deduplicated; the candidate space of a task is *precisely defined in the spec* (combinations of ≤ `depth` distinct selectors, with the same-attribute-combination rule pinned to whatever the reference's algorithms consistently do — if the reference's own algorithms disagree with each other here, that is a reference inconsistency: adjudicate, pick the spec rule, document).

### 5.3 Targets and quality functions (complete coverage of the reference)

Targets: `binary({ attribute, value } | selector)`, `numeric(attribute)`, `frequentItemset()`, `emm(polyRegression(xAttr, yAttr, degree = 1))`.

Quality functions (each with `evaluate`, `optimisticEstimate` where the reference or literature defines one, and constant-statistics precomputation):

| reference | subgroup-web |
|---|---|
| `StandardQF(a)` | `standard(a)` — spec: qᵃ(sg) = (n_sg / n)ᵃ · (p_sg − p₀) |
| `WRAccQF` / `LiftQF` / `SimpleBinomialQF` | `wracc()` = standard(1), `lift()` = standard(0), `simpleBinomial()` = standard(0.5) |
| `ChiSquaredQF(direction, min_instances, stat)` | `chiSquared({ direction: 'both'\|'positive'\|'negative', minInstances: 5, stat: 'chi2'\|'pValue' })` |
| `StandardQFNumeric(a, invert, estimator)` | `standardNumeric(a, { invert, estimator: 'sum'\|'average'\|'order' })` |
| `StandardQFNumericMedian` / `Tscore` | `standardNumericMedian(...)`, `standardNumericTscore(...)` |
| `CountQF` / `AreaQF` | `count()`, `area()` |
| `EMM_Likelihood(PolyRegression_ModelClass)` | `emmLikelihood(model)` with mergeable sufficient statistics |
| `GeneralizationAwareQF(_stats)`, `GeneralizationAware_StandardQF` | `generalizationAware(qf)`, `gaStandard(a)` |
| `CombinedInterestingnessMeasure` | `combined([{ qf, weight }])` |

Statistics: the full `statistic_types` sets of both targets (binary: size/positives/coverage/target shares/lift, 13 fields; numeric: mean/std/median/min/max/lifts, 14 fields), computed in f64 and exposed on results. `chiSquared` includes the p-value variant — implement the χ² tail probability yourself (§22-A6) and pin the 2×2 continuity-correction question from the reference's scipy call.

### 5.4 Constraints, algorithms, results

- Constraints: `minSupport(count | fraction)` (monotone), `minQuality`, and custom `{ isSatisfied, isMonotone }`.
- Task: `{ table, target, searchSpace, qf, resultSetSize = 10, depth = 3, minQuality = -Infinity, constraints = [] }`.
- Algorithms (same coverage as the reference; internals may be redesigned): `exhaustive()` (the shipped oracle; also serves as the reference's `SimpleSearch`/`SimpleDFS` role), `apriori()`, `dfs()` (bitset look-ahead), `dfsNumeric()`, `bestFirst()`, `beamSearch({ width = 20, adaptive = false })`, `patternTree()` (exact FP-growth-style engine replacing the reference's experimental `GpGrowth`), `generalizingBFS()`.
- **Exactness classes (binding):** `exhaustive, apriori, dfs, dfsNumeric (within its documented applicability), bestFirst, patternTree, generalizingBFS` are **exact**: they must return the true top-k of the candidate space under the canonical order (§7). `beamSearch` is heuristic but **fully specified**: its expansion, dedup, and tie rules are written in the spec, making it deterministic and testable.
- Result: ordered entries `{ description, quality, stats, optimisticEstimate?, cover(): Uint32Array | indices }`, plus `toRows()`, `toCSV()`, `serialize()/deserialize()`; post-filters mirroring the reference's `measures` helpers: `minimumQualityFilter`, `overlapFilter(similarity)`, `uniqueAttributes`, `minimum/maximumStatisticFilter`.
- subgroup-web-only options: `backend: 'auto' | 'cpu' | 'webgpu'`, `device` (injected `GPUDevice`), `workers`, `onProgress`, `signal`, `logger`.

### 5.5 Errors and validation

Typed errors; actionable messages. Validate: unknown attributes, target attribute leaking into the search space (offer `removeTargetAttributes`), NaN/∞ in numeric targets, empty search spaces, k/depth bounds, selector–column type mismatches.

## 6. Correctness contract

The reference cannot be trusted blind, and "the top subgroup looks plausible" is not evidence. Correctness rests on three layers, built **before** the optimized engines.

### 6.1 Layer 0 — the executable specification (the oracle)

- `docs/spec.md`: every formula, convention (empty-subgroup handling, NA policy, interval bounds, candidate-space definition, canonical order, tie rules), with literature citations. Written in M1–M3, updated only via §21.
- The `exhaustive` engine: an obviously-correct, no-pruning enumerator over the canonical candidate space with **two independent statistics paths** (direct row-scan and bitset) that are cross-checked against each other on every fixture run.
- Hand-computed micro-fixtures: tiny tables (≤ 12 rows) where expected qualities and top-k are worked out by hand in test comments, covering every QF, NA, ties, negation, and each estimator.
- **Planted-ground-truth generators:** synthetic datasets constructed so the best subgroup is known *by construction* (implanted high-WRAcc pockets; implanted mean-shift pockets for numeric targets; controllable noise). Gate: exact algorithms recover the plant at rank 1; generators and their seeds are frozen fixtures.
- Property/metamorphic suites (fast-check as devDependency; seeds logged and replayable): coverage anti-monotonicity; **admissibility** — for every QF exposing an optimistic estimate, sampled refinement chains never exceed their ancestor's estimate; row-permutation invariance; row-duplication scaling laws per QF; negation/complement identities; `standard(0/0.5/1)` ≡ named aliases; stats invariants (shares in [0,1], sizes add up).

### 6.2 Layer 1 — exactness gates (goal-blocking)

Across the full §6.4 matrix, every **exact** algorithm's result must equal the `exhaustive` oracle's top-k **exactly**: identical description sets and order under the canonical total order, qualities within rel 1e-9. Additionally, per algorithm: pruning-disabled vs pruning-enabled runs are identical (proves every optimistic estimate and constraint interaction is sound); constructed tie datasets are included; results are identical across `workers: false`, worker-parallel CPU, and WebGPU backends.

### 6.3 Layer 2 — differential testing vs pysubgroup 0.9.0, with adjudication

Fixtures from the pinned reference (per task: top-k descriptions + qualities + full stats; plus per-subgroup QF values on fixed description lists). Comparison outcomes are classified; **the gate is zero *unadjudicated* divergences, not zero divergences**:

- **(a) subgroup-web bug** → fix it.
- **(b) reference bug or internal inconsistency** → write an adjudication in `COMPATIBILITY.md`: minimal runnable Python repro committed under `reference/repros/`, analysis against the spec, and the spec-correct behavior subgroup-web implements. Issue-report quality.
- **(c) representational difference** (heap tie order, float noise, duplicate handling) → documented mapping rule (e.g., compare as sets with quality-tolerant matching where only tie order differs).

Expected: QF values agree to rel ≤ 1e-9 (both sides are f64) unless adjudicated. `COMPATIBILITY.md` is a first-class deliverable — it is this project's contribution back to the reference's community.

### 6.4 Dataset × config matrix

Datasets: `titanic` and `credit-g` (exported to CSV by reference-loader scripts, committed with SHA-256); `adult` (~48.8k rows, fetched + checksummed); planted-binary and planted-numeric synthetics (several sizes); tie-stress, NA-stress, and duplicate-row synthetics; performance-only: `synth-2M×256sel` (binary + numeric variants).

Configs (exact matrix in `test/matrix.json`, ~24 cells): each QF family × a representative algorithm set; depth ∈ {1,2,3}; k ∈ {1,10,100}; `minSupport` on/off; `minQuality` set; negations on/off; `nbins` ∈ {5, 10}; `intervalsOnly` both; numeric estimators sum/average/order; `invert: true`; chi² both stats and one-directional; FI target with count and area; EMM poly-regression degree 1; GA-standard; combined QF; `dfsNumeric` on its applicable configs; `beamSearch` vs its own spec at width ∈ {1, 20}.

### 6.5 Reports

`pnpm gate` regenerates `PARITY.md` (one row per gate: exactness cells, property suites, cross-backend identity, differential adjudication counts — id, cell, check, value, expected, GATE flag, PASS/FAIL, `N/N gates pass` summary) and appends nothing to `COMPATIBILITY.md` automatically (adjudications are hand-written, machine-verified: every divergence the differential runner finds must reference an adjudication id, else FAIL). Both printed at the end of `pnpm gate`.

## 7. Determinism

Search algorithms contain **no randomness**: given the same task, every algorithm on every backend returns bit-identical result lists on the same machine. This is achieved by the canonical total order — quality desc → shallower depth first → lexicographic canonical description — applied everywhere results or frontiers are ranked (a deliberate, documented improvement over the reference's heap-order artifacts). Randomness exists only in synthetic-data generators and property tests, always seeded (single PCG32; `Math.random` banned in `src/` by lint rule). Floating-point: all decision-relevant statistics in f64 on CPU; GPU f32 partials are never decision-final (§12).

## 8. Performance contract

Measured on this machine (Apple Silicon M5); Chromium via Playwright for GPU. Methodology: 1 warmup + 3 measured runs, median; per-phase breakdown (space build / selector bitsets / per-layer evaluation / ranking); data resident in memory; environment block (chip, OS, Chrome version, adapter info, Node version, reference version, date) recorded in `BENCHMARKS.md`. **Reference timings are measured, not assumed:** `reference/scripts/bench_reference.py` runs the identical tasks with pysubgroup 0.9.0 (its fastest applicable configuration, e.g. bitset representation) via `uv run`, so speedup gates are self-calibrating on this machine.

### 8.1 Hard gates (goal-blocking)

| id | task | backend | gate |
|---|---|---|---|
| P1 | adult, `allSelectors` (nbins 5), binary income>50K, `standard(0.5)`, depth 3, k=100, `apriori` | CPU + workers | total ≤ 10 s **and** ≥ 10× faster than measured reference on the same task |
| P2 | synth-2M×256sel, binary target, depth 2, k=100, `apriori` | CPU + workers / WebGPU | CPU ≤ 60 s; GPU ≤ 8 s; GPU ≥ 5× CPU |
| P3 | synth-2M numeric target, `standardNumeric(1, sum)`, `beamSearch(50)`, depth 3 | CPU + workers / WebGPU | CPU ≤ 180 s; GPU ≤ 30 s |
| P4 | P2 run | — | peak memory documented; selector bitsets ≈ 64 MB dominate; no per-candidate cover storage beyond the active batch (allocation ledger shown) |
| P5 | P1–P3 outputs | — | correctness under perf: P1 top-k matches the differential/adjudicated expectation; P2/P3 recover the planted subgroup at rank 1 and match `exhaustive` on a verified 100k-row subsample |

### 8.2 Stretch (record, non-blocking)

Depth-3 on synth-2M×256sel (GPU); tight numeric-target optimistic estimates (dissertation/KDD-style bounds) with measured node-reduction vs the 'sum' estimator; Roaring-style compressed bitmaps for sparse selectors; `patternTree` beating `apriori` on adult (record); k-anonymity-style minimum-size UI preset in the demo.

### 8.3 BENCHMARKS.md

Regenerated by `pnpm bench:gates` (inside `pnpm gate`): environment block; one row per benchmark with phase times, candidates evaluated, pruned %, peak memory, reference time and speedup where applicable, gate, PASS/FAIL; stretch rows marked STRETCH. Printed at the end of `pnpm gate`.

## 9. Memory & precision model

- Vertical layout: one bitset (`Uint32Array`, 32 rows/word) per selector, built once per task; conjunction covers are computed by word-wise AND into reusable scratch, never all materialized at once.
- Candidate evaluation is **batched and streaming**: a layer's candidates are processed in fixed-size batches producing statistics only; covers for the next layer are re-derived (depth ≤ 3 keeps AND-chains cheap) or cached under an explicit byte budget with spill-to-recompute — a deliberate redesign of the reference's per-object representations.
- Statistics in f64 on CPU (pairwise summation for long numeric reductions). Numeric target values stored f64 (CPU) / f32 (GPU transfer) with error accounting per §12.
- Tests assert: no O(|candidates| × n) resident memory on a 2M-row task (allocation ledger), and peak accounting is printed for P4.

## 10. Architecture

```
src/
  table/      DataTable, columns, NA handling, fromCSV/fromRows/fromColumns, dictionary encoding
  desc/       selectors, Conjunction/Disjunction/DNF, canonical order, parsing/printing, space builders
  bitset/     word ops, popcount, iteration, builders (per-column selector bitset atlas)
  targets/    binary, numeric, fi, emm (poly-regression sufficient statistics: n, Σx, Σy, Σxx, Σxy, Σyy — mergeable)
  qf/         all quality functions + optimistic estimates + constant stats; chi2 tail prob
  search/     candidate-space definition, exhaustive oracle, apriori, dfs, dfsNumeric, bestFirst, beam, patternTree, generalizingBFS, constraints, top-k structure (canonical order)
  backends/   types.ts (BatchEvaluator interface), cpu/ (kernels + worker pool), webgpu/ (device, WGSL kernels, tiling)
  results/    Result, stats tables, filters, serialization, CSV export
```

- **The only backend abstraction is the `BatchEvaluator`:** given the selector-bitset atlas, a batch of candidate conjunctions (as sorted selector-id tuples or parent-cover + extension-id pairs), and the target's precomputed vectors, return per-candidate statistics (size; positives; or masked Σ/Σ² etc. per target). All search *logic* is backend-agnostic and exact; backends only accelerate evaluation. A future WASM evaluator is additive.
- `search/` and `qf/` depend on nothing environment-specific; environment detection is lazy and injectable.

## 11. CPU backend

- Typed-array kernels; hot loops free of closures and allocation; popcount via the standard SWAR/Harley–Seal word tricks; set-bit iteration via de Bruijn or ctz loops for gather-sums on numeric targets.
- Worker pool (browser `Worker` / `node:worker_threads`) sharding candidate batches; `SharedArrayBuffer` for the bitset atlas when `crossOriginIsolated` or in Node, transfer/copy sharding otherwise — **fully functional without SAB** (GitHub Pages constraint, §15).
- Deterministic regardless of worker count: workers return statistics; ranking happens centrally under the canonical order.
- Main-thread paths yield at least every ~50 ms; heavy runs go through workers by default.

## 12. WebGPU backend

- WGSL kernels for batch evaluation: (1) conjunction cover = word-wise AND across k selector rows of the atlas; (2) `countOneBits`-based popcount reduction (size, and AND with the target bitset for positives); (3) masked segmented sums for numeric/EMM targets (per-workgroup f32 partials). One dispatch evaluates thousands of candidates; layer pipelines double-buffer candidate batches.
- **Exactness policy (binding):** GPU f32 sums are used for *screening only*. Any candidate whose GPU-scored quality or optimistic estimate lies within a conservative error band of a decision boundary (top-k threshold, pruning threshold, plant-vs-runner-up margins) is re-scored on CPU in f64 before any decision. Derive the band from a worst-case f32 accumulation error bound; test it empirically (GPU vs f64 stats rel ≤ 1e-5 on fixtures) and prove via §6.2 that GPU-backed exact algorithms remain exact. Pure-count statistics (binary/FI targets) are integer-exact on GPU — no band needed; document both regimes.
- Resource discipline: request elevated `requiredLimits` up to adapter limits; chunk the atlas across bindings if needed (2M rows × 256 selectors = 64 MB — comfortably within reach after negotiation); keep per-submit GPU time ~< 1 s with `onSubmittedWorkDone` pacing; explicit buffer destruction; `AbortSignal` unwinds cleanly; `device.lost` → typed error.
- **Playwright policy — fail, don't skip:** browser gate tests launch Chromium (flags/`channel: 'chrome'` fallback as needed), call `navigator.gpu.requestAdapter()`, print adapter info in test output, and **fail** with an actionable message if the adapter is null. Only `SUBGROUP_WEB_CI_CPU_ONLY=1` (GPU-less GitHub runner) may skip the browser project; it must never be set in the goal-proving run, and `pnpm gate` prints its state.

## 13. Environments

| Environment | CPU backend | WebGPU backend |
|---|---|---|
| Chromium-family browsers | supported (workers; SAB if isolated) | supported via `navigator.gpu` — **acceptance platform** |
| Firefox / Safari | supported | capability-detected; used if an adapter is present, clean fallback otherwise (not gated) |
| Node ≥ 20 | supported (worker_threads + SAB) | via injected device from Dawn bindings (e.g. the `webgpu` npm package); documented + smoke-tested; non-gating |

No browser/Node globals at module top level.

## 14. Reference harness (`reference/`)

- `pyproject.toml` + `uv.lock` pinning `pysubgroup==0.9.0` and exact resolved `pandas`/`numpy`/`scipy`; committed. All scripts run via `uv run`.
- `scripts/export_datasets.py`: dumps `titanic` and `credit-g` through the reference's own loaders to committed CSV + SHA-256 manifests (these are also the demo's sample datasets); `scripts/fetch_adult.py` downloads + checksums into a git-ignored cache with a deterministic preprocessing recipe.
- `scripts/gen_differential_fixtures.py`: runs the §6.4 matrix through the reference (its bitset representation where applicable), emitting per-task JSON fixtures: top-k descriptions in the reference's own string form, qualities, full stats, and per-subgroup QF evaluations for fixed description lists. A parser maps reference description strings to canonical subgroup-web descriptions (round-trip tested).
- `scripts/bench_reference.py`: measured reference timings for §8 speedup gates (median of 3, same machine, wall time around `execute`).
- `reference/repros/`: minimal Python scripts backing every `COMPATIBILITY.md` adjudication; each runs green (i.e., reproduces the divergence) under `uv run`.
- `reference/README.md` documents every fixture family and consuming test.

## 15. Demo app (`demo/`) — GitHub Pages deployable

Purpose: a genuinely useful privacy-preserving subgroup-discovery explorer; the human-checkable acceptance vehicle; the replacement for the reference's matplotlib module.

- Vite + vanilla TypeScript; imports `subgroup-web` from the workspace build. Dependencies are allowed in the demo app. Consider using Observable Plot / D3.js for visualizations.
- **Features:** dataset picker (committed samples: titanic, credit-g, an adult sample; planted-synthetic generator for instant demos) and **CSV upload** (parsed locally — the UI says so explicitly); target builder with auto-detection (binary value picker / numeric column); search-space panel (per-attribute include/exclude, bins, negations, intervals-only); task panel (QF with parameters, algorithm, depth, k, min-support, min-quality); run with live progress (layer, candidates/s, pruned %, best-so-far) and abort; **results table** (sortable; inline bars for size and target share vs population); **subgroup detail view** (canvas histogram/share comparison subgroup vs complement, covered-row preview); **ROC-space scatter** and **subgroup-bars** canvas views (recreating `plot_roc` / `plot_sgbars`); overlap/uniqueness post-filters; export results CSV/JSON; backend toggle with adapter readout and timing HUD; `crossOriginIsolated` badge; link to `/api` docs.
- **GitHub Pages constraints (binding):** Vite `base` from `BASE_PATH` (default `/subgroup-web/` for `demo:build`, `/` for dev); no absolute URLs. Pages cannot send COOP/COEP → no SharedArrayBuffer: the demo must run fully with non-SAB workers; WebGPU unaffected; `coi-serviceworker` documented as opt-in, shipped **off**. Local dev server sets COOP/COEP so SAB paths are exercised in development.
- `.github/workflows/pages.yml`: build library → demo (`BASE_PATH=/subgroup-web/`) → TypeDoc into `dist-pages/api` → upload-pages-artifact → deploy-pages. Best-effort; **acceptance is local**: `pnpm demo:build && pnpm demo:preview`, Playwright smoke against the preview *including the base path*.
- **Demo smoke gate (in `pnpm gate`):** Playwright loads the preview, selects titanic, runs `apriori` with `standard(0.5)` depth 2 on WebGPU, waits for completion, asserts the results table is populated and HUD timings > 0, screenshots to `test-results/demo-titanic.png`. At M7 you must open the screenshot, inspect it, and state in the transcript what you see (expected: a populated results table whose top subgroups are the classic sex/class survival patterns, with sensible shares).

## 16. Packaging, tooling, scripts

### 16.1 Package

ESM-only; `"type": "module"`; `exports`: `.` (full API + CPU), `./webgpu` (GPU backend registration); types everywhere; `sideEffects: false`; Node `>=20` in `engines`. **Zero runtime dependencies** (`dependencies` absent; enforced by `pnpm check:deps`). devDependencies unrestricted (fast-check, tooling); demo devDeps only. License Apache-2.0 (§18).

### 16.2 Toolchain

pnpm (corepack); TypeScript `strict` + `noUncheckedIndexedAccess` (targeted, commented suppressions only inside `backends/*/kernels` and `bitset/` hot loops); tsdown or tsup; Vitest; Playwright; Biome (lint+format; bans `Math.random` in `src/`); TypeDoc; fast-check. `ci.yml` runs the CPU-only gate on ubuntu (`SUBGROUP_WEB_CI_CPU_ONLY=1`) — best-effort, not part of local acceptance.

### 16.3 Scripts (names binding)

| script | does |
|---|---|
| `pnpm fixtures` | export datasets + generate differential fixtures (uv) |
| `pnpm ref:bench` | measure reference timings for speedup gates (uv) |
| `pnpm build` / `typecheck` / `lint` | the obvious |
| `pnpm test` | Vitest: spec/unit/property/exactness/differential (Node) |
| `pnpm test:browser` | Playwright: GPU exactness + backend-identity cells + demo smoke |
| `pnpm bench` / `bench:gates` | full suite / gate subset; regenerates BENCHMARKS.md |
| `pnpm demo:dev` / `demo:build` / `demo:preview` | Vite (build uses `BASE_PATH=/subgroup-web/`) |
| `pnpm run docs` | TypeDoc (use `run`: bare `pnpm docs` forwards to `npm docs`) |
| `pnpm pack:test` | `npm pack` → temp-dir install → Node ESM smoke: titanic apriori, assert exact expected top-3 |
| `pnpm check:deps` / `check:noskip` | zero-runtime-deps assert / fail on `.skip`/`.only`/`todo` in gate suites (also `allowOnly: false`) |
| `pnpm gate` | check:deps → check:noskip → typecheck → lint → build → test → pack:test → test:browser → bench:gates → print PARITY.md + COMPATIBILITY.md summary + BENCHMARKS.md + final `GATE: PASS/FAIL` line |
| `pnpm gate:quick` | typecheck + spec/unit + small exactness subset (inner loop) |

`pnpm gate` output stays compact and complete (~≤ 300 lines: per-suite counts, the report tables verbatim, env-var notice, verdict) so full output can be shown in the transcript; verbose logs go to `.logs/` (git-ignored).

## 17. Documentation

- TSDoc on every export; TypeDoc builds clean into the Pages artifact under `/api`.
- `docs/spec.md` (§6.1) — the load-bearing document; `docs/design.md` — architecture, BatchEvaluator, GPU exactness-band derivation and measurements, memory model, algorithm redesign notes vs the reference.
- `README.md`: what/why (privacy-preserving in-browser subgroup discovery), install, 30-second example, targets/QF/algorithm tables, exactness classes and determinism guarantees, backend + environment support matrix, performance summary with measured speedups, correctness methodology (spec-first, differential-adjudicated — link PARITY.md and COMPATIBILITY.md), demo link placeholder + local instructions, roadmap (instance weights, WASM evaluator, compressed bitmaps), attribution + citation of the pysubgroup paper.

## 18. License & attribution

`LICENSE`: Apache-2.0 (matching the reference), copyright the repository owner. `NOTICE`: subgroup-web is an independent TypeScript implementation of subgroup discovery; semantics were developed against pysubgroup 0.9.0 (Apache-2.0, © Florian Lemmerich and contributors), whose paper (Lemmerich & Becker, ECML-PKDD 2018) should be cited by academic users. Do not copy reference source verbatim beyond short attributed snippets documenting semantic decisions.

## 19. Milestones

Each milestone ends with: its acceptance commands run and shown, `STATUS.md` updated, a conventional commit, and an annotated git tag `mN`. Build oracles before optimized engines, always.

### M0 — Scaffold + reference pin
Scope: `git init`; repo layout (§10); toolchain (§16.2); all §16.3 scripts wired (stubs may no-op but exist and pass); `reference/` resolving `pysubgroup==0.9.0` via uv; titanic + credit-g exported with checksums; first differential fixture generated and parsed round-trip in a TS test; `docs/spec.md` skeleton; STATUS.md/DECISIONS.md/COMPATIBILITY.md created; ci.yml + pages.yml drafted.
Accept: `uv run python -c "import pysubgroup; print(pysubgroup.__version__)"` prints 0.9.0 (shown); `pnpm gate:quick` exits 0; fixture manifests list SHA-256; tag `m0`.

### M1 — Data model, descriptions, bitsets
Scope: DataTable + NA policy (verified against reference behavior — adjudicate any surprise); `fromCSV`; selectors incl. interval bound convention pinned from source; Conjunction/Disjunction/DNF; canonical order + candidate-space definition written into the spec (same-attribute rule adjudicated, §22-A3); space builders incl. equal-frequency edge cases; bitset engine + atlas builder.
Accept: spec §§ for all of the above written with citations; micro-fixture tests green; description string round-trip vs reference fixtures green; tag `m1`.

### M2 — Targets, quality functions, statistics
Scope: all four targets; every QF of §5.3 with constant-stats precomputation and optimistic estimates as defined by reference/literature; both statistic_types tables; χ² incl. p-value (§22-A6); EMM sufficient statistics; instance-weighting decision recorded (§2).
Accept: hand-computed micro-fixtures green for every QF; differential formula gates green (per-subgroup QF values vs reference, rel ≤ 1e-9) or adjudicated with repros; tag `m2`.

### M3 — The oracle
Scope: `exhaustive` engine with dual cross-checked statistics paths; planted-ground-truth generators (binary + numeric) frozen as fixtures; property/metamorphic suites (admissibility, monotonicity, invariances) wired with replayable seeds; adjudication machinery live (differential runner requires adjudication ids for divergences).
Accept: exhaustive matches hand fixtures and recovers all plants at rank 1; dual stat paths agree on every fixture; property suites green; tag `m3`.

### M4 — Exact CPU algorithms
Scope: `apriori`, `dfs`, `bestFirst` (+ constraints integration); optimistic-estimate pruning proven sound (pruning on/off identity); canonical top-k structure; batched evaluation on the single-thread CPU evaluator.
Accept: §6.2 exactness gates green for these algorithms across the full matrix incl. ties/NA/negation cells (show the table); tag `m4`.

### M5 — Full surface
Scope: `beamSearch` (fully specified, deterministic), `dfsNumeric` (applicability documented from source), `patternTree` (exact GpGrowth replacement), `generalizingBFS`, `generalizationAware` QFs, `combined`, FI target algorithms, result filters, Disjunction/DNF stats, serialization; full §6.4 differential matrix complete with COMPATIBILITY.md adjudications; `pack:test` green.
Accept: exactness gates green for all exact algorithms; beam matches its spec at widths {1, 20}; zero unadjudicated differential rows (show summary); tag `m5`.

### M6 — Backends + performance
Scope: CPU worker pool; WebGPU BatchEvaluator (kernels, limits negotiation, exactness band per §12); cross-backend identity gates; benchmark runner incl. `ref:bench` reference timings; P1–P5 measured.
Accept: backend-identity rows green; GPU exactness cells green with band statistics shown; **P1–P5 PASS** with BENCHMARKS.md shown incl. measured speedups; adapter info printed; tag `m6`.

### M7 — Demo, docs, ship
Scope: demo per §15 incl. Pages base-path build, smoke, screenshot inspection; ROC-space + subgroup-bars views; TypeDoc clean; README/design/spec finalized; NOTICE/LICENSE; workflows finalized; stretch items as budget allows, recorded.
Accept: full `pnpm gate` exit 0 end-to-end, PARITY.md all GATE rows PASS, COMPATIBILITY.md fully adjudicated, BENCHMARKS.md gates PASS; demo screenshot inspected and described; `git status --porcelain` empty; tags `m0`–`m7`; tag `m7`.

## 20. Working agreements (every turn)

1. **Start** by reading `STATUS.md`, then the active milestone's §19 entry + referenced sections.
2. **Work** in small verified increments; run `pnpm gate:quick` after meaningful changes; long output to `.logs/`, surface tails + verdicts.
3. **Record** irreversible/semantic decisions in `DECISIONS.md` (dated, one paragraph, alternatives). Reference-divergence decisions additionally follow §6.3 into `COMPATIBILITY.md` with a committed repro.
4. **End** by updating and printing `STATUS.md` in full as the last block of the turn. Required sections: milestone checklist (M0–M7 ☐/◐/☑), "Now", "Next 3 actions", "Open risks/blockers", "Last gate result (command, verdict, timestamp)".
5. Commit early and often (conventional commits); never rewrite history; annotated milestone tags.
6. Sub-agents may take leaf work (QF battery, WGSL kernel drafts, demo views, fixture scripts, docs prose); the main session owns integration, gates, STATUS.md, all spec text, and all adjudications.
7. Re-read files rather than trusting recollection; the spec, this brief, and the pinned source are current — your memory of them may not be.
8. If a needed tool is missing in the environment (`uv`, Playwright browsers), install it, note it in STATUS.md, continue.

## 21. Anti-gaming rules (binding)

- **Ratchet:** thresholds, gate definitions, the matrix, and spec text may be tightened freely; loosening or removing any of them requires a DECISIONS.md entry that (a) justifies the change from literature or reference-source evidence, and (b) is not written in the same turn a failing result is converted to passing by that change. Adjusted rows are marked `ADJ` in PARITY.md.
- **Adjudication integrity:** an adjudication is valid only with a committed, runnable repro under `reference/repros/` demonstrating the reference behavior, plus a spec argument. Writing an adjudication in the same turn a differential failure flips to green **without** the repro is a violation. Adjudications may not be used to paper over subgroup-web bugs — property suites and the exhaustive oracle must agree with the adjudicated behavior.
- Planted-ground-truth fixtures, micro-fixtures, and differential fixtures change only by re-running generators; hash checks stay on; never hand-edit.
- Gate suites: no `.skip`/`.only`/`todo`/early-return stubs (`check:noskip`); a test that cannot run is a failing test. GPU tests fail (not skip) without an adapter except under `SUBGROUP_WEB_CI_CPU_ONLY=1`, never set in the goal-proving run, state printed by `pnpm gate`.
- Benchmark and reference-timing numbers come only from runner output; never hand-write BENCHMARKS.md, PARITY.md, or the machine-verified parts of COMPATIBILITY.md.
- If a gate appears unreachable after genuine effort, do not redefine it: write `HANDOFF.md` (state, evidence, blockers, best next steps), print it, and stop per the goal's escape clause.

## 22. Known hard problems (read before the relevant milestone)

- **A1 — The reference's result order is an artifact.** `add_if_required` manages the result set with `heapq` on `(quality, subgroup)` tuples; tie order depends on Python object comparison and insertion order. Define the canonical total order in the spec, compare differential results as quality-tolerant sets where only tie order differs, and adjudicate. (M1/M6.3)
- **A2 — NA semantics.** The reference inherits pandas comparison behavior (NaN fails all comparisons; category codes). Pin the spec's NA policy (§5.1), test NA-stress fixtures differentially, adjudicate surprises — especially NegatedSelector over NA (¬(x=v) on NA is a classic trap). (M1)
- **A3 — Candidate-space consistency.** Check whether the reference's algorithms agree on the space: `SimpleSearch` uses raw selector combinations; `StaticSpecializationOperator` groups selectors by attribute (no same-attribute refinements); Apriori generates level-wise joins. If they disagree (likely), that is a reference inconsistency: define the space once in the spec, make every subgroup-web algorithm (including `exhaustive`) enumerate exactly it, adjudicate. (M1/M3)
- **A4 — Optimistic-estimate admissibility.** For `standard(a)` the closed-form bound (all positives retained) is standard; verify the reference's numeric-target estimators ('sum', 'average', 'order') against the literature — 'average' in particular is known to be non-admissible in some formulations. Non-admissible estimates may only be used where the reference uses them heuristically, never in subgroup-web's exact algorithms: prove each bound you prune with (property suite + pruning-identity gate), and adjudicate reference over-pruning if found — this is precisely the class of bug (b) exists for. (M2/M4)
- **A5 — DFSNumeric applicability.** The reference's `DFSNumeric` sorts by target and scores prefixes; determine from source exactly which QF/estimator combinations it is valid for; document, restrict, adjudicate. (M5)
- **A6 — χ² without scipy.** Implement the 2×2 contingency statistic and its p-value (dof 1: p = erfc(√(x/2))) with a well-tested erfc; determine from the reference source whether its scipy call applies Yates continuity correction and pin that in the spec. (M2)
- **A7 — GPU floating-point vs exactness.** Binary/FI statistics are integer-exact on GPU. Numeric sums are f32: derive the conservative error band, re-score boundary candidates on CPU f64 (§12), and prove exactness via §6.2 on GPU cells. Never let a screening value make a final decision. (M6)
- **A8 — Equal-frequency binning edges.** Duplicate quantiles collapse bins; the reference's `equal_frequency_discretization` has specific behavior for repeated values and `intervals_only=False` (adds equality selectors on cutpoints?). Pin from source, fixture it, adjudicate. (M1)
- **A9 — patternTree (GpGrowth replacement).** The reference flags GP-growth experimental. Build the FP-growth-style engine from the literature with mergeable target statistics (`gp_merge` analogues: counts; Σ-vectors; EMM sufficient stats), validate exactness against the oracle, and differentially compare to the reference's GpGrowth only diagnostically — expect divergences; adjudicate notable ones. (M5)
- **A10 — Generalization-aware QFs** need cached qualities/stats of all generalizations; design the cache (canonical-prefix keyed), bound its memory, and gate GA exactness against a naive recomputation. (M5)
- **A11 — EMM merge algebra.** Poly-regression via mergeable sufficient statistics (n, Σx, Σy, Σxx, Σxy, Σyy → β, log-likelihood); guard degenerate fits (n ≤ degree, zero variance) the way the reference does — or better, with adjudication. (M2/M5)
- **A12 — Memory of layer covers.** Apriori's next level needs frequent-candidate covers: recompute AND-chains from the atlas (cheap at depth ≤ 3) vs cache under a byte budget. Measure both, choose per-task adaptively, document in design.md. (M4/M6)
- **A13 — Beam determinism.** Specify beam expansion order, dedup, and tie handling exactly (canonical order); `beam_width_adaptive` semantics pinned from source. (M5)
- **A14 — Storage limits & watchdog** (atlas chunking across bindings, ~< 1 s per submit, `onSubmittedWorkDone` pacing, `device.lost` handling). (M6)
- **A15 — Headless WebGPU:** Chromium may need flags or `channel: 'chrome'`; verify adapter at suite start, print `adapter.info`; if headless fails, fall back to headed locally (document). (M6)
- **A16 — Description string round-trip.** Differential fixtures speak the reference's `str(Conjunction)` dialect (rounding digits in interval strings!); the parser must round-trip exactly or match on structure; pin rounding behavior from source. (M0/M6.3)

## 23. Definition of done

All demonstrated in one final turn: STATUS.md shows M0–M7 ☑ and is printed; fresh `pnpm gate` exit 0 with complete output — PARITY.md all GATE rows PASS, zero unadjudicated differential divergences (COMPATIBILITY.md summary shown), no-skip check green, `SUBGROUP_WEB_CI_CPU_ONLY` unset, adapter info shown; P1–P5 pass in BENCHMARKS.md including measured reference speedups; demo built with the Pages base path, smoke passed, screenshot inspected and described; `git status --porcelain` empty; `git tag` lists m0–m7; any `ADJ` rows carry compliant DECISIONS.md entries and any adjudications carry committed repros. If instead a gate is unreachable or the turn budget is exhausted: HANDOFF.md written and printed per §21.
