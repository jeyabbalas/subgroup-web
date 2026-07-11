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

The result set is §3.3's *first k under the §3.2 order* — so a candidate
tying the current k-th quality can still enter (displacing on depth/key), and
replacement inside top-k structures MUST use the full §3.2 comparator, not
quality alone. (Revised in M3 for internal consistency: the M1 text's
"strict > for replacement" parenthetical contradicted §3.3's definition and
would have made results depend on evaluation order across algorithms —
DECISIONS.md 2026-07-11. The reference's quality-strict `add_if_required`
heap is exactly such an evaluation-order artifact, BRIEF §22-A1; differential
comparisons stay tie-tolerant.)

Pruning rule: an optimistic estimate oe(c) may prune candidate c's
refinements iff

  oe(c) ≤ θ  or  (result full and oe(c) < θ_now)

where θ = task minQuality and θ_now = the k-th result's quality. Soundness:
refinement qualities are ≤ oe(c); membership requires quality > θ (strict,
§3.3), so oe ≤ θ excludes them; when full, a refinement can only displace if
its quality ≥ θ_now, i.e. pruning strictly below θ_now is safe — a tie AT
θ_now may displace by order, hence strict `<` (deliberately weaker than the
reference's `oe > θ_now` keep-rule, which over-prunes order-displacing ties
under its own heap semantics and is inconsistent between its Apriori paths,
ADJ-007).

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

## 5. Targets and statistics (M2)

Notation: N = dataset row count; n = subgroup size (cover cardinality);
P = dataset positives, p = subgroup positives (binary target); μ0 = dataset
mean of the numeric target, m = subgroup mean. All statistics are computed in
f64; long summations use pairwise (tree) summation like numpy's `np.add.reduce`
(agreement gate rel ≤ 1e-9, §6.3 of BRIEF).

### 5.1 Binary target

`binary({attribute, value})` ≡ `binary(equality(attribute, value))`; the
positives vector is the target selector's cover (§1.2 NA policy: NA rows are
never positive). Validation: the attribute must exist; P is not required to be
non-degenerate except by χ² (§6.3).

13 statistic fields (names + formulas pinned from binary_target.py:29-43,
149-172); division follows IEEE-754 (0/0 = NaN), matching numpy:

| field | value |
|---|---|
| size_sg | n |
| size_dataset | N |
| positives_sg | p |
| positives_dataset | P |
| size_complement | N − n |
| relative_size_sg | n / N |
| relative_size_complement | (N − n) / N |
| coverage_sg | p / P |
| coverage_complement | (P − p) / P |
| target_share_sg | p / n (NaN when n = 0) |
| target_share_complement | (P − p) / (N − n), **NaN when n = N** (explicit reference guard, binary_target.py:163-168) |
| target_share_dataset | P / N |
| lift | target_share_sg / target_share_dataset |

### 5.2 Numeric target

`numeric(attribute)` over a numeric column. **Validation (spec-level,
BRIEF §5.5): the target column must contain no NA and no ±∞** — the reference
silently propagates NaN through every mean (making all qualities NaN) and
crashes on `np.max` of empty selections; subgroup-web raises a typed
`ValidationError` instead (documented deviation; unreachable in differential
fixtures because such tasks produce no usable reference output).

14 fields (numeric_target.py:23-38, 109-125): size_sg, size_dataset, mean_sg,
mean_dataset, std_sg, std_dataset, median_sg, median_dataset, max_sg,
max_dataset, min_sg, min_dataset, mean_lift = mean_sg/mean_dataset,
median_lift = median_sg/median_dataset.

- std is the **population** standard deviation (`np.std`, ddof 0), two-pass
  (mean, then mean of squared deviations).
- median: ascending sort; odd count → middle element; even → arithmetic mean
  of the two middle elements (`np.median`).
- Empty subgroup (n = 0): mean/std/median/min/max_sg and both lifts are NaN
  (the reference *crashes* on `np.max([])`; class (c) — unreachable in
  fixtures, see §5.5).

### 5.3 Frequent-itemset target

`frequentItemset()`. statistic fields: size_sg, size_dataset
(fi_target.py:23). No target attributes.

### 5.4 EMM poly-regression target

