# subgroup-web — Executable Specification

**Status:** skeleton (M0). Filled in M1–M3; thereafter changed only under the
ratchet rule (BRIEF §21): definitions may be tightened freely; any loosening
requires a DECISIONS.md entry with literature/reference evidence, never in the
same turn a failing gate flips to passing.

This document is **normative for what the correct answer is** (BRIEF §6.1).
Where the pinned reference (`pysubgroup==0.9.0`) disagrees with this spec, the
spec wins and the divergence is adjudicated in COMPATIBILITY.md.

Sections marked ☐ are to be written in the milestone shown.

## 1. Data model (M1)

### 1.1 Columns

A `DataTable` is column-oriented; all columns share one row count. Column
kinds (BRIEF §5.1):

- **categorical** — `codes: Int32Array` indexing `categories` (values are
  strings, numbers, or booleans) in **first-appearance order**; code −1 = NA.
- **numeric** — `values: Float64Array`; `NaN` = NA. The flag
  `integerLike` records whether the reference would carry the column as an
  integer dtype (pandas int64): all values integral and no NA. It affects only
  number *formatting* in the reference dialect (§2.4), never semantics.
- **boolean** — `values: Uint8Array` (0/1) with optional NA mask (1 = NA).
  Booleans are *nominal* for space building (§4), mirroring pandas non-number
  dtypes (subgroup_description.py:543).

### 1.2 NA policy (normative)

Let `V(attr)` be the set of rows where `attr` is non-NA.

- `cover(equality(attr, v)) ⊆ V(attr)`: rows whose value equals v (strict
  same-type equality; a type-mismatched equality covers nothing).
- `cover(interval(attr, lo, hi)) ⊆ V(attr)`: rows with `lo ≤ x < hi`.
- `cover(isNull(attr))` = complement of `V(attr)` (the reference's
  `attr.isnull()`, an `EqualitySelector` with NaN value).
- `cover(negated(s)) = V(attribute(s)) \ cover(s)` — **NA satisfies no
  selector, including negations**. Consequence: `¬isNull(attr)` covers exactly
  `V(attr)`; `¬¬s ≡ s` (covers of value selectors are subsets of V).

The reference agrees for equality and intervals (NaN fails all pandas/numpy
comparisons) but **disagrees for negation**: `NegatedSelector.covers` is a raw
`logical_not` (subgroup_description.py:332), covering NA rows. Adjudicated as
**ADJ-003** (COMPATIBILITY.md) with repro `reference/repros/adj_003_negation_na.py`;
the spec behavior is deliberate: a description must only assert facts about
observed values (BRIEF §5.1 pins this policy).

### 1.3 fromCSV

Strict RFC-4180 subset: `,`-separated; LF/CRLF record breaks; `"`-quoted
fields with `""` escapes; quoted fields may contain commas, quotes, newlines;
ragged rows, stray quotes, bare CR are errors. No header-less mode. NA
tokens: exact-match against the pandas `read_csv` default NA set (documented
in `src/table/csv.ts`; overridable) — the canonical gate datasets are read by
pandas on the reference side and by this parser here, and both sides must
agree on missingness.

Type inference per column, in order: (1) all non-NA fields match
`/^[+-]?\d+$/` → numeric, `integerLike` iff no NA (pandas int64→float64
promotion); (2) all parse as finite decimal floats (incl. exponents) →
numeric; (3) all in {True,TRUE,true,False,FALSE,false} → boolean; (4) else
categorical. Per-column overrides may force a kind. Divergence from pandas
(documented): pandas additionally trims padded whitespace in numeric fields;
this parser is exact-match — the gate datasets contain no padded numerics.

## 2. Selectors and descriptions (M1)

### 2.1 Selector kinds

`equality(attr, value)`, `isNull(attr)`, `interval(attr, lo, hi)` with
**[lo, hi) left-closed right-open** and ±∞ allowed — pinned from
`IntervalSelector.covers`: `(val >= lo) & (val < hi)`
(subgroup_description.py:397-398) — and `negated(inner)`. Intervals require a
numeric column. `interval` constructors require `lo < hi`
(`IntervalSelector.__init__` asserts the same). Equality with a NaN value *is*
`isNull` (the reference encodes it that way; we normalize on construction).

### 2.2 Canonical total order over selectors

