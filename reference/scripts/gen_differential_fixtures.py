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
    # float_precision="round_trip": pandas' default C-engine xstrtod is not
    # correctly rounded (1-ulp drift vs the CSV bytes), which shifts
    # equal-frequency cutpoints off the values subgroup-web parses (JS Number()
    # is correctly rounded). The CSV bytes are the ground truth both sides
    # must read identically; DECISIONS.md 2026-07-11.
    csvs = {
        "titanic": os.path.join(os.path.dirname(FIXTURES), "datasets", "titanic.csv"),
        "credit-g": os.path.join(os.path.dirname(FIXTURES), "datasets", "credit-g.csv"),
        "adult": os.path.join(os.path.dirname(FIXTURES), ".cache", "adult.csv"),
    }
    if name in csvs:
        return pd.read_csv(csvs[name], float_precision="round_trip")
    if name.startswith("synth:"):
        # Synthetic datasets are exported by the TS side (fixture-frozen CSVs
        # under test/fixtures/datasets); the reference reads the same bytes.
        path = os.path.join(REPO, "test", "fixtures", "datasets", name[len("synth:") :] + ".csv")
        return pd.read_csv(path, float_precision="round_trip")
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
    if t == "emm":
        # The reference has no task-level EMM target object: EMM_Likelihood
        # carries the model; tasks conventionally use FITarget (per-row stats
        # are then FI's size fields — qualities/descriptions are what the
        # top-k gate compares).
        return ps.FITarget()
    raise ValueError(f"unknown target {spec!r}")


def decode_plain(v):
    """matrix.json target values are plain JSON scalars."""
    return v


def make_space(data, spec, target):
    if spec.get("nominalOnly"):
        # NOT-interval strings crash in the reference (ADJ-010); negation
        # cells therefore restrict to nominal selectors.
        sels = ps.create_nominal_selectors(data, ignore=spec.get("ignore", []))
    else:
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
    if name == "gaStandard":
        return ps.GeneralizationAware_StandardQF(
            spec["a"], optimistic_estimate_strategy=spec.get("strategy", "difference")
        )
    if name == "emmLikelihood":
        return ps.EMM_Likelihood(ps.PolyRegression_ModelClass(spec["x"], spec["y"]))
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
    if name == "dfs_numeric":
        return ps.DFSNumeric()
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


# --- selector-space fixtures (spec §4 parity: builder semantics + order) ---

SPACE_CONFIGS = [
    {"id": "titanic-nb5-iv", "dataset": "titanic", "nbins": 5, "intervals_only": True, "ignore": ["Survived"]},
    {"id": "titanic-nb5-noiv", "dataset": "titanic", "nbins": 5, "intervals_only": False, "ignore": ["Survived"]},
    {"id": "titanic-nb10-iv", "dataset": "titanic", "nbins": 10, "intervals_only": True, "ignore": ["Survived"]},
    {"id": "creditg-nb5-iv", "dataset": "credit-g", "nbins": 5, "intervals_only": True, "ignore": ["class"]},
    {"id": "creditg-nb5-noiv", "dataset": "credit-g", "nbins": 5, "intervals_only": False, "ignore": ["class"]},
    {"id": "creditg-nb10-iv", "dataset": "credit-g", "nbins": 10, "intervals_only": True, "ignore": ["class"]},
]


def gen_space_fixture(cfg):
    data = load_dataset(cfg["dataset"])
    sels = ps.create_selectors(
        data, nbins=cfg["nbins"], intervals_only=cfg["intervals_only"], ignore=cfg["ignore"]
    )
    return {
        "id": cfg["id"],
        "config": cfg,
        "versions": versions(),
        "dtypes": {c: str(data[c].dtype) for c in data.columns},
        "selectors": [sel_to_json(s) for s in sels],
    }