`emm(polyRegression(xAttr, yAttr, degree = 1))` — degree 1 only, like the
reference (model_target.py:168-169). Sufficient statistics per subgroup:
(n, Σx, Σy, Σxx, Σxy) — mergeable; Σyy additionally kept for future model
classes. Fit (least squares through the normal equations, ≡ `np.polyfit`
degree 1 on non-degenerate input):

  D = n·Σxx − (Σx)²;  slope = (n·Σxy − Σx·Σy) / D;  intercept = ȳ − slope·x̄

Degenerate-fit guard (BRIEF §22-A11): if n ≤ degree + 1 (i.e. ≤ 2) **or**
D = 0 (zero x-variance), β = (NaN, NaN). The reference returns NaN for
n ≤ 2 (model_target.py:286-287) but on D = 0 silently returns numpy's
minimum-norm least-squares solution with a RankWarning; the spec treats a
non-identifiable model as undefined (ADJ-006).

Statistic fields exposed on results: size_sg, size_dataset, slope, intercept,
mean_sg (of likelihood contributions) — see src/targets/emm.ts.

Validation: x and y columns numeric, NA-free, finite (reference: NaN input
makes `np.polyfit` raise `LinAlgError: SVD did not converge`).

### 5.5 Empty-subgroup and degenerate conventions (normative)

For a candidate description with empty cover (n = 0):

| QF family | subgroup-web | reference behavior |
|---|---|---|
| standard(a) family (binary) | NaN | NaN (binary_target.py:504-507) — agrees |
| chiSquared | −inf (minInstances guard) | −inf when minInstances ≥ 1; crashes in scipy when minInstances = 0 — spec: −inf for n < max(1, minInstances) |
| standardNumeric / tscore / median | **NaN** (mean of nothing is undefined) | numeric_target.py:335-345 substitutes centroid 0 → quality 0 for a > 0, −μ0 for a = 0; tscore returns 0 — **ADJ-004** |
| count / area | 0 | 0 — agrees |
| emmLikelihood | NaN | NaN — agrees (NaN β propagates) |

NaN qualities never enter result sets: membership requires quality > θ (§3.3)
and NaN compares false. This is exactly the reference's effective behavior for
NaN (`add_if_required` gate `quality >= min_quality` is false for NaN).

## 6. Quality functions (M2)

Every QF has: `evaluate` from per-subgroup statistics + constant (dataset)
statistics; where defined, `optimisticEstimate` — an **admissible** upper
bound on the quality of the subgroup *and every refinement of it* (subset
cover, depth ≤ task depth), the property the §3.4 pruning rule and the §6.1
admissibility property suite rely on.

### 6.1 standard(a) — binary

q_a(sg) = (n/N)^a · (p/n − P/N), a ∈ [0, 1]; NaN when n = 0
(binary_target.py:488-510). Aliases: wracc() = standard(1),
simpleBinomial() = standard(0.5), lift() = standard(0). (Klösgen 1996;
Lemmerich & Becker 2018.)

Optimistic estimate (tight, standard closed form): keep exactly the positives,
oe = (p/N)^a · (1 − P/N) (binary_target.py:545-565). Admissible for a ∈ [0,1]:
any refinement R has p_R ≤ p, n_R ≥ p_R, so
(n_R/N)^a (p_R/n_R − P/N) ≤ (p_R/N)^a (1 − P/N) ≤ (p/N)^a (1 − P/N)
(monotone in p_R; the first step maximizes the share term at n_R = p_R,
noting the quality is ≤ 0 otherwise while oe ≥ 0). Empty subgroup: oe = 0
when p = 0 — still admissible (all refinements are empty → NaN, never enter
results).

Generalization estimate (used by generalizingBFS, reference
`optimistic_generalisation`, binary_target.py:567-588):
og = ((n + (P − p))/N)^a · (1 − P/N) — grow the subgroup by all remaining
positives.

### 6.2 chiSquared({direction, minInstances = 5, stat})

2×2 contingency of (subgroup, complement) × (positive, negative), **without
Yates continuity correction** — pinned from the reference's
`scipy.stats.chi2_contingency(..., correction=False)`
(binary_target.py:358-364).

Guard: if n < minInstances or N − n < minInstances → −inf (both stats;
binary_target.py:348-351). Spec addition: n = 0 or n = N → −inf regardless
(scipy would raise on a zero marginal; unreachable for minInstances ≥ 1).
Validation: 0 < P < N required at task setup (else the χ² table is degenerate
and the reference crashes in scipy).

