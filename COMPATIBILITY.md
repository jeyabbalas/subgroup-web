# COMPATIBILITY.md — adjudicated divergence ledger

This file records every **adjudicated divergence** between subgroup-web and
the pinned reference implementation `pysubgroup==0.9.0` (BRIEF §6.3). The gate
is **zero unadjudicated divergences**: every divergence the differential
runner finds must reference an adjudication id below, or `pnpm gate` fails.

Each adjudication carries:

- a minimal runnable Python repro committed under `reference/repros/`
  (runs green under `uv run`, i.e. reproduces the reference behavior),
- an analysis against `docs/spec.md` with citations,
- the spec-correct behavior subgroup-web implements,
- a classification: **(b)** reference bug/inconsistency or
  **(c)** representational difference.

Adjudication ids follow the pattern `ADJ-NNN-slug` and are machine-checked
against the differential runner's divergence records by `scripts/reports.mjs`.

---

### ADJ-001-candidate-space-same-attribute

- **Classification:** (b) reference internal inconsistency.
- **Repro:** `reference/repros/adj_001_candidate_space.py` (uv run, asserts pass).
- **Reference behavior:** pysubgroup's algorithms enumerate *different*
  candidate spaces. `Apriori` (algorithms.py:277–295, prefix-join over sorted
  selector tuples) and `SimpleSearch` (algorithms.py:602,
  `combinations(search_space, r)`) enumerate **all** ≤-depth subsets of
  distinct selectors, including same-attribute combinations. `DFS` and
  `BestFirstSearch` refine through `StaticSpecializationOperator`
  (refinement_operator.py:24–54), which groups selectors by attribute and only
  extends with attributes strictly after the last selector's group — at most
  one selector per attribute. The repro constructs a task whose true depth-2
  optimum is `NOT c=='a' AND NOT c=='b'` (WRAcc 0.225): Apriori/SimpleSearch
  find it, DFS's best reachable is 0.115.
- **Spec decision (docs/spec.md §3.1):** the candidate space is all
  conjunctions of 1..depth **distinct selectors** with no same-attribute
  restriction — the Apriori/SimpleSearch space. It is strictly more expressive
  (multi-negation and overlapping one-sided intervals are useful and not
  otherwise expressible), and Apriori is the reference's flagship algorithm.
  Every subgroup-web algorithm (including `dfs`, `bestFirst`) is exact over
  this one space.
- **Differential mapping:** subgroup-web `dfs`/`bestFirst` results are
  compared against reference `Apriori` fixtures (same space), not against
  reference `DFS`/`BestFirstSearch`, whose space is a strict subset.

### ADJ-002-empty-conjunction

- **Classification:** (b) reference internal inconsistency.
- **Repro:** `reference/repros/adj_002_empty_conjunction.py`.
- **Reference behavior:** `SimpleDFS` (algorithms.py:674–689) and `DFSNumeric`
  (algorithms.py:854–857) evaluate and can return the empty description
  `Dataset`; `BeamSearch` seeds its beam with `(0, Conjunction([]), stats)`
  where the quality 0 is hardcoded, never evaluated (algorithms.py:531–573),
  and can return it after the final trim. `Apriori`, `SimpleSearch`, and
  `BestFirstSearch` never evaluate it. The repro shows SimpleDFS returning
  `Dataset` while Apriori on the identical task does not.
