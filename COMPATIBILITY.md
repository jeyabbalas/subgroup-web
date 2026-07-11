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

*No adjudications yet (M0). First candidates expected in M1 (NA semantics,
candidate-space consistency, equal-frequency binning edges) per BRIEF §22.*
