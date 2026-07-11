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

## 2026-07-11 — Spec §3.4 revised: full-comparator replacement, strict-< pruning (M3)

The M1 §3.4 text's parenthetical ("strict > for replacement") contradicted
§3.3's binding definition (result = first k under the §3.2 total order): with
quality-strict replacement, a boundary tie that outranks the k-th element by
depth/key would be kept or dropped depending on evaluation order — exactly
the reference's add_if_required heap artifact (BRIEF §22-A1) that §3.2 exists
to eliminate, and fatal to cross-algorithm exactness gates (DFS meets deep
candidates first). Revision: top-k replacement uses the full §3.2 comparator;
the pruning rule becomes `oe ≤ θ or (full and oe < θ_now)` (strict at θ_now,
since a tie at θ_now can still displace by order; proof in §3.4). Revised
before any pruning algorithm or pruning gate exists (ratchet-compliant:
consistency fix, not a response to a failing gate). Alternative (keep
quality-strict replacement, reference parity) rejected: makes §3.3 undefined
as a set and results evaluation-order-dependent.

## 2026-07-11 — BatchEvaluator seam + recompute-over-store covers (M4, A12)

The only backend abstraction is `BatchEvaluator` (BRIEF §10): tuple batches
(flattened ascending selector-id tuples) and extension batches (one parent
cover + extension ids) → per-candidate statistics in transferable SoA typed
arrays. Backends never compute qualities; one shared scorer per task turns
statistics into quality/estimate in f64 centrally (bit-identical across
engines; workers/GPU return the same statistics in M6). Covers are
recomputed as AND-chains (tuple batches share AND-prefixes across
lex-consecutive candidates; dfs/bestFirst re-AND at descent/expansion) —
never stored per candidate (BRIEF §9). Cover caching under a byte budget
(A12 alternative) is deferred to M6 where it can be measured against the
2M-row tasks; at depth ≤ 3 the AND-chain is ≤ 2 extra word-wise ANDs per
candidate and the prefix-sharing already removes most of that on apriori's
lex-ordered levels.

## 2026-07-11 — Apriori prunes on the level-final threshold; join subset check (M4)

Survivor marking (extendability) happens once per level AFTER every
candidate of the level was offered to the top-k, using the then-final θ_now
— deterministic regardless of evaluation order within the level (workers in
M6 shard levels arbitrarily), and tighter than any mid-level threshold.
Alternative (prune during evaluation with the running θ_now) rejected:
order-dependent pruned-counts and no observable benefit at level
granularity. The ℓ+1 join generates from survivor pairs sharing an
(ℓ−1)-prefix and additionally requires all other ℓ-subsets to be survivors —
sound for exactness because a candidate with a culled ℓ-subset is that
subset's refinement (§3.4/monotone-skippable); completeness argument in
spec §7.5.

## 2026-07-11 — Reference harness reads CSVs with float_precision="round_trip" (M4)

pandas' default C-engine float parser (xstrtod) is not correctly rounded:
on synth:na-stress it parsed the CSV literal "-0.19395041234919444" to a
f64 one ulp away from the correctly-rounded value, shifting an
equal-frequency cutpoint and making one differential top-k key mismatch
(identical 2-digit display, different full-precision bound). The CSV bytes
are the ground truth both sides must read identically; JS `Number()` and
Python's own float() are correctly rounded, pandas offers
float_precision="round_trip" for exactly this. Applied to every
`gen_differential_fixtures.load_dataset` read; regenerating fixtures
changed NOTHING for titanic/credit-g/adult cells (elapsed_seconds noise
only — their cutpoints were never affected), fixed the synth cell. Harness
correction, not a comparison loosening; fixtures regenerated by the
generator per BRIEF §21.

## 2026-07-11 — patternTree merge algebra: integer statistics only (M5, A9)

patternTree ships for binary/FI targets (mergeable size/positives — integer
sums, order-independent, qualities bit-identical to the oracle) and rejects
numeric/EMM targets with a typed error. A9's fuller vocabulary (Σ-vectors,
EMM sufficient stats) was considered and deliberately excluded for v1:
f64 tree-order merges are not associative at ulp level, so tree-merged sums
would break the §7 bit-identical-quality guarantee and require a
conservative re-scoring band (the M6 GPU machinery) to keep §6.2 exactness;
meanwhile the reference's own gp hooks cover exactly
StandardQF/CountQF/AreaQF (numeric targets have none) and its EMM gp path
materializes cover arrays, defeating pure merging. Roadmap notes the banded
Σ-vector extension. FI targets additionally require θ ≥ 0 or minSupport ≥ 1
(zero-cover candidates are C(S,d) members a frequency tree never
materializes; binary needs no guard — empty covers are NaN).

## 2026-07-11 — generalizingBFS: exact best-first replaces the reference's fudge (M5)

The reference's GeneralisingBFS is untested (`pragma: no cover`), prunes
cover-growing refinements with the SUBSET-cover estimate divided by
1.1^(depth+1) — inadmissible in both directions — and prints diagnostics.
subgroup-web defines the space D(S, d) (disjunctions of ≤ depth distinct
selectors, spec §7.11) and runs the §7.7 best-first walk with OR-covers
pruned by `generalizationEstimate` (admissibility proof for standard(a),
a ∈ [0,1], in spec §7.11), exact for every QF (pruning disengages without a
safe generalization bound). Monotone-constraint subtree pruning is disabled
in this walk: `isMonotone` is a conjunction-refinement property; under
cover-growing refinement a minSupport violator's refinements can satisfy
it. Exactness gated against exhaustive(form: 'disjunction') with pruning
on/off across the matrix.

## 2026-07-11 — beamSearch determinization choices (M5, A13)

Spec §7.8 pins: beam membership under the §3.2 canonical order (replacing
quality-heap tie artifacts); `adaptive` ⇒ width = k; the empty conjunction
is expansion root only (ADJ-002); each description evaluated at most once
per run (canonical-key dedup) — the reference dedups only against current
beam content, so displaced descriptions can re-enter via another parent and
re-expand; that re-entry is an insertion-order-dependent heap artifact and
is deliberately dropped. Result = first k of the final beam ≡ first k of
all offered candidates (beam holds the best w ≥ k offered, same order).
Machine-checked against an independent executable mirror of §7.8 at widths
{1, 20, adaptive} plus the w ≥ |C(S,d)| ≡ oracle degenerate gate.
