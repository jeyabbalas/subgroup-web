# STATUS.md

## Milestone checklist

- ☑ **M0 — Scaffold + reference pin**: toolchain, all §16.3 scripts, uv-pinned pysubgroup 0.9.0, datasets exported w/ SHA-256, adult fetched (48842×15), ref-dialect round-trip green, WebGPU adapter gate green (apple/metal-3, headless).
- ☑ **M1 — Data model, descriptions, bitsets**: DataTable (categorical/numeric/boolean, NA policy) + fromCSV (RFC-4180, pandas-parity inference/NA tokens); selectors incl. [lo,hi) pinned from source; canonical order + candidate-space definition (spec §§1–4 written with citations); space builders incl. equal-frequency walk (A8) — **selector-space parity exact on 6 configs**; bitset engine + atlas, cross-checked bit-for-bit vs row-scan covers incl. negations; ADJ-001/002/003 adjudicated with runnable repros; binning edge-case differential green (8 cases).
- ☑ **M2 — Targets, quality functions, statistics**: all four targets (binary/numeric/FI/EMM w/ mergeable sufficient stats, A11) + validation; every §5.3 QF with constant-stats precomputation and optimistic estimates incl. admissibility proofs & pruning-safety flags (A4); both statistic_types tables (13/14 fields, reference formulas); χ² with in-house incomplete-gamma tail (A6, scipy-verified rel ≤1e-12); GA family with canonical iteration order + CPython-max parity; combined; **differential formula gate green: 338 per-subgroup QF values vs reference, 316 exact (rel ≤1e-9), 22 adjudicated, 0 unexplained**; 72 hand-computed micro-fixture tests + 46 invert-metamorphic tests; ADJ-004…009 adjudicated with runnable repros; instance-weighting exclusion verified & recorded (§2); spec §§5–6 + §6.11 written.
- ☐ M3 — The oracle
- ☐ M4 — Exact CPU algorithms
- ☐ M5 — Full surface
- ☐ M6 — Backends + performance
- ☐ M7 — Demo, docs, ship

## Now

Starting M3: exhaustive oracle engine with dual cross-checked statistics paths (mask row-scan vs bitset atlas), planted-ground-truth generators (binary + numeric) frozen as fixtures, property/metamorphic suites (admissibility on refinement chains, coverage anti-monotonicity, invariances) with replayable seeds.

## Next 3 actions

1. Implement `search/space.ts` (canonical candidate enumeration C(S,d) per spec §3.1) + `search/exhaustive.ts` with dual stat paths cross-checked per run; canonical top-k structure (spec §3.2/3.3 order).
2. Planted-ground-truth generators (implanted high-WRAcc pocket; implanted mean-shift pocket) frozen as CSV fixtures with seeds; gate: exhaustive recovers plants at rank 1.
3. Property suites (fast-check): admissibility of every pruningSafe estimate on sampled refinement chains; row-permutation invariance; duplication scaling; stats invariants; hook adjudication machinery into matrix-driven differential top-k comparisons.

## Open risks / blockers

- None blocking. Notes: differential comparisons for dfs/bestFirst cells must use the ADJ-001 space mapping (compare vs reference Apriori). GA-numeric differential cells constructed in non-canonical selector order will cite ADJ-009. Numeric cells with minQuality −inf may surface reference empty-cover rows (drop + cite ADJ-004) and non-vectorized-Apriori over-pruning (ADJ-007; fixture generator uses the vectorized path).

## Last gate result

- `pnpm gate` — **PASS** (6/6 gate rows: refdialect-roundtrip, selector-space-parity, binning-differential, atlas-rowscan-crosscheck, qf-differential 338 values/0 unexplained, differential-adjudication; 215 node tests, 1 browser test, pack smoke OK; SUBGROUP_WEB_CI_CPU_ONLY unset; adapter apple/metal-3) — 2026-07-11T04:24Z
