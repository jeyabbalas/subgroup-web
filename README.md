# subgroup-web

Privacy-preserving **subgroup discovery and exceptional model mining** for web
browsers and Node.js — a stand-alone, spec-first TypeScript implementation of
the complete [pysubgroup](https://github.com/flemmerich/pysubgroup) 0.9.0
feature set, with bitset kernels, worker parallelism, and WebGPU acceleration.
Your data never leaves your device.

> **Status: under construction** (M0 scaffold). This README is finalized in M7;
> see `STATUS.md` for live progress, `BRIEF.md` for the project constitution.

## Why

Subgroup discovery finds interpretable descriptions (`Sex=='female' AND
Pclass==1`) of data regions where a target behaves unusually. pysubgroup is
the reference Python library; subgroup-web brings the same capability to the
browser for in-browser, zero-upload data analysis — faster, memory-lean, and
provably exact where the algorithm class allows it.

- **Zero runtime dependencies**, ESM-only, TypeScript strict, Node ≥ 20.
- **Exact algorithms are provably exact** against a shipped exhaustive oracle;
  heuristics are fully specified and deterministic (see `docs/spec.md`).
- **Differentially tested** against pinned `pysubgroup==0.9.0`; every
  intentional divergence is adjudicated in `COMPATIBILITY.md` with a runnable
  repro (`reference/repros/`).
- **Fast**: CPU worker pool + WebGPU batch evaluator; see `BENCHMARKS.md` for
  measured speedups on this repository's gate machine.

## Development

```sh
pnpm install          # toolchain
pnpm gate:quick       # inner-loop checks
pnpm gate             # the full acceptance pipeline (§16.3)
pnpm fixtures         # regenerate reference datasets + differential fixtures (uv)
```

The `reference/` directory pins the Python reference via
[uv](https://docs.astral.sh/uv/); `uv run python -c "from importlib.metadata
import version; print(version('pysubgroup'))"` prints `0.9.0`.

## License

Apache-2.0 (see `LICENSE`, `NOTICE`). subgroup-web is an independent
implementation; semantics were developed against pysubgroup 0.9.0. Academic
users should cite: Lemmerich & Becker, *pysubgroup: Easy-to-Use Subgroup
Discovery in Python*, ECML-PKDD 2018.
