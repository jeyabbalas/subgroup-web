# subgroup-web — Executable Specification

**Status:** skeleton (M0). Filled in M1–M3; thereafter changed only under the
ratchet rule (BRIEF §21): definitions may be tightened freely; any loosening
requires a DECISIONS.md entry with literature/reference evidence, never in the
same turn a failing gate flips to passing.

This document is **normative for what the correct answer is** (BRIEF §6.1).
Where the pinned reference (`pysubgroup==0.9.0`) disagrees with this spec, the
spec wins and the divergence is adjudicated in COMPATIBILITY.md.

Sections marked ☐ are to be written in the milestone shown.

## 1. Data model (M1) ☐

- 1.1 Column kinds: categorical (dictionary-encoded Int32 codes; code -1 = NA),
  numeric (Float64; NaN = NA), boolean (Uint8 + optional NA mask).
- 1.2 NA policy: **NA satisfies no selector** — equality, interval, or
  negation. `negated(sel)` covers exactly rows where the column is non-NA and
  `sel` does not cover them. Exception: the explicit NA-equality selector
  `isNull(attr)` covers exactly the NA rows (mirrors the reference's
  `attr.isnull()` selector). To verify against the reference in M1 (pandas
  semantics; BRIEF §22-A2) and adjudicate surprises.
- 1.3 fromCSV: strict RFC-4180 subset; type inference rules; NA tokens.

## 2. Selectors and descriptions (M1) ☐

- 2.1 Selector kinds and semantics; interval bound convention **[lo, hi)**
  (left-closed, right-open; ±∞ allowed) — pinned from the reference source
  (`IntervalSelector.covers`: `val >= lo & val < hi`).
- 2.2 Canonical total order over selectors (attribute, kind, operands).
- 2.3 Conjunction canonical form: sorted, deduplicated selector tuples.
- 2.4 Reference string dialects (query/display) and round-trip mapping —
  see `src/desc/refdialect.ts`; rounding pinned from source
  (`IntervalSelector.compute_string`, rounding_digits=2 for display, None for
  query).
- 2.5 Disjunction/DNF semantics (evaluation + statistics only; search operates
  over conjunctions).

## 3. Candidate space (M1/M3) ☐

- 3.1 The candidate space of a task: all conjunctions of ≤ depth **distinct**
  selectors, with the same-attribute combination rule pinned here after the
  reference-consistency audit (BRIEF §22-A3).
- 3.2 Canonical result order: quality desc → shallower depth first →
  lexicographic canonical description (§7 determinism).
- 3.3 Tie rule and top-k semantics.

## 4. Space builders (M1) ☐

- 4.1 nominalSelectors: one equality selector per observed category, in
  first-appearance order; NA produces `isNull(attr)` when the column has NAs.
- 4.2 numericSelectors: unique-value threshold vs binning; equal-frequency
  discretization edge cases (duplicate quantiles; BRIEF §22-A8), intervalsOnly
  both ways.
- 4.3 allSelectors, removeTargetAttributes.

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
