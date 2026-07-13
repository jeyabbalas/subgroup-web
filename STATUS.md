# STATUS.md

## Milestone checklist

- ☑ **M0 — Scaffold + reference pin**: toolchain, all §16.3 scripts, uv-pinned pysubgroup 0.9.0, datasets exported w/ SHA-256, adult fetched (48842×15), ref-dialect round-trip green, WebGPU adapter gate green (apple/metal-3, headless).
- ☑ **M1 — Data model, descriptions, bitsets**: DataTable + fromCSV (pandas parity); selectors incl. [lo,hi) pinned; canonical order + candidate space (spec §§1–4); space builders incl. equal-frequency walk — selector-space parity exact on 6 configs; bitset engine + atlas cross-checked; ADJ-001/002/003 w/ repros.
- ☑ **M2 — Targets, quality functions, statistics**: all four targets + validation; every §5.3 QF w/ constant stats + admissible estimates (A4 proofs, pruningSafe flags); 13/14-field stat tables; χ² incl. own tail prob (A6); EMM sufficient stats (A11); GA family; combined; differential formula gate 338 values / 0 unexplained; ADJ-004…009 w/ repros; weighting excluded (§2); spec §§5–6.
- ☑ **M3 — The oracle**: `exhaustive()` over canonical C(S,d) with dual cross-checked stat paths (full coverage every matrix cell); canonical TopK (§3.3/§3.4); planted generators frozen — 4/4 plants at rank 1; property suites (seed 20260711); tie-tolerant top-k differential (MAP-001); ADJ-010 w/ repro; spec §7.1–7.3.
- ☑ **M4 — Exact CPU algorithms**: `apriori`/`dfs`/`bestFirst` through the BatchEvaluator seam + central scorer (bit-identical qualities); m4-exactness-cpu 31 cells × 3 algos == oracle exactly; m4-pruning-identity (on/off, off = full space, engaged on 18); stress generators frozen (tie/na/dup); pandas round_trip harness fix; spec §7.4–7.7.
- ☑ **M5 — Full surface**: `beamSearch` (spec §7.8 fully determinized; == independent spec mirror at widths {1,20}+adaptive ×8 cells, w≥|C| ≡ oracle; A13), `dfsNumeric` (order-estimate DFS, standardNumeric-only w/ typed errors; 6/6 cells == oracle; A5), `patternTree` (FP-growth, integer merge algebra, binary/FI w/ documented restriction + FI θ-guard; 18/18 cells == oracle, pruning engaged on 6; A9 scope DECISION), `generalizingBFS` (exact over D(S,d) via OR-covers + §7.7 walk; 28/28 cells == disjunction-oracle; og vacuity proven in spec §7.11; replaces reference's inadmissible fudge), result filters (minimumQuality/overlap/uniqueAttributes/min-max-statistic; **ADJ-011** — 3 reference filters crash on own results, repro), serialize/deserialize + toCSV + describeStats (Disjunction/DNF); differential matrix complete per §6.4: 21/21 cells (chi²-pValue-negative, EMM, gaStandard, dfsNumeric, d1/k1/k100; **ADJ-012** — reference Apriori/DFS crash on estimate-free QFs, repro); spec §7.8–7.12.
- ☑ **M6 — Backends + performance**: `WorkerPoolEvaluator` (node:worker_threads + browser Worker, SAB/copy regimes, process-cached workers, localThreshold inline path) — m6-backend-identity-workers 88/88 bit-identical vs single-thread; WebGPU `BatchEvaluator` (WGSL fused AND-chain+popcount, shared-tile pairs kernel, numeric f32-screening kernel; codes-mode on-device atlas build packed via mappedAtCreation; limits negotiation + chunked atlas bindings + grouped dispatches + single readback per call; §12 band: per-candidate sumEps/excessEps upper bounds, TopK `couldAdmit` + CPU f64 re-score at admission, conservative pruning — A7/A14) — m6-backend-identity 44/44 (exact algos == oracle in-browser), m6-gpu-band 7201 candidates 0 violations (maxRel 7.7e-6), m6-gpu-pruning-chunking 8/8 == oracle incl. forced 4 KiB chunks + 4096-word dispatch groups; bench runner + measured reference timings; **P1–P5 PASS** (P1 0.018 s = 17.7× ref; P2 cpu 0.608 s / gpu 0.097 s = 6.2×; P3 cpu 1.686 s / gpu 0.952 s; P4 atlas 64 MB = 98.8 % of search allocations; P5 5/5 incl. subsample == oracle); synth-2M generators hash-pinned cross-engine (portable gaussian); A12 measured (`scripts/measure-a12.mjs`) + `docs/design.md` (architecture, band derivation + empirical validation, memory model, A12 decision, reference-departure notes); adapter apple/metal-3 printed.
- ☑ **M7 — Demo, docs, ship**: demo app per §15 (Vite + vanilla TS under `demo/`; dataset picker titanic/credit-g/adult-sample + planted-synthetic + local-only CSV upload; auto-detecting target builder w/ binary value picker incl. minority-value default; search-space panel w/ per-attribute include/exclude + id-heuristic defaults, bins, intervals-only, negations + live selector/candidate counter; task panel w/ QF parameters, algorithm gating by target/QF, depth/k/min-quality/min-support, backend toggle cpu/workers/webgpu/auto, pruning audit toggle; run w/ live progress layer/cand-s/pruned-%/best + abort via AbortSignal; sortable results table w/ inline size/share bars vs dataset markers; overlap/unique-attrs/min-quality/min-size post-filters; JSON/CSV export; ROC-space + subgroup-bars canvas views w/ click-select; subgroup detail w/ stats table, share-comparison / histogram canvas, covered-row preview; backend HUD incl. §12 band readout, crossOriginIsolated badge, /api link); Pages base-path build fixed for `vite preview` (isPreview base + no COOP/COEP = deployed regime) + `./worker` export with a consumer-side moduleSideEffects bundler plugin (library keeps `sideEffects: false` per §16.1); demo smoke gate m7-demo-smoke (titanic apriori standard(0.5) d2 on WebGPU: 20 rows, rank-1 `Sex=='female'`, HUD > 0, copy-regime workers bit-identical, screenshot test-results/demo-titanic.png inspected); TypeDoc clean (0 warnings) into docs-api → Pages `/api`; README finalized per §17 (tables, measured speedups, methodology links, demo link, roadmap, citation); LICENSE corrected to Apache-2.0 + NOTICE per §18; ci.yml/pages.yml final; tag m7.

## Post-M7 maintenance (2026-07-13)

Production-grade review fix series (15 commits on main), from a three-track
deep review of the shipped M0–M7 codebase:

- **Robustness/correctness:** `backend:"auto"` now degrades
  webgpu → workers → cpu with reasons in `results.backend.note` instead of
  dying on a throwing GPU factory or failing worker spawn; `workers:false`
  honored as auto's single-thread opt-out; NaN optimistic estimates clamp to
  +∞ at the best-first/gbfs frontier push sites (custom-QF exactness, spec
  §7.7/§7.11 tightened); chiSquared degenerate targets rejected at
  prepareTask via the new stats-QF `validateTarget` hook (spec §6.2);
  fromCSV skips blank records like pandas `skip_blank_lines` (DECISIONS
  entry; fixtures byte-unaffected); progress reports carry best-so-far
  descriptions and beam-aware bestQuality; GA difference-aggregate max
  seeds from the first pair (CPython parity); worker-pool spawn failures
  terminate already-acquired handles; WebGPU grouped-pairs dispatches chunk
  to the 65535 workgroup-dimension limit (`maxRunsPerDispatch`).
- **Packaging:** `sideEffects` allowlists `dist/worker.js` (BRIEF §16.1
  amendment, DECISIONS) — the demo dropped its consumer-side plugin, so the
  smoke gate exercises the real unpatched consumer path; publish metadata +
  `prepublishOnly` guard; pack-test asserts the worker ships; public barrel
  curated pre-publish (internals off `src/index.ts`, deep imports sealed by
  the exports map).
- **Quality/coverage:** lint zero warnings (biome preset, dead-code sweep,
  pinned-constant ignores); direct suites for TopK/heap, abort, worker
  crash, gbfs early-stop, atlas properties, binning micros (+57 node
  tests); docs corrected (tight-vs-loose generalization-bound attribution,
  bitset JSDoc, README tscore row, spec §8 written).

## Now

Shipped. All milestones M0–M7 complete; goal-proving evidence in the final turn (STATUS.md, full `pnpm gate` output, exactness matrix, BENCHMARKS.md P1–P5, demo screenshot description, clean tree + tags m0–m7).

## Next 3 actions

1. — (project complete; future work tracked in README roadmap: instance weights, WASM evaluator, compressed bitmaps, tighter numeric bounds)
2. —
3. —

## Open risks / blockers

- None. Notes: Pages deploy (`pages.yml`) is best-effort CI; acceptance was proven locally against the base-path preview per §15. GPU numeric applicability stays sum-family screening (documented in spec §8 / design.md §4); EMM/median/order run CPU by design.

## Last gate result

- `pnpm gate` — **PASS** (27/27 gate rows incl. m6-gpu-pruning-chunking 10/10 — now incl. forced pair-run chunking — and m7-demo-smoke on the plugin-less demo; BENCHMARKS.md 5/5 gates (P1 18.8×, P2 gpu 6.4× cpu-pool, P3/P4/P5 pass); 12 adjudications, 0 unadjudicated divergences; 459 node tests / 33 files, 5 browser suites; adapter apple/metal-3 (Chromium 149, Apple M5 Pro); SUBGROUP_WEB_CI_CPU_ONLY unset) — 2026-07-13 (post-M7 fix series)
- `pnpm gate` — **PASS** (27/27 gate rows incl. m6-backend-identity 44/44, m6-backend-identity-workers 88/88, m6-exactness-gpu 17 runs, m6-gpu-band 7201 candidates 0 violations, m6-gpu-pruning-chunking 8/8, m6-perf-p1…p5 all PASS, m7-demo-smoke; BENCHMARKS.md 5/5 gates (P1 17.7×, P2 gpu 6.2× cpu-pool, P3/P4/P5 pass); 12 adjudications, 0 unadjudicated divergences; 402 node tests / 22 files, 5 browser suites; adapter apple/metal-3 (Chromium 149, Apple M5 Pro); SUBGROUP_WEB_CI_CPU_ONLY unset) — 2026-07-11 (final M7 run)
