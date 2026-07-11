# STATUS.md

## Milestone checklist

- ☑ **M0 — Scaffold + reference pin**: toolchain, all §16.3 scripts, uv-pinned pysubgroup 0.9.0, datasets exported w/ SHA-256, adult fetched (48842×15), ref-dialect round-trip green, WebGPU adapter gate green (apple/metal-3, headless).
- ☑ **M1 — Data model, descriptions, bitsets**: DataTable (categorical/numeric/boolean, NA policy) + fromCSV (RFC-4180, pandas-parity inference/NA tokens); selectors incl. [lo,hi) pinned from source; canonical order + candidate-space definition (spec §§1–4 written with citations); space builders incl. equal-frequency walk (A8) — **selector-space parity exact on 6 configs** (365/377/381/83/92/98 selectors, byte-identical strings both dialects, in order); bitset engine + atlas, cross-checked bit-for-bit vs row-scan covers incl. negations; ADJ-001 (same-attribute space inconsistency), ADJ-002 (empty conjunction), ADJ-003 (negation covers NA) adjudicated with runnable repros; binning edge-case differential green (8 cases).
- ☐ M2 — Targets, quality functions, statistics
- ☐ M3 — The oracle
- ☐ M4 — Exact CPU algorithms
- ☐ M5 — Full surface
- ☐ M6 — Backends + performance
- ☐ M7 — Demo, docs, ship

## Now

Starting M2: binary/numeric/FI/EMM targets, all §5.3 quality functions with constant stats + optimistic estimates, both statistic_types tables, χ² with own tail probability (A6), EMM sufficient statistics (A11), instance-weighting decision (§2).

## Next 3 actions

1. Read pysubgroup binary_target.py, numeric_target.py, fi_target.py, model_target.py, measures.py to pin QF formulas, estimator definitions ('sum'/'average'/'order'), χ²/scipy continuity-correction, and EMM likelihood exactly.
2. Implement src/targets/ + src/qf/ with constant-statistics precomputation; spec §§5–6 written alongside; hand-computed micro-fixtures per QF (incl. NA/ties/empty-subgroup edges).
3. Extend matrix.json + generator with per-subgroup QF-value fixtures (fixed description lists) and run differential formula gates (rel ≤ 1e-9) or adjudicate with repros.

## Open risks / blockers

- None blocking. Notes: differential comparisons for dfs/bestFirst cells must use the ADJ-001 space mapping (compare vs reference Apriori). DFSNumeric/BeamSearch reference quirks (empty conj, hardcoded beam quality 0) pinned in ADJ-002 for M4/M5 comparisons.

## Last gate result

- `pnpm gate` — **PASS** (5/5 gate rows: refdialect-roundtrip, selector-space-parity, binning-differential, atlas-rowscan-crosscheck, differential-adjudication; 92 node tests, 1 browser test, pack smoke OK; SUBGROUP_WEB_CI_CPU_ONLY unset; adapter apple/metal-3) — 2026-07-11T03:42Z
