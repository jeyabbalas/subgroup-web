# STATUS.md

## Milestone checklist

- ☑ **M0 — Scaffold + reference pin**: toolchain, all §16.3 scripts, uv-pinned pysubgroup 0.9.0, datasets exported w/ SHA-256, adult fetched (48842×15), ref-dialect round-trip green, WebGPU adapter gate green (apple/metal-3, headless).
- ☑ **M1 — Data model, descriptions, bitsets**: DataTable + fromCSV (pandas parity); selectors incl. [lo,hi) pinned; canonical order + candidate space (spec §§1–4); space builders incl. equal-frequency walk — selector-space parity exact on 6 configs; bitset engine + atlas cross-checked; ADJ-001/002/003 w/ repros.
- ☑ **M2 — Targets, quality functions, statistics**: all four targets + validation; every §5.3 QF w/ constant stats + admissible estimates (A4 proofs, pruningSafe flags); 13/14-field stat tables; χ² incl. own tail prob (A6); EMM sufficient stats (A11); GA family (canonical iteration, CPython-max parity); combined; differential formula gate 338 values / 0 unexplained; ADJ-004…009 w/ repros; weighting excluded (§2); spec §§5–6 + §6.11.
- ☑ **M3 — The oracle**: `exhaustive()` (async/abortable/progress) over canonical C(S,d) with **dual cross-checked stat paths — 150,362/150,362 candidates verified bitset-vs-row-scan across all 7 matrix cells**; canonical TopK realizing §3.3 define-by-sort (spec §3.4 revised for consistency, DECISIONS); planted-ground-truth generators (binary + numeric) frozen w/ SHA-256 manifests — **4/4 plants recovered at rank 1**; property suites (admissibility of 15 pruningSafe QF configs on refinement chains, anti-monotonicity, permutation/duplication laws, negation identities, stats invariants; fast-check seed 20260711); **top-k differential green: 7/7 cells (binary/numeric/FI × apriori/simple × d2/d3, negations, χ²) tie-tolerant vs reference, MAP-001 mapping rule ledgered**; ADJ-010 (NOT-interval str crash) w/ repro; spec §7.1–7.3.
- ☐ M4 — Exact CPU algorithms
- ☐ M5 — Full surface
- ☐ M6 — Backends + performance
- ☐ M7 — Demo, docs, ship

## Now

Starting M4: `apriori()`, `dfs()` (bitset look-ahead), `bestFirst()` with §3.4 pruning + constraints integration; pruning-identity gates (on/off bit-identical); exactness gates vs the oracle across the matrix incl. tie/NA/negation cells; batched single-thread CPU evaluation path.

## Next 3 actions

1. Implement `search/apriori.ts` (level-wise, batched bitset evaluation, §3.4 prune rule incl. monotone constraints), `search/dfs.ts` (DFS with look-ahead), `search/bestfirst.ts` (priority queue on optimistic estimates) — all returning §3.3 top-k via the shared TopK.
2. Exactness runner: every exact algorithm × matrix cells (+ tie-stress, NA-stress, duplicate-row synthetics) == oracle top-k exactly; pruning on/off identity per algorithm; gate rows.
3. Extend matrix with minSupport/minQuality-set cells, estimator cells (sum/average/order), nbins 10, intervalsOnly false; regenerate differential fixtures; adjudicate as needed.

## Open risks / blockers

- None blocking. Notes: dfs/bestFirst differential cells compare vs reference Apriori (ADJ-001 space mapping). Reference non-vectorized-Apriori over-pruning (ADJ-007) and empty-cover rows (ADJ-004) can surface in minQuality −inf cells; fixture cells pin minQuality ≥ 0 or cite ids.

## Last gate result

- `pnpm gate` — **PASS** (10/10 gate rows incl. m3-dualpath-oracle 150362/150362, m3-planted-rank1 4/4, m3-property-suites, m3-topk-differential 7/7 cells / 65 rows; 260 node tests, 1 browser test, pack smoke OK; SUBGROUP_WEB_CI_CPU_ONLY unset; adapter apple/metal-3) — 2026-07-11T04:45Z
