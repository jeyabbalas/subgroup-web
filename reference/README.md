# reference/ — pinned pysubgroup 0.9.0 harness

Everything here runs through `uv run` against the locked environment in
`pyproject.toml` / `uv.lock` (pysubgroup 0.9.0, pandas 2.3.3, numpy 1.26.4,
scipy 1.17.1, CPython 3.12). See DECISIONS.md for the pin rationale.

## Layout

| path | contents |
|---|---|
| `scripts/export_datasets.py` | exports titanic + credit-g through the reference's own loaders to `datasets/*.csv` + `datasets/manifest.json` (SHA-256). These CSVs are canonical for both harness sides and the demo. |
| `scripts/fetch_adult.py` | downloads UCI adult (48842×15) into git-ignored `.cache/adult.csv` with a deterministic recipe; hashes pinned in `datasets/adult.manifest.json`. |
| `scripts/gen_differential_fixtures.py` | runs `test/matrix.json` through the reference; one JSON fixture per cell under `fixtures/tasks/` + `fixtures/manifest.json` (SHA-256). |
| `scripts/bench_reference.py` | measured reference timings (1 warmup + 3 runs, median) for the §8 speedup gates → `fixtures/ref_timings.json`. Tasks land in M6. |
| `repros/` | minimal runnable repros backing every COMPATIBILITY.md adjudication. |

## Fixture families and consuming tests

| family | file(s) | consumed by |
|---|---|---|
| task fixtures | `fixtures/tasks/<cell-id>.json` | `test/differential/*` (top-k, qualities, stats), `test/differential/refdialect-roundtrip.test.ts` (string dialects) |
| fixture manifest | `fixtures/manifest.json` | anti-tamper hash check in the round-trip suite (§21) |
| dataset manifests | `datasets/manifest.json`, `datasets/adult.manifest.json` | same |
| reference timings | `fixtures/ref_timings.json` | `scripts/bench.mjs` speedup gates (M6) |

Regenerate with `pnpm fixtures` (never hand-edit; hash checks enforce this).