# --- per-subgroup QF-value fixtures on fixed description lists (M2, §6.3) ---
#
# Each config evaluates a battery of reference QFs on a deterministic list of
# descriptions (depth 1-3, incl. empty-cover, NA-negation, tiny and degenerate
# covers). Rows whose reference behavior is adjudicated carry `adj` ids so the
# TS comparator can classify divergences (COMPATIBILITY.md).


def _desc(selectors):
    return ps.Conjunction(list(selectors))


def _na_attrs(data):
    return {c for c in data.columns if data[c].isna().any()}


def _has_negation_over_na(sg, na_attrs):
    return any(
        isinstance(s, ps.NegatedSelector) and s._selector.attribute_name in na_attrs  # noqa: SLF001
        for s in sg.selectors
    )


def build_qfvalue_descriptions(data, ignore, extra=()):
    """Deterministic description list: singles, pairs, triples, empty-cover."""
    sels = ps.create_selectors(data, nbins=5, intervals_only=True, ignore=ignore)
    descs = []
    for s in sels[:8]:
        descs.append(_desc([s]))
    n = len(sels)
    pair_idx = [(0, n // 2), (1, n // 2 + 1), (2, n - 1), (3, n // 3), (5, n // 2 + 3)]
    for i, j in pair_idx:
        descs.append(_desc([sels[i], sels[j]]))
    descs.append(_desc([sels[0], sels[n // 2], sels[n - 1]]))
    descs.append(_desc([sels[1], sels[n // 3], sels[n // 2 + 2]]))
    # same-attribute disjoint equalities -> empty cover (ADJ-004 for numeric)
    eq_attrs = {}
    for s in sels:
        if isinstance(s, ps.EqualitySelector) and not (
            isinstance(s.attribute_value, float) and math.isnan(s.attribute_value)
        ):
            eq_attrs.setdefault(s.attribute_name, []).append(s)
    for attr_sels in eq_attrs.values():
        if len(attr_sels) >= 2:
            descs.append(_desc([attr_sels[0], attr_sels[1]]))
            break
    descs.extend(extra)
    return descs


def make_qfvalue_qf(spec):
    name = spec["name"]
    if name in ("wracc", "lift", "simpleBinomial", "standard", "chiSquared", "count", "area",
                "standardNumeric"):
        return make_qf(spec)
    if name == "standardNumericMedian":
        return ps.StandardQFNumeric(spec["a"], invert=spec.get("invert", False),
                                    estimator="max", centroid="median")
    if name == "standardNumericTscore":
        return ps.StandardQFNumericTscore(invert=spec.get("invert", False))
    if name == "generalizationAware":
        return ps.GeneralizationAwareQF(make_qfvalue_qf(spec["inner"]))
    if name == "gaStandard":
        return ps.GeneralizationAware_StandardQF(
            spec["a"], optimistic_estimate_strategy=spec.get("strategy", "difference"))
    if name == "gaStandardNumeric":
        return ps.GeneralizationAware_StandardQFNumeric(spec["a"])
    if name == "emmLikelihood":
        return ps.EMM_Likelihood(
            ps.PolyRegression_ModelClass(x_name=spec["x"], y_name=spec["y"], degree=1))
    raise ValueError(f"unknown qfvalue qf {spec!r}")


QFVALUE_CONFIGS = [
    {
        "id": "titanic-binary-qfvalues",
        "dataset": "titanic",
        "target": {"type": "binary", "attribute": "Survived", "value": 1},
        "ignore": ["Survived"],
        "qfs": [
            {"name": "wracc"},
            {"name": "lift"},
            {"name": "simpleBinomial"},
            {"name": "standard", "a": 0.3},
            {"name": "chiSquared", "direction": "both", "minInstances": 5, "stat": "chi2"},
            {"name": "chiSquared", "direction": "positive", "minInstances": 5, "stat": "chi2"},
            {"name": "chiSquared", "direction": "negative", "minInstances": 5, "stat": "p"},
            {"name": "chiSquared", "direction": "both", "minInstances": 1, "stat": "p"},
            {"name": "generalizationAware", "inner": {"name": "wracc"}},
            {"name": "gaStandard", "a": 0.5, "strategy": "difference"},
            {"name": "gaStandard", "a": 1.0, "strategy": "max"},
        ],
    },
    {
        "id": "titanic-fi-qfvalues",
        "dataset": "titanic",
        "target": {"type": "fi"},
        "ignore": [],
        "qfs": [{"name": "count"}, {"name": "area"}],
    },
    {
        "id": "creditg-numeric-qfvalues",
        "dataset": "credit-g",
        "target": {"type": "numeric", "attribute": "age"},
        "ignore": ["age", "class"],
        "qfs": [
            {"name": "standardNumeric", "a": 1.0},
            {"name": "standardNumeric", "a": 0.5},
            {"name": "standardNumeric", "a": 0.0},
            {"name": "standardNumeric", "a": 1.0, "invert": True,
             "adjAllRows": "ADJ-005-invert-ignored"},
            {"name": "standardNumericMedian", "a": 1.0},
            {"name": "standardNumericTscore"},
            {"name": "gaStandardNumeric", "a": 1.0},
        ],
    },
    {
        "id": "creditg-emm-qfvalues",
        "dataset": "credit-g",
        "target": {"type": "emm", "x": "age", "y": "credit_amount"},
        "ignore": ["age", "credit_amount", "class"],
        "qfs": [{"name": "emmLikelihood", "x": "age", "y": "credit_amount"}],
    },
]


def gen_qfvalue_fixture(cfg):
    import warnings

    data = load_dataset(cfg["dataset"])
    na_attrs = _na_attrs(data)
    extra = []
    if cfg["id"] == "creditg-emm-qfvalues":
        # deliberate degenerate covers: zero x-variance (ADJ-006) and n <= 2
        extra = [
            _desc([ps.EqualitySelector("age", 24)]),
            _desc([ps.EqualitySelector("age", 75)]),
        ]
    descs = build_qfvalue_descriptions(data, cfg["ignore"], extra)

    if cfg["target"]["type"] == "binary":
        target = ps.BinaryTarget(cfg["target"]["attribute"], cfg["target"]["value"])
    elif cfg["target"]["type"] == "numeric":
        target = ps.NumericTarget(cfg["target"]["attribute"])
    elif cfg["target"]["type"] == "fi":
        target = ps.FITarget()
    else:
        target = None  # EMM: the QF ignores the target

    desc_rows = []
    for sg in descs:
        cover = sg.covers(data)
        size = int(np.count_nonzero(cover))
        row = {
            "description": conj_to_json(sg),
            "cover_size": size,
            "adj": [],
        }
        if _has_negation_over_na(sg, na_attrs):
            row["adj"].append("ADJ-003-negation-covers-na")
        if size == 0 and cfg["target"]["type"] == "numeric":
            row["adj"].append("ADJ-004-numeric-empty-quality")
        if cfg["target"]["type"] == "emm" and size > 2:
            xv = data[cfg["target"]["x"]].to_numpy()[cover]
            if np.all(xv == xv[0]):
                row["adj"].append("ADJ-006-emm-degenerate-fit")
        desc_rows.append((sg, row))

    qf_blocks = []
    for spec in cfg["qfs"]:
        qf = make_qfvalue_qf(spec)
        qf.calculate_constant_statistics(data, target)
        values = []
        for sg, _row in desc_rows:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore")
                v = qf.evaluate(sg, target, data)
            values.append(float(v))
        clean_spec = {k: v for k, v in spec.items() if k != "adjAllRows"}
        block = {"qf": clean_spec, "values": values}
        if "adjAllRows" in spec:
            block["adjAllRows"] = spec["adjAllRows"]
        qf_blocks.append(block)

    return {
        "id": cfg["id"],
        "config": {k: v for k, v in cfg.items() if k != "qfs"},
        "versions": versions(),
        "descriptions": [row for _sg, row in desc_rows],
        "qfs": qf_blocks,
    }


# --- equal-frequency binning edge fixtures (BRIEF §22-A8) ---

BINNING_CASES = [
    {"id": "uniform-ints", "values": list(range(1, 11)), "nbins": 5},
    {"id": "heavy-dups", "values": [1, 1, 1, 1, 2, 2, 2, 3, 3, 10], "nbins": 5},
    {"id": "all-same", "values": [7] * 8, "nbins": 3},
    {"id": "front-loaded", "values": [0] * 6 + list(range(1, 10)) + [9, 9, 9], "nbins": 4},
    {"id": "floats-dups", "values": [0.5, 1.5, 1.5, 2.25, 3.75, 3.75, 3.75, 8.5], "nbins": 3},
    {"id": "tail-dups", "values": [1, 2, 3, 4, 5, 5, 5, 5, 5, 5], "nbins": 5},
    {"id": "two-values", "values": [1, 1, 1, 1, 1, 2, 2, 2, 2, 2], "nbins": 4},
    {"id": "nbins10-small", "values": [3, 1, 4, 1, 5, 9, 2, 6, 5, 3, 5, 8, 9, 7], "nbins": 10},
]


def gen_binning_fixture():
    import pandas as pd

    cases = []
    for case in BINNING_CASES:
        df = pd.DataFrame({"x": case["values"]})
        cuts = ps.equal_frequency_discretization(df, "x", nbins=case["nbins"])
        cases.append(
            {
                "id": case["id"],
                "values": case["values"],
                "nbins": case["nbins"],
                "cutpoints": [encode_bound(c) for c in cuts],
            }
        )
    return {"id": "equal-frequency-binning", "versions": versions(), "cases": cases}


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
        qfv_dir = os.path.join(FIXTURES, "qfvalues")
        os.makedirs(qfv_dir, exist_ok=True)
        for cfg in QFVALUE_CONFIGS:
            fixture = gen_qfvalue_fixture(cfg)
            out_path = os.path.join(qfv_dir, f"{cfg['id']}.json")
            dump_json(out_path, fixture)
            manifest_entries.append(
                {
                    "file": f"qfvalues/{cfg['id']}.json",
                    "sha256": sha256_file(out_path),
                    "descriptions": len(fixture["descriptions"]),
                    "qfs": len(fixture["qfs"]),
                }
            )
            print(
                f"qfvalues {cfg['id']}: {len(fixture['descriptions'])} descriptions x "
                f"{len(fixture['qfs'])} qfs"
            )

        spaces_dir = os.path.join(FIXTURES, "spaces")
        os.makedirs(spaces_dir, exist_ok=True)
        for cfg in SPACE_CONFIGS:
            fixture = gen_space_fixture(cfg)
            out_path = os.path.join(spaces_dir, f"{cfg['id']}.json")
            dump_json(out_path, fixture)
            manifest_entries.append(
                {
                    "file": f"spaces/{cfg['id']}.json",
                    "sha256": sha256_file(out_path),
                    "selectors": len(fixture["selectors"]),
                }
            )
            print(f"space {cfg['id']}: {len(fixture['selectors'])} selectors")

        binning = gen_binning_fixture()
        out_path = os.path.join(FIXTURES, "binning.json")
        dump_json(out_path, binning)
        manifest_entries.append(
            {"file": "binning.json", "sha256": sha256_file(out_path), "cases": len(binning["cases"])}
        )
        print(f"binning: {len(binning['cases'])} cases")

        manifest = {
            "generator": "reference/scripts/gen_differential_fixtures.py",
            "versions": versions(),
            "fixtures": manifest_entries,
        }
        dump_json(os.path.join(FIXTURES, "manifest.json"), manifest)
    print(f"wrote {len(manifest_entries)} fixture(s)")


if __name__ == "__main__":
    main()