`attribute` (codepoint ascending; negation uses its inner's attribute) →
kind rank (equality 0 < isNull 1 < interval 2 < negated 3) → operands:
equality by value-type rank (boolean 0 < number 1 < string 2) then value
(false<true; numeric ascending; codepoint ascending); interval by (lo, hi)
ascending with −∞ < finite < +∞; negated recursively by inner. This order is
subgroup-web's own (deliberate improvement over the reference's
repr-string ordering, BRIEF §22-A1); differential comparisons are
quality-tolerant on ties (§3.3).

### 2.3 Conjunction canonical form

A conjunction is a **set** of selectors stored sorted by §2.2 and deduplicated
by predicate identity (display flags excluded). `depth` = selector count.
Empty conjunction covers all rows (reference parity: `Conjunction.covers`,
subgroup_description.py:737-741) but is not a search candidate (§3.1).

### 2.4 Reference string dialects

Two dialects, pinned from source (subgroup_description.py):

- **query** (= `repr`): full-precision numbers via CPython `str(float)`
  (shortest round-trip; `.0` on integral floats; sci form at exponent ≥16 or
  <−4 with ≥2 exponent digits); conjunction = `"(" + " and ".join(sorted by
  repr) + ")"`, empty `"True"`; negation `"(not <repr>)"`.
- **display** (= `str`): interval bounds through `"{0:.2f}"` **only when
  non-integral** (`if bound % 1:` — integral floats keep `str()` form "5.0",
  Python ints print bare "5"); conjunction = `" AND ".join(sorted by str)`,
  empty `"Dataset"`; negation `"NOT <str>"`.
- Selector forms: `attr=='v'` (strings), `attr==5` / `attr==5.0` / `attr==True`
  (int-ness from the column dtype), `attr.isnull()` (NaN), `attr is None`
  (None), `attr: [lo:hi[`, `attr<hi` (lo=−∞), `attr>=lo` (hi=+∞),
  `attr = anything` (both infinite).
- Known limitation (parser side): attribute names / string values containing
  `" AND "`, `" and "`, `"=="`, `">="`, `"<"`, or `": ["` are not
  round-trippable; no gate dataset contains such tokens.

`%.2f` rounding is correct rounding of the exact binary double with ties to
even (CPython `float.__format__`); implemented exactly via BigInt in
`src/util/pyfloat.ts` and verified against the pinned interpreter.

### 2.5 Disjunction / DNF

`Disjunction` covers the union of its selectors' covers (empty covers
nothing); `DNF` covers the union of its conjunctions' covers. Both are
evaluable and stat-computable (§5); **search operates over conjunctions**
(generalizingBFS over disjunctions, §7.8). Negation-over-NA follows §1.2 in
all composites.

## 3. Candidate space (M1; audited per BRIEF §22-A3)

### 3.1 The space (normative)

Given a task's deduplicated selector list S and depth d ≥ 1, the candidate
space is exactly

  C(S, d) = { conjunctions of k distinct selectors from S : 1 ≤ k ≤ d }

with **no same-attribute restriction** and **without** the empty conjunction.
Distinctness is predicate identity (§2.3). The reference's algorithms disagree
among themselves on both points — Apriori/SimpleSearch enumerate C(S, d);
DFS/BestFirstSearch cap at one selector per attribute; SimpleDFS/DFSNumeric/
BeamSearch additionally admit the empty conjunction — adjudicated as
**ADJ-001** and **ADJ-002** with repros. Every subgroup-web algorithm
(including the exhaustive oracle) enumerates exactly C(S, d).

### 3.2 Canonical result order (normative; §7 determinism)

Results (and any ranked frontier) are ordered by: quality **descending** →
depth **ascending** (shallower first) → canonical description **ascending**
(lexicographic over the §2.2-sorted selector key sequence). This is a total
order; it replaces the reference's heap artifacts (utils.py:577-617: heap on
`(quality, subgroup)` with repr-string tie order, then `sort(reverse=True)`
= quality desc, repr **desc** — insertion-order dependent at the boundary;
BRIEF §22-A1).

### 3.3 Top-k semantics and ties

`resultSetSize = k`, `minQuality = θ`: the result is the first k elements of
C(S, d) ∩ {quality > θ} under §3.2 (**strict** > θ, matching the reference's
final filter `tpl[0] > task.min_quality`, utils.py:86 — note its insertion
test uses ≥, so = θ candidates are inserted then dropped; net effect strict).
Boundary ties beyond position k are cut deterministically by §3.2 order.
Differential comparisons treat reference tie-groups as sets: rows with equal
quality (rel ≤ 1e-9) match if the description sets coincide after canonical
mapping.

