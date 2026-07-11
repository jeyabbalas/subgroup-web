# STATUS.md

## Milestone checklist

- ☑ **M0 — Scaffold + reference pin**: toolchain, all §16.3 scripts, uv-pinned pysubgroup 0.9.0, datasets exported w/ SHA-256, adult fetched (48842×15), ref-dialect round-trip green, WebGPU adapter gate green (apple/metal-3, headless).
- ☑ **M1 — Data model, descriptions, bitsets**: DataTable + fromCSV (pandas parity); selectors incl. [lo,hi) pinned; canonical order + candidate space (spec §§1–4); space builders incl. equal-frequency walk — selector-space parity exact on 6 configs; bitset engine + atlas cross-checked; ADJ-001/002/003 w/ repros.
- ☑ **M2 — Targets, quality functions, statistics**: all four targets + validation; every §5.3 QF w/ constant stats + admissible estimates (A4 proofs, pruningSafe flags); 13/14-field stat tables; χ² incl. own tail prob (A6); EMM sufficient stats (A11); GA family (canonical iteration, CPython-max parity); combined; differential formula gate 338 values / 0 unexplained; ADJ-004…009 w/ repros; weighting excluded (§2); spec §§5–6 + §6.11.
- ☑ **M3 — The oracle**: `exhaustive()` over canonical C(S,d) with dual cross-checked stat paths (bitset vs row-scan, full coverage on every matrix cell); canonical TopK (§3.3 define-by-sort, §3.4 revised); planted generators frozen w/ SHA-256 — 4/4 plants at rank 1; property suites (admissibility ×15 configs, monotonicity, invariances; seed 20260711); top-k differential tie-tolerant vs reference (MAP-001); ADJ-010 w/ repro; spec §7.1–7.3.
- ☑ **M4 — Exact CPU algorithms**: `apriori()` (level-wise join + level-final θ_now survivors), `dfs()` (bitset look-ahead, per-depth scratch covers), `bestFirst()` (estimate-ordered deterministic frontier, whole-frontier §3.4 termination) — all through the **BatchEvaluator seam** (BRIEF §10; single-thread CPU evaluator w/ prefix-sharing AND-chains) + one central scorer (bit-identical qualities); **m4-exactness-cpu: 31 cells × 3 algorithms == oracle exactly (incl. tie/NA/negation/dup stress, GA/combined/EMM/median/tscore, minSupport/minQuality)**; **m4-pruning-identity: on/off identical, off enumerates full space, engaged on 18 cells**; stress generators frozen (tie-stress/na-stress/dup-rows); matrix +8 differential cells (15/15 green incl. minSupport, estimators average/order, nbins10+allsel, 3 synth cells); pandas round_trip harness fix (DECISIONS); spec §7.4–7.7.
- ☐ M5 — Full surface
- ☐ M6 — Backends + performance
- ☐ M7 — Demo, docs, ship

## Now

Starting M5: `beamSearch` (fully specified: expansion/dedup/tie rules → spec §7.8, A13), `dfsNumeric` (applicability pinned from source, A5), `patternTree` (exact FP-growth replacement, A9), `generalizingBFS` + `generalizationEstimate`, GA caching bounds (A10), result filters (`minimumQualityFilter`, `overlapFilter`, `uniqueAttributes`, min/max statistic filters), Disjunction/DNF stats, serialize/deserialize + `toCSV`, complete §6.4 differential matrix + adjudications, `pack:test` remains green.

## Next 3 actions

1. Pin `beam_width_adaptive` + DFSNumeric applicability from reference source; write spec §7.8 (beam determinization) and §7.9 (dfsNumeric restriction); implement both against the oracle (beam vs its own spec at widths {1, 20}).
2. Implement `patternTree` (FP-growth-style, mergeable target stats: counts / Σ-vectors / EMM sufficient stats) + `generalizingBFS`; exactness gates vs oracle; diagnostic differential vs reference GpGrowth (expect divergences, adjudicate notable ones).
3. Result filters + Disjunction/DNF stats + serialization; extend matrix w/ beam/dfsNumeric/GA/EMM/combined differential cells where the reference supports them; COMPATIBILITY adjudications for any new divergence.

## Open risks / blockers

- None blocking. Notes: reference BeamSearch mutates its beam in place while iterating (known quirk — pin exact semantics from source before implementing); GpGrowth is experimental in the reference (A9: validate vs oracle, differential is diagnostic-only); GA cache memory bound needed before large GA cells (A10).

## Last gate result

- `pnpm gate` — **PASS** (12/12 gate rows incl. m4-exactness-cpu 31 cells × 3 algos, m4-pruning-identity 31/31 w/ pruning engaged on 18, m3-topk-differential 15/15 cells / 145 rows, m3-dualpath-oracle 292227/292227; 307 node tests, 1 browser test, pack smoke OK; SUBGROUP_WEB_CI_CPU_ONLY unset; adapter apple/metal-3) — 2026-07-11T05:23Z
