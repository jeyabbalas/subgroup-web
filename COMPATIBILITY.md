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