Statistic (computed like scipy: expected = row·col/N, χ² = Σ(o−e)²/e over the
four cells, row-major order):
  e11=(p̂·n)/N-style expansion with p̂ = P, i.e. expected =
  [[n·P/N, (N−n)·P/N], [n·(P−...)]] — concretely, with
  a = p, b = P − p, c = n − p, d = (N − n) − (P − p):
  χ² = Σ (obs − exp)² / exp, exp(row i, col j) = rowSum_i · colSum_j / N.

stat 'chi2' → the statistic; stat 'pValue' (reference 'p') → the dof-1 upper
tail probability p = Q(0.5, χ²/2) (regularized upper incomplete gamma)
= erfc(√(χ²/2)), implemented in-house (§6.10, BRIEF §22-A6). Note the
reference *maximizes* the returned value; with stat 'pValue' this prefers
insignificance — faithful, documented quirk.

direction 'both' → value as-is; 'positive' → value if p/n > P/N else −value;
'negative' → value if p/n < P/N else −value (binary_target.py:365-373).

No optimistic estimate (reference TODO agrees).

### 6.3 standardNumeric(a, {invert = false, estimator = 'sum'}) — mean centroid

q_a(sg) = n^a · (m − μ0) — **absolute** size power, not n/N
(numeric_target.py:188-202). invert = true ⇒ q_a(sg) = n^a · (μ0 − m),
exactly the QF applied to the negated target; **the reference accepts
`invert` and ignores it** (constructor stores it; no code path reads it —
`conditional_invert` in utils.py:151 has zero callers in 0.9.0) — **ADJ-005**.

Empty subgroup: NaN (§5.5, ADJ-004).

Optimistic estimates (Lemmerich dissertation §4.2.2.1; invert mirrors on −T):

- **'sum'** (default; Theorem 2, p. 81): oe = Σ_{x ∈ sg, T(x) > μ0} (T(x) − μ0)
  (numeric_target.py:362-435). Always ≥ 0. Admissible for a ∈ [0, 1]:
  for R ⊆ sg with m_R > μ0, q(R) = n_R^{a−1} · Σ_{x∈R}(T−μ0) ≤
  Σ_{x∈R}(T−μ0) ≤ oe (n_R^{a−1} ≤ 1); for m_R ≤ μ0, q(R) ≤ 0 ≤ oe.
  For a > 1 the bound does not hold in general; exact algorithms refuse to
  prune with it for a > 1 (documented applicability).
- **'average' / 'max'** (Theorem 4, p. 82; the reference maps 'average' to its
  Max estimator, numeric_target.py:262-267): with n₊ = |{x ∈ sg : T(x) > μ0}|
  and T⁺max = max of those values: oe = n₊^a · (T⁺max − μ0) if n₊ > 0.
  **Spec closure: oe = 0 when n₊ = 0** — every refinement then has m_R ≤ μ0
  hence q(R) ≤ 0; the reference returns −inf (numeric_target.py:505-506),
  which under-estimates refinements with quality exactly 0 or negative-but-
  eligible (min_quality = −inf, unfilled result set) — reference over-pruning,
  adjudicated as **ADJ-007** when a differential cell exposes it.
  Admissibility (a ∈ [0,1]): for R with m_R > μ0,
  q(R) = n_R^{a−1}·Σ_{x∈R}(T−μ0) ≤ n_R^{a−1}·n₊(R)·(T⁺max(R) − μ0)
  ≤ n₊(R)^a·(T⁺max(R) − μ0) ≤ oe (n_R ≥ n₊(R), a−1 ≤ 0).
- **'order'** (numeric_target.py:513-621): sort the subgroup's values
  descending (v₁ ≥ v₂ ≥ …); oe = max_j j^a · (mean(v₁..v_j) − μ0).
  Tight and admissible for any a ≥ 0: the best refinement of size j has at
  most the j largest values' mean. Cost O(n_sg) per candidate given the
  precomputed descending permutation of the dataset.

### 6.4 standardNumericMedian(a, {estimator = 'average'})