- **Spec decision (docs/spec.md §3.1):** the empty conjunction is **not** a
  candidate: descriptions have 1..depth selectors. (The empty description is
  the trivial "whole dataset" answer; WRAcc-family qualities are identically 0
  on it, and the reference's most-used algorithms exclude it.)
- **Differential mapping:** any `Dataset` row in a reference fixture is
  dropped before comparison and flagged with this adjudication id.

### ADJ-003-negation-covers-na

- **Classification:** (b) reference bug w.r.t. its own effective NA policy
  (equality and interval selectors treat NA as unsatisfiable; negation does
  not).
- **Repro:** `reference/repros/adj_003_negation_na.py`.
- **Reference behavior:** `NegatedSelector.covers` is
  `np.logical_not(inner.covers(data))` (subgroup_description.py:332). NA rows
  fail every comparison, so the inner cover is False and the negation is True:
  `NOT x=='v'` **covers** rows where x is missing. A subgroup described by a
  negation thus silently includes rows about which the description says
  nothing.
- **Spec decision (docs/spec.md §1.2, per BRIEF §5.1):** NA satisfies **no**
  selector — equality, interval, or negation:
  `cover(¬s) = validRows(attribute(s)) \ cover(s)`. `isNull(attr)` is the only
  selector covering NA rows, and `¬isNull(attr)` covers exactly the non-NA
  rows (consistent under the same rule).
- **Differential mapping:** negation cells over NA-bearing attributes are
  compared through the spec-side semantics; where the reference's top-k
  differs only through NA rows covered by negations, the divergence cites this
  id. NA-stress fixtures exercise the difference explicitly.

### ADJ-004-numeric-empty-quality

- **Classification:** (b) reference bug.
- **Repro:** `reference/repros/adj_004_numeric_empty_quality.py`.
- **Reference behavior:** `StandardQFNumeric.calculate_statistics` substitutes
  centroid 0 for an empty cover (numeric_target.py:335-345), so an empty
  subgroup evaluates to `0**a * (0 − μ0)`: quality **0.0** for a > 0 and
  **−μ0** for a = 0 (an arbitrary value that is *positive* whenever the target
  mean is negative). `StandardQFNumericTscore` returns int 0 through an
  array-truthiness accident (numeric_target.py:739-752). With the task default
  `min_quality = −inf`, such empty subgroups **enter result sets** (repro
  shows `SimpleSearch` returning `c=='a' AND c=='b'`), and the reference's own
  statistics table then crashes on them (`np.max([])`).
- **Spec decision (docs/spec.md §5.5):** the mean/median/std of an empty set
  is undefined; every numeric-family quality of an empty subgroup is **NaN**,
  which never enters results (§3.3 strict `> θ` is false for NaN). This
  matches the reference's own binary-target convention
  (`StandardQF.standard_qf` returns NaN at n = 0).
- **Differential mapping:** fixture rows whose description has `cover_size: 0`
  under a numeric target cite this id; reference values 0.0/−μ0/0 vs
  subgroup-web NaN.

### ADJ-005-invert-ignored

- **Classification:** (b) reference bug (dead parameter).
- **Repro:** `reference/repros/adj_005_invert_ignored.py`.
- **Reference behavior:** `StandardQFNumeric(a, invert=True)` stores the flag
  and never reads it; `utils.conditional_invert` has zero callers in 0.9.0.
  `invert=True` evaluates identically to `invert=False` (repro asserts
  equality). Earlier pysubgroup versions negated the quality; the behavior was
  lost in refactoring.
- **Spec decision (docs/spec.md §6.3):** `invert: true` evaluates the QF on
  the negated target: q = n^a · (μ0 − m), with estimator tails mirrored
  (below-centroid); verified by the metamorphic identity
  standardNumeric(a, invert) on T ≡ standardNumeric(a) on −T
  (test/spec/qf-invert-metamorphic.test.ts).
- **Differential mapping:** every fixture row of an `invert: true` QF block
  (`adjAllRows`) cites this id where values differ (they differ exactly when
  the quality is nonzero).

### ADJ-006-emm-degenerate-fit

- **Classification:** (b) reference bug.
- **Repro:** `reference/repros/adj_006_emm_degenerate_fit.py`.
- **Reference behavior:** `PolyRegression_ModelClass.fit` guards only
  n ≤ degree+1 (model_target.py:286-287). For a subgroup with **zero
  x-variance** (n > 2), `np.polyfit`'s Vandermonde matrix is rank-deficient:
  numpy emits a RankWarning and returns the minimum-norm least-squares
  solution — one arbitrary line among infinitely many optima — and
  `EMM_Likelihood` reports a finite quality for an unidentifiable model
  (repro: β = [0.625, 1.25], quality ≈ 0.0085 on x ≡ 2).
- **Spec decision (docs/spec.md §5.4):** the degree-1 fit is undefined when
  `n·Σxx − (Σx)² = 0`; β = NaN and the quality is NaN (excluded from
  results), consistent with the reference's own small-sample guard.
- **Differential mapping:** EMM fixture rows flagged
  `ADJ-006-emm-degenerate-fit` (generator detects constant x over the cover).

### ADJ-007-max-estimator-overprune

- **Classification:** (b) reference bug (inadmissible optimistic estimate)
  plus internal inconsistency between the reference's own Apriori paths.
- **Repro:** `reference/repros/adj_007_max_estimator_overprune.py`.
- **Reference behavior:** the Max/'average' numeric estimator returns **−inf**
  when a subgroup has no target value above the dataset centroid
  (numeric_target.py:505-506). An optimistic estimate must upper-bound every
  refinement's quality; refinements there have finite qualities (≤ 0), which
  belong in the result while the top-k is unfilled under the default
  `min_quality = −inf`. The non-vectorized Apriori prunes them (strict
  `estimate > min_quality`, algorithms.py:188-194) — the repro shows it
  dropping `c1==1 AND c2==1` (quality −4.5) — while the vectorized path
  (`>=`, algorithms.py:233-235) and SimpleSearch keep it: the reference
  disagrees with itself on the same task.
- **Spec decision (docs/spec.md §6.3):** the admissible closure oe = 0 when
  the above-centroid tail is empty (every refinement quality is ≤ 0 there);
  subgroup-web's exact algorithms prune only with admissible estimates, and
  the pruning-identity gate (§6.2) proves results unaffected.
- **Differential mapping:** estimates are not differentially compared; result
  cells that the reference's over-pruning affects cite this id.

### ADJ-008-combined-not-implemented

- **Classification:** (b) reference bug (feature removed/broken).
- **Repro:** `reference/repros/adj_008_combined_not_implemented.py`.
- **Reference behavior:** `CombinedInterestingnessMeasure.__init__` raises
  `NotImplementedError` unconditionally (measures.py:46-57, "FIX ME: This is
  currently not working anymore"); the feature is unusable in 0.9.0, so no
  differential fixture can exist.
- **Spec decision (docs/spec.md §6.9):** subgroup-web implements the dead
  code's documented intent: q = Σ wᵢ·qᵢ(sg); optimistic estimate = Σ wᵢ·oeᵢ
  when every member is estimable and all wᵢ ≥ 0 (a nonnegative combination of
  admissible bounds is admissible).
- **Differential mapping:** none possible; correctness rests on micro-fixtures
  and the §6.2 exactness gates.

### ADJ-009-ga-numeric-order-dependent

- **Classification:** (b) reference bug (same description, different quality).
- **Repro:** `reference/repros/adj_009_ga_numeric_order.py`.
- **Reference behavior:**
  `GeneralizationAware_StandardQFNumeric.aggregate_statistics`
  (numeric_target.py:813-835) picks the generalization maximizing
  `max(centroid(agg), centroid(stat))` under strict `>` with seed 0.0, then
  uses the picked tuple's **own** centroid in the quality. When several
  generalizations tie (e.g. all their means are below μ0, so each pair ties at
  μ0 through its aggregate), the first pair in `combinations(selectors, k−1)`
  order wins — i.e. **construction order** of the conjunction decides the
  quality: the repro evaluates the same description as [A,B] (−0.2391) and
  [B,A] (−0.0832). Additionally, when every candidate centroid is ≤ 0 the
  seed leaves `max_stats = None` and evaluation crashes (AttributeError).
- **Spec decision (docs/spec.md §6.8):** conjunctions are canonical (§2.3);
  generalizations iterate in the reference's combinations order over the
  **canonical** selector sequence (drop-last-first), reproducing the reference
  wherever its conjunction was built in canonical order and deterministic
  everywhere; the seed is −inf, which agrees with the reference wherever the
  reference terminates and picks the true argmax where it would crash.
- **Differential mapping:** GA-numeric fixture rows whose reference
  conjunction was constructed in non-canonical order cite this id.

### ADJ-010-negated-interval-str-crash

- **Classification:** (b) reference bug.
- **Repro:** `reference/repros/adj_010_negated_interval_str.py`.
- **Reference behavior:** `NegatedSelector.__str__` forwards
  `(open_brackets, closing_brackets)` to the inner selector's `__str__`
  (subgroup_description.py:338-340), but `IntervalSelector.__str__` accepts no
  arguments → TypeError. `str()` of NOT-over-interval crashes: the reference's
  display dialect cannot express negated intervals, and any result printing or
  fixture export containing one dies.
- **Spec decision (docs/spec.md §2.4):** subgroup-web prints `NOT <str>`
  uniformly. No differential mapping is possible (the reference raises instead
  of producing a string); negation differential cells restrict to nominal
  selectors.

---

## Mapping rules (class (c) representational differences)

### MAP-001-tie-groups

The reference's result order and boundary-tie cuts are heap artifacts
(`add_if_required` on `(quality, subgroup)` tuples; BRIEF §22-A1); subgroup-web
uses the canonical total order (spec §3.2). Differential top-k comparisons
therefore compare **quality groups**: every complete group must match as a set
of canonical descriptions with qualities within rel 1e-9 (spec §6.11); the
final (possibly cut) group must match in size and group quality, and every
reference member of it must re-evaluate (under subgroup-web semantics) to
exactly the group quality — proving both sides return a valid top-k modulo
tie order. Implemented in test/differential/topk-differential.test.ts.
