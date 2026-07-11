"""Generate differential fixtures by running the §6.4 matrix through pysubgroup 0.9.0.

Reads test/matrix.json (the single source of truth for the dataset × config
matrix), executes each cell with the pinned reference, and writes one JSON
fixture per cell under reference/fixtures/tasks/ plus a SHA-256 manifest.

Fixture contents per cell:
- the resolved search space (structured selectors + the reference's exact
  repr/str strings, in creation order),
- the reference's top-k: quality + description (repr/str + structured) +
  full target statistics per result row,
- environment versions.

Never hand-edit fixtures; re-run this script (BRIEF §21).
"""

import math
import os
import sys
import time

import numpy as np
import pandas as pd
import pysubgroup as ps

from common import FIXTURES, REPO, dump_json, sha256_file, versions


def load_dataset(name):
    csvs = {
        "titanic": os.path.join(os.path.dirname(FIXTURES), "datasets", "titanic.csv"),
        "credit-g": os.path.join(os.path.dirname(FIXTURES), "datasets", "credit-g.csv"),
        "adult": os.path.join(os.path.dirname(FIXTURES), ".cache", "adult.csv"),
    }
    if name in csvs:
        return pd.read_csv(csvs[name])
    if name.startswith("synth:"):
        # Synthetic datasets are exported by the TS side (fixture-frozen CSVs
        # under test/fixtures/datasets); the reference reads the same bytes.
        path = os.path.join(REPO, "test", "fixtures", "datasets", name[len("synth:") :] + ".csv")
        return pd.read_csv(path)
    raise ValueError(f"unknown dataset {name!r}")


def encode_value(v):
    """Structured encoding of an equality-selector value, tagged by Python type."""
    if isinstance(v, (np.integer,)):
        v = int(v)
    if isinstance(v, (np.floating,)):
        v = float(v)
    if isinstance(v, (np.bool_,)):
        v = bool(v)
    if isinstance(v, str):
        return {"t": "str", "v": v}
    if isinstance(v, bool):
        return {"t": "bool", "v": v}
    if isinstance(v, int):
        return {"t": "num", "v": {"value": v, "int": True}}
    if isinstance(v, float):
        if math.isnan(v):
            return {"t": "nan"}
        return {"t": "num", "v": {"value": v, "int": False}}
    if v is None:
        return {"t": "none"}
    raise TypeError(f"unsupported equality value {v!r} ({type(v)})")


def encode_bound(v):
    if isinstance(v, (np.integer,)):
        v = int(v)
    if isinstance(v, (np.floating,)):
        v = float(v)
    if isinstance(v, int):
        return {"value": v, "int": True}
    if isinstance(v, float):
        if math.isinf(v):
            return {"value": {"$f": "inf" if v > 0 else "-inf"}, "int": False}
        return {"value": v, "int": False}
    raise TypeError(f"unsupported bound {v!r} ({type(v)})")


def sel_to_json(sel):
    if isinstance(sel, ps.NegatedSelector):
        return {
            "kind": "negated",
            "inner": sel_to_json(sel._selector),  # noqa: SLF001
            "repr": repr(sel),
            "str": str(sel),
        }
    if isinstance(sel, ps.EqualitySelector):
        return {
            "kind": "equality",
            "attribute": sel.attribute_name,
            "value": encode_value(sel.attribute_value),
            "repr": repr(sel),
            "str": str(sel),
        }
    if isinstance(sel, ps.IntervalSelector):
        return {
            "kind": "interval",
            "attribute": sel.attribute_name,
            "lo": encode_bound(sel.lower_bound),
            "hi": encode_bound(sel.upper_bound),
            "repr": repr(sel),
            "str": str(sel),
        }
    raise TypeError(f"unsupported selector {sel!r} ({type(sel)})")


def conj_to_json(sg):
    return {
        "repr": repr(sg),
        "str": str(sg),
        "selectors": [sel_to_json(s) for s in sg.selectors],
    }


def make_target(spec):
    t = spec["type"]
    if t == "binary":
        return ps.BinaryTarget(spec["attribute"], decode_plain(spec["value"]))
    if t == "numeric":
        return ps.NumericTarget(spec["attribute"])
    if t == "fi":
        return ps.FITarget()
    raise ValueError(f"unknown target {spec!r}")


def decode_plain(v):
    """matrix.json target values are plain JSON scalars."""
    return v