The reference's `StandardQFNumeric(a, centroid='median')`
(`StandardQFNumericMedian` itself is deprecated and raises,
numeric_target.py:641-648): q = n^a · (median_sg − median₀). Estimators:
'average'/'max' only (median + 'order' raises NotImplementedError in the
reference; same restriction here), computed against the **median**:
oe = n₊^a·(T⁺max − med₀), n₊ = |{x > med₀}|, spec closure at n₊ = 0 as in
§6.3. Admissibility for the median centroid (a ∈ [0,1]): for any R,
median_R ≤ max(R) ≤ T⁺max(R ∩ {x > med₀}) whenever median_R > med₀, and
n₊(R) ≥ … — proof mirror of §6.3 with median_R − med₀ ≤ T⁺max − med₀ and
n_R^a ≥ n₊(R)^a not needed: q(R) = n_R^a(median_R − med₀) requires care
because n_R may exceed n₊(R) while median_R > med₀ requires more than half of
R above med₀, so n₊(R) > n_R/2, giving n_R^a < (2·n₊(R))^a ≤ 2^a·n₊(R)^a;
2^a·n₊^a·(median_R − med₀) can exceed n₊^a(T⁺max − med₀)?? — no: the spec
uses the **safe form oe = n_sg^a · (T⁺max − med₀)** (n_sg ≥ n_R ≥ n₊(R),
median_R ≤ T⁺max for median_R > med₀), which dominates the reference's
n₊-based estimate and is admissible by n_R ≤ n_sg monotonicity. The
reference's own estimate is *not* admissible for the median centroid
(counterexample in test/spec/qf-numeric.test.ts); subgroup-web's exact
algorithms prune only with the safe form — divergence class (b), **ADJ-007**
family, diagnostic only (the reference's default centroid is mean).

### 6.5 standardNumericTscore({invert})

t(sg) = √n · (m − μ0) / s_sg, population s; 0 when s_sg = 0
(numeric_target.py:658-674); NaN when n = 0 (spec; reference returns 0 via an
array-truthiness accident, numeric_target.py:739-752 — ADJ-004). No useful
optimistic estimate (reference sets +inf; subgroup-web exposes none).

### 6.6 count() / area() — FI target

count: q = n; oe = n (refinement covers shrink — admissible;
fi_target.py:180-214). area: q = n · depth(sg) (fi_target.py:217-237);
oe = n · maxDepth(task) (spec-added, admissible: refinements have size ≤ n
and depth ≤ task depth; the reference exposes none — results unaffected,
pruning-identity gate proves it).

### 6.7 emmLikelihood(polyRegression(x, y, 1))

Fit β on the subgroup (§5.4). Per-row likelihood ℓ_i = φ(r_i), the standard
normal pdf of the residual r_i = (β₁ + β₀·x_i) − y_i, φ(r) = e^{−r²/2}/√(2π)
(model_target.py:293-309 — `norm.pdf`, **not** log). Quality =
mean(ℓ over sg) − mean(ℓ over complement); NaN when n = 0, n = N, or β is
NaN (model_target.py:79-111). No optimistic estimate.

### 6.8 generalizationAware(qf) and gaStandard(a) / gaStandardNumeric(a)

- Generic wrapper (measures.py:197-246): q_ga(sg) = q(sg) − max(0,
  max_{g ⊊ sg} q(g)) where g ranges over **all** strict generalizations
  including the empty description (whose quality is q(∅), e.g. 0 for WRAcc;
  the 0 floor is the reference's `max_q = 0` seed). Cache keyed by canonical
  description.
- gaStandard(a) (binary_target.py:638-698, strategy 'difference' default):
  q = (n/N)^a · (p/n − τ_max), τ_max = max share over all strict
  generalizations (recursive aggregate `max_p`; empty pattern contributes
  P/N). Optimistic estimate (difference strategy,
  binary_target.py:760-791): with Δneg = min over generalizations of
  (negatives(g) − negatives(sg)) aggregated recursively: pos = p (a = 1),
  1 (a = 0), else min(⌈a·Δneg/(1−a)⌉, p); τ_diff = pos/(pos + Δneg);
  oe = (p/N)^a · (1 − max(τ_diff, τ_sg, τ_max_gens)) … pinned from source;
  +inf when Δneg = +inf. Strategy 'max' implemented per source
  (binary_target.py:700-758).
- gaStandardNumeric(a) (numeric_target.py:770-835): q = (n/N)^a ·
  (m − max centroid over generalizations); aggregate = max over immediate
  generalization pairs of max(centroid(stat), centroid(agg)), seeded at 0.0
  (reference initialization — pinned as-is, including its 0.0 floor).

### 6.9 combined([{qf, weight}])

q = Σ w_i · q_i(sg); oe = Σ w_i · oe_i(sg), defined only when every member
exposes an estimate and every w_i ≥ 0 (admissible: nonnegative combination of
admissible bounds). **The reference's `CombinedInterestingnessMeasure` raises
NotImplementedError on construction in 0.9.0** (measures.py:46-57, "FIX ME:
This is currently not working anymore") — subgroup-web implements the
documented intent (the dead code's weighted dot product) — **ADJ-008**.

### 6.10 χ² tail probability (dof 1) — in-house special functions

p = P(X ≥ x) for X ~ χ²₁ = Q(1/2, x/2) = erfc(√(x/2)), computed via the
regularized incomplete gamma pair (Abramowitz & Stegun 6.5; Numerical Recipes
§6.2 regime split, iterated to < 1e-15 relative):

- x < a + 1: P(a,x) by the power series x^a e^{−x} Σ x^k / (a·(a+1)···(a+k)),
  Q = 1 − P;
- x ≥ a + 1: Q(a,x) by the Lentz continued fraction
  x^a e^{−x} / Γ(a) · 1/(x+1−a− 1·(1−a)/(x+3−a− 2(2−a)/(x+5−a−…))).

scipy computes the same function via Cephes `igamc`; both are ~1e-14-accurate
approximations of the same analytic function, so the differential gate
(rel ≤ 1e-9) binds. Verified against scipy on a fixed grid in the
differential formula fixtures. φ(r) uses `Math.exp(−r²/2)/√(2π)` with the f64
constant √(2π) = 2.5066282746310002, matching `scipy.stats.norm.pdf`.

### 6.11 Differential value agreement (normative for §6.3-BRIEF comparisons)

Two f64 quality values agree iff (a) both are NaN, or (b) both are the same
infinity, or (c) |ours − ref| ≤ 1e-9 · max(|ours|, |ref|), or (d)
|ours − ref| < 1e-15 (absolute floor for mathematically-zero quantities,
where relative comparison is meaningless — e.g. tie qualities and
near-cancelling likelihood differences of order 1e-21). Fixed before any
comparison gate ran (ratchet rule §21 of the BRIEF).

## 7. Algorithms (M3–M5)

### 7.1 Canonical candidate enumeration (M3)

The task's selector list is deduplicated (predicate identity §2.3) and sorted
by the §2.2 order once; candidates are ascending index tuples (i₁ < … < i_k)
over that sorted list, k = 1..d. The **canonical candidate order** is depth
ascending, then lexicographic ascending tuples; engines may traverse C(S, d)
in any order (the oracle uses prefix-DFS) because §3.3's result is
order-invariant, realized by the full-comparator top-k structure (§3.4).
Index-tuple lex order equals canonical-key lex order over the sorted list, so
tuples serve as comparison keys everywhere.

### 7.2 The exhaustive oracle (M3)

`exhaustive()` evaluates every candidate of C(S, d) with **no pruning** and
returns §3.3's top-k. Statistics per candidate come from two independent
paths — (1) row-scan masks over columns (src/desc/cover.ts semantics) and
(2) word-wise AND over the selector-bitset atlas — cross-checked per run
(BRIEF §6.1): sizes/positives must match exactly; f64 aggregates to
rel ≤ 1e-12 (summation-order difference only). Cross-check coverage is
`full` (every candidate) on fixtures ≤ `fullCrossCheckLimit` candidates, else
every result-set member plus every 64th candidate (deterministic stride,
documented in the gate row). The oracle is async, chunked (yields every
protocol batch), abortable, and reports progress like every §5.4 engine.

### 7.3 Constraints (M3)

`minSupport(count | fraction)` (monotone: cover size is anti-monotone under
refinement), `minQuality` (task field, §3.3), custom
`{ isSatisfied, isMonotone }`. Constraints gate result membership (the
reference checks them inside `add_if_required`); monotone constraints may
additionally prune refinements in optimized engines (M4) — never in the
oracle. A fraction minSupport resolves to `ceil(fraction · N)` rows at task
preparation.

### 7.4–7.8 (M4–M5) ☐

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
