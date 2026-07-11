"""Measure reference (pysubgroup 0.9.0) wall times for the §8 speedup gates.

Runs each benchmark task in its fastest applicable reference configuration
(default Apriori = BitSetRepresentation; numba absent from the pinned env),
1 warmup + 3 measured runs of `execute` only, and writes the medians to
reference/fixtures/ref_timings.json. subgroup-web's bench runner reads that
file, so speedup gates are self-calibrating on this machine (BRIEF §8).

The P1 task additionally dumps the reference's top-k (structured
descriptions + qualities) to reference/fixtures/p1_reference_topk.json —
the P5 correctness-under-perf gate compares subgroup-web's P1 output
against it (tie-tolerant per COMPATIBILITY.md MAP-001).
"""

import json
import os
import statistics
import time

import pysubgroup as ps

from common import FIXTURES, dump_json, versions
from gen_differential_fixtures import conj_to_json, load_dataset


def p1_adult_apriori():
    """P1 (BRIEF §8.1): adult, allSelectors nbins 5, income >50K,
    standard(0.5), depth 3, k=100, Apriori (bitset representation)."""
    data = load_dataset("adult")
    target = ps.BinaryTarget("income", ">50K")
    space = ps.create_selectors(data, nbins=5, intervals_only=True, ignore=["income"])
    task = ps.SubgroupDiscoveryTask(
        data,
        target,
        space,
        result_set_size=100,
        depth=3,
        qf=ps.StandardQF(0.5),
        min_quality=float("-inf"),
    )
    algo = ps.Apriori()

    def run():
        return algo.execute(task)

    return run, len(space)


def info_titanic_apriori():
    """Small sanity row (non-gating): titanic wracc apriori depth 3."""
    data = load_dataset("titanic")
    target = ps.BinaryTarget("Survived", 1)
    space = ps.create_selectors(data, nbins=5, intervals_only=True, ignore=["Survived"])
    task = ps.SubgroupDiscoveryTask(
        data,
        target,
        space,
        result_set_size=10,
        depth=3,
        qf=ps.WRAccQF(),
        min_quality=float("-inf"),
    )
    algo = ps.Apriori()

    def run():
        return algo.execute(task)

    return run, len(space)


def measure(name, make, warmup=1, runs=3):
    fn, n_selectors = make()
    result = None
    for _ in range(warmup):
        result = fn()
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        result = fn()
        times.append(time.perf_counter() - t0)
    return (
        {
            "task": name,
            "selectors": n_selectors,
            "runs": times,
            "median_seconds": statistics.median(times),
        },
        result,
    )


def main():
    results = []

    row, p1_result = measure("p1-adult-apriori-d3-std05-k100", p1_adult_apriori)
    results.append(row)
    topk = [
        {"quality": float(q), "description": conj_to_json(sg)}
        for q, sg in p1_result.to_descriptions()
    ]
    dump_json(
        os.path.join(FIXTURES, "p1_reference_topk.json"),
        {
            "generator": "reference/scripts/bench_reference.py",
            "task": "p1-adult-apriori-d3-std05-k100",
            "versions": versions(),
            "results": topk,
        },
    )
    print(f"p1 top-k dumped ({len(topk)} rows; best quality {topk[0]['quality']:.6f})")

    row, _ = measure("info-titanic-apriori-d3-wracc", info_titanic_apriori)
    results.append(row)

    out = {
        "generator": "reference/scripts/bench_reference.py",
        "versions": versions(),
        "timings": results,
    }
    dump_json(os.path.join(FIXTURES, "ref_timings.json"), out)
    print(json.dumps(out["timings"], indent=1))
    print(f"wrote {len(results)} reference timing(s)")


if __name__ == "__main__":
    main()