### 3.4 Pruning threshold semantics (used from M4 on)

An optimistic estimate oe(c) may prune candidate c (and in level-wise/DFS
settings its refinements) iff `oe(c) <= θ_now`, where θ_now is the current
k-th best quality (or θ while fewer than k results). Soundness given §3.3:
a pruned candidate's refinements can at best TIE θ_now, and ties never enter
the result (strict > for replacement and > θ for membership). The reference
uses the same strict comparisons (algorithms.py:189-194, 685, 763).

## 4. Space builders (M1)

### 4.1 nominalSelectors

For each non-numeric column (table order, minus `ignore`): one selector per
unique value in **first-appearance order**, with NA (when present) yielding
`isNull(attr)` at NA's first-appearance position — mirroring `pd.unique`
including NaN (subgroup_description.py:553-575). Boolean columns are nominal.

### 4.2 numericSelectors

For each numeric column (table order, minus `ignore`), with `bins` (default
5), `intervalsOnly` (default true), `method` (default `equalFrequency`):

1. If the column has NAs: emit `isNull(attr)` **first**
   (subgroup_description.py:637-641).
2. Let U = unique non-NA values ascending. If U is empty: nothing further.
   If `|U| ≤ bins` (equalFrequency method only): one `equality(attr, u)` per
   u ∈ U ascending (subgroup_description.py:643-645).
3. Else compute cutpoints:
   - **equalFrequency** (reference walk, utils.py:110-129, BRIEF §22-A8): for
     i = 1..bins−1, position p = ⌊i·n/bins⌋ into the ascending non-NA
     multiset; while p < n and value[p] already chosen, p++; if p < n, choose
     value[p]. Duplicate quantiles thus collapse; a walk past the end
     contributes nothing; cutpoints are strictly increasing data values.
   - **equalWidth** (subgroup-web extension): min + i·(max−min)/bins,
     deduplicated.
   - explicit `number[]`: must be strictly ascending.
4. Emit: `intervalsOnly` → consecutive intervals (−∞,c₁), [c₁,c₂), …,
   [c_last,+∞) (subgroup_description.py:650-657); else per cutpoint c the
   pair [c,+∞) then (−∞,c) (subgroup_description.py:658-661).

### 4.3 allSelectors, removeTargetAttributes

`allSelectors` = nominal (column order) then numeric (column order)
(subgroup_description.py:506-522); errors on an empty result. Option
`negations: true` appends `negated(base)` for every base selector, in base
order (harness convention; the reference has no negation builder).
`removeTargetAttributes` drops selectors whose attribute (negation: inner's)
is any of the target's attributes.

## 5. Targets and statistics (M2) ☐

- 5.1 Binary target: 13 statistic fields, exact definitions.
- 5.2 Numeric target: 14 statistic fields.
- 5.3 Frequent-itemset target; 5.4 EMM poly-regression sufficient statistics.
- 5.5 Empty-subgroup conventions per statistic and per QF.

## 6. Quality functions (M2) ☐

- One subsection per QF: formula, parameters, optimistic estimate (+
  admissibility proof sketch or literature citation), constant statistics,
  empty/degenerate-case behavior.
- χ² statistic and tail probability (dof 1), continuity-correction decision
  pinned from the reference's scipy call (BRIEF §22-A6).

## 7. Algorithms (M3–M5) ☐

- Exactness classes (binding, BRIEF §5.4); per-algorithm applicability notes
  (dfsNumeric, BRIEF §22-A5); beamSearch full determinization (expansion,
  dedup, ties; BRIEF §22-A13); patternTree merge algebra (BRIEF §22-A9);
  generalizingBFS / generalization-aware caching (BRIEF §22-A10).

## 8. Backends and precision (M6) ☐

- CPU f64 statistics policy; pairwise summation; GPU f32 screening bands and
  CPU re-scoring (BRIEF §12/§22-A7).

## References

- Lemmerich, F. & Becker, M. (2018). pysubgroup: Easy-to-Use Subgroup
  Discovery in Python. ECML-PKDD.
- Atzmüller, M. (2015). Subgroup Discovery. WIREs DMKD 5(1).
- Lemmerich, F. (2014). Novel Techniques for Efficient and Effective Subgroup
  Discovery. Dissertation, Universität Würzburg.
- Klösgen, W. (1996). Explora: A Multipattern and Multistrategy Discovery
  Assistant.
- Han, J., Pei, J., Yin, Y. (2000). Mining Frequent Patterns without Candidate
  Generation. SIGMOD.