def make_space(data, spec, target):
    sels = ps.create_selectors(
        data,
        nbins=spec.get("nbins", 5),
        intervals_only=spec.get("intervalsOnly", True),
        ignore=spec.get("ignore", []),
    )
    if spec.get("negations"):
        sels = sels + [ps.NegatedSelector(s) for s in sels]
    return sels


def make_qf(spec):
    name = spec["name"]
    if name == "wracc":
        return ps.WRAccQF()
    if name == "lift":
        return ps.LiftQF()
    if name == "simpleBinomial":
        return ps.SimpleBinomialQF()
    if name == "standard":
        return ps.StandardQF(spec["a"])
    if name == "chiSquared":
        return ps.ChiSquaredQF(
            direction=spec.get("direction", "both"),
            min_instances=spec.get("minInstances", 5),
            stat=spec.get("stat", "chi2"),
        )
    if name == "standardNumeric":
        return ps.StandardQFNumeric(
            spec["a"], invert=spec.get("invert", False), estimator=spec.get("estimator", "default")
        )
    if name == "count":
        return ps.CountQF()
    if name == "area":
        return ps.AreaQF()
    raise ValueError(f"unknown qf {spec!r}")


def make_algorithm(spec):
    name = spec if isinstance(spec, str) else spec["name"]
    if name == "apriori":
        return ps.Apriori()
    if name == "simple":
        return ps.SimpleSearch()
    if name == "simple_dfs":
        return ps.SimpleDFS()
    if name == "dfs":
        return ps.DFS()
    if name == "bestfirst":
        return ps.BestFirstSearch()
    if name == "beam":
        width = spec.get("width", 20) if isinstance(spec, dict) else 20
        return ps.BeamSearch(beam_width=width)
    raise ValueError(f"unknown algorithm {spec!r}")


def run_cell(cell):
    data = load_dataset(cell["dataset"])
    target = make_target(cell["target"])
    space = make_space(data, cell.get("space", {}), target)
    qf = make_qf(cell["qf"])
    algorithm = make_algorithm(cell["algorithm"])

    constraints = []
    for c in cell.get("constraints", []):
        if c["type"] == "minSupport":
            constraints.append(ps.MinSupportConstraint(c["count"]))
        else:
            raise ValueError(f"unknown constraint {c!r}")

    task = ps.SubgroupDiscoveryTask(
        data,
        target,
        space,
        result_set_size=cell.get("k", 10),
        depth=cell.get("depth", 2),
        qf=qf,
        constraints=constraints,
        min_quality=cell.get("minQuality", float("-inf")),
    )
    t0 = time.perf_counter()
    result = algorithm.execute(task)
    elapsed = time.perf_counter() - t0

    rows = []
    for quality, sg in result.to_descriptions():
        stats = target.calculate_statistics(sg, data)
        rows.append(
            {
                "quality": float(quality),
                "description": conj_to_json(sg),
                "stats": {k: v for k, v in stats.items()},
            }
        )

    return {
        "id": cell["id"],
        "cell": cell,
        "versions": versions(),
        "data_shape": [int(data.shape[0]), int(data.shape[1])],
        "search_space": [sel_to_json(s) for s in space],
        "elapsed_seconds": elapsed,
        "results": rows,
    }


def main():
    import json

    matrix_path = os.path.join(REPO, "test", "matrix.json")
    with open(matrix_path, encoding="utf-8") as f:
        matrix = json.load(f)

    only = sys.argv[1:] or None
    out_dir = os.path.join(FIXTURES, "tasks")
    os.makedirs(out_dir, exist_ok=True)

    manifest_entries = []
    for cell in matrix["cells"]:
        if only and cell["id"] not in only:
            continue
        print(f"cell {cell['id']} ...", flush=True)
        fixture = run_cell(cell)
        out_path = os.path.join(out_dir, f"{cell['id']}.json")
        dump_json(out_path, fixture)
        manifest_entries.append(
            {
                "file": f"tasks/{cell['id']}.json",
                "sha256": sha256_file(out_path),
                "results": len(fixture["results"]),
                "elapsed_seconds": round(fixture["elapsed_seconds"], 4),
            }
        )
        print(
            f"  -> {len(fixture['results'])} results, "
            f"{len(fixture['search_space'])} selectors, {fixture['elapsed_seconds']:.2f}s"
        )

    if not only:
        manifest = {
            "generator": "reference/scripts/gen_differential_fixtures.py",
            "versions": versions(),
            "fixtures": manifest_entries,
        }
        dump_json(os.path.join(FIXTURES, "manifest.json"), manifest)
    print(f"wrote {len(manifest_entries)} fixture(s)")


if __name__ == "__main__":
    main()
