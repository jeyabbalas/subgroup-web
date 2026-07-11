# DECISIONS.md — irreversible / semantic decisions ledger

Format: date — decision — rationale — alternatives considered. Reference
divergences additionally get a COMPATIBILITY.md adjudication with a committed
repro (BRIEF §6.3, §21).

## 2026-07-10 — Reference environment pins

Pinned `pysubgroup==0.9.0` with `python 3.12.13`, `pandas 2.3.3`,
`numpy 1.26.4`, `scipy 1.17.1`, `setuptools <81` in `reference/uv.lock`.
pandas is capped `<3` because pysubgroup 0.9.0 predates pandas 3 (whose
default str dtype changes `select_dtypes`-based selector creation inputs);
2.3.3 is the newest release of the era the reference was written and CI-tested
against, minimizing environment-induced reference bugs in fixtures.
setuptools is capped `<81` because `pysubgroup.datasets` imports
`pkg_resources`, removed in setuptools 82. Alternatives: pandas 3 (works for
the smoke test but changes dtype semantics fixtures depend on), vendoring the
datasets (rejected: we export through the reference's own loaders instead,
BRIEF §14).

## 2026-07-10 — Canonical datasets are the exported CSVs

Differential fixtures are generated from the **committed CSVs** under
`reference/datasets/` (re-read via pandas), not from the reference's in-memory
loader outputs. Both harness sides therefore consume byte-identical input;
credit-g's ARFF byte-strings are decoded to UTF-8 once, in the exporter, so no
`b'...'` artifacts leak into either side. Alternative (feed `get_*_data()`
frames directly) rejected: bytes-vs-str selector values would differ between
the sides for credit-g.

## 2026-07-10 — Toolchain

pnpm 10 workspace (root = library, `demo/` = app); TypeScript 5.9 (7.x beta
rejected: typedoc/tsdown peer ranges); tsdown for bundling; Vitest 4 (Node
suites) + Playwright 1.61 (browser/GPU suites); Biome 2.5 for lint/format with
a GritQL plugin banning `Math.random` in `src/` (backstopped by
`check:noskip`); fast-check for property suites.

## 2026-07-11 — Candidate space: Apriori/SimpleSearch rule, no empty conjunction (M1)

Spec §3.1 pins the candidate space to all conjunctions of 1..depth distinct
selectors, same-attribute combinations allowed, empty conjunction excluded.
The reference's algorithms disagree among themselves (ADJ-001, ADJ-002 with
repros): Apriori/SimpleSearch enumerate exactly this space; DFS/BestFirst
restrict to one selector per attribute; SimpleDFS/DFSNumeric/BeamSearch also
evaluate (or hardcode) the empty description. Chosen because Apriori is the
reference's flagship algorithm, the wider space is strictly more expressive
(multi-negations, overlapping one-sided intervals), and one uniform space is a
precondition for cross-algorithm exactness gates. Alternative (per-attribute
restriction) rejected: it silently drops true optima (repro shows a 0.225 vs
0.115 WRAcc gap).

## 2026-07-11 — NA never satisfies a negation (M1)

Spec §1.2: cover(¬s) = V(attr) \ cover(s). The reference's logical_not covers
NA rows (ADJ-003, repro committed); BRIEF §5.1 pins the spec policy. A
description must only assert facts about observed values. Verified micro-fixtures
encode the spec tables; differential NA-stress cells cite ADJ-003.

## 2026-07-11 — fromCSV NA tokens = pandas defaults (M1)

fromCSV's default NA token set is the pandas read_csv default list (exact
match, overridable). Both harness sides read the same canonical CSVs; using
pandas' set removes a whole divergence class. Alternative (empty-string-only)
rejected: adult and future uploads contain 'NA'-style markers, and the
reference side would see NaN where we'd see strings.

## 2026-07-11 — Instance weighting excluded from v1 (M2, BRIEF §2)

Verified vestigial/broken in the pinned reference: `chi_squared_qf_weighted`
calls `subgroup.get_base_statistics(data, weighting_attribute)` — Conjunction
has no such method (AttributeError, verified); the weighted branch of
`equal_frequency_discretization` calls `DataFrame.sort(order=…)`, removed in
pandas ≥ 0.20 (AttributeError, verified); `derive_effective_sample_size` has
a single, itself-broken caller. No working weighted semantics exist to port.
Excluded from v1; `weighting_attribute` documented as roadmap in README (M7).
Alternative (re-derive weighted semantics from Atzmüller 2015) rejected for
v1: nothing to differentially validate against.

## 2026-07-11 — Numeric estimator closures + pruning-safety flags (M2, A4)

Spec §6.3 defines the optimistic estimates with admissible closures: Max/
'average' estimator returns 0 (not the reference's −inf) when no value
exceeds the centroid (ADJ-007 repro shows reference over-pruning + its two
Apriori paths disagreeing); the median-centroid estimate uses the safe form
n_sg^a·(T⁺max−med₀) because the reference's n₊-based bound is inadmissible
for medians (counterexample in spec §6.4). Every QF carries `pruningSafe`;
exact algorithms may prune only when true ('sum'/'max' proven for a ∈ [0,1],
'order' for a ≥ 0). Admissibility proofs in spec §6.3-6.4; property suite
samples refinement chains in M3.

## 2026-07-11 — GA iteration order + seeds pinned canonically (M2)

GA aggregates tie-break by strict `>` over generalizations, so iteration
order is semantics. The reference iterates combinations(selectors, k−1) over
*construction* order — same description, different quality (ADJ-009, repro).
subgroup-web iterates the reference's combinations order over the *canonical*
selector sequence (drop-last-first) and seeds the GA-numeric argmax at −inf
instead of 0.0 (the reference crashes with None when every centroid ≤ 0;
−inf agrees wherever the reference terminates). CPython max NaN-stickiness
(first-wins) reproduced via pyMax2 for aggregate parity.

## 2026-07-11 — Differential agreement definition incl. absolute floor (M2)

Spec §6.11: values agree iff both NaN, same infinity, rel ≤ 1e-9, or
|Δ| < 1e-15 (absolute floor for mathematically-zero quantities such as tie
qualities and ~1e-21 EMM likelihood differences, where relative comparison is
meaningless). Defined before the first QF-value comparison ran; the floor is
15 orders below any decision-relevant quality in the matrix.
