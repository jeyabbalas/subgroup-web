# STATUS.md

## Milestone checklist

- ☑ **M0 — Scaffold + reference pin**: repo layout, toolchain (pnpm/TS5.9/tsdown/Vitest4/Playwright1.61/Biome2.5/fast-check/TypeDoc), all §16.3 scripts wired and passing; `reference/` pins pysubgroup 0.9.0 via uv (python 3.12.13, pandas 2.3.3, numpy 1.26.4, scipy 1.17.1); titanic+credit-g exported with SHA-256 manifests; adult fetched (48842×15, hashes pinned); first differential fixture generated and round-tripped in TS (365 selectors + 5 results, both string dialects, exact); spec skeleton; ci.yml + pages.yml; WebGPU adapter gate green on headless Chromium (apple/metal-3).
- ☐ M1 — Data model, descriptions, bitsets
- ☐ M2 — Targets, quality functions, statistics
- ☐ M3 — The oracle
- ☐ M4 — Exact CPU algorithms
- ☐ M5 — Full surface
- ☐ M6 — Backends + performance
- ☐ M7 — Demo, docs, ship

## Now

Starting M1: DataTable + NA policy (verify against reference), fromCSV, selectors with pinned interval convention, canonical order + candidate-space definition (§22-A3 audit), space builders incl. equal-frequency edges (§22-A8), bitset engine + atlas.

## Next 3 actions

1. Read pysubgroup `utils.py` (equal_frequency_discretization), `representations.py`, and `algorithms.py` candidate-generation paths to pin the candidate-space rule and binning edges from source.
2. Implement `src/table/` (columns, DataTable, fromColumns/fromRows/fromCSV with inference) with spec §1 written alongside; micro-fixtures for NA policy; differential check of NA behavior vs reference.
3. Implement `src/desc/` (selectors, canonical order, Conjunction/Disjunction/DNF, space builders) + `src/bitset/` (word ops, popcount, atlas builder); spec §§2–4; round-trip vs reference selector fixtures.

## Open risks / blockers

- None blocking. Notes: WebGPU requires a secure context (served pages, not about:blank) — solved via local 127.0.0.1 server; headless Chromium exposes apple/metal-3 with 4 GB buffer limits (A15 derisked). pnpm build-script approvals are pinned in pnpm-workspace.yaml.

## Last gate result

- `pnpm gate` — **PASS** (2/2 gate rows; 43 node tests, 1 browser test, pack smoke OK; SUBGROUP_WEB_CI_CPU_ONLY unset; adapter apple/metal-3) — 2026-07-11T03:13:32Z
- `pnpm gate:quick` — PASS — 2026-07-11T03:08Z
