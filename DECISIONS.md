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
