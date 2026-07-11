"""Measure reference (pysubgroup 0.9.0) wall times for the §8 speedup gates.

Runs each benchmark task in its fastest applicable reference configuration
(bitset representation where supported), 1 warmup + 3 measured runs, and
writes the medians to reference/fixtures/ref_timings.json. subgroup-web's
bench runner reads that file, so speedup gates are self-calibrating on this
machine (BRIEF §8).

Task definitions land with M6; running this before then reports an empty
timing set (exit 0) so `pnpm ref:bench` is wired from M0.
"""

import json
import os
import statistics
import time

from common import FIXTURES, dump_json, versions

TASKS = []  # populated in M6 with the P1..P3 reference tasks


def measure(name, fn, warmup=1, runs=3):
    for _ in range(warmup):
        fn()
    times = []
    for _ in range(runs):
        t0 = time.perf_counter()
        fn()
        times.append(time.perf_counter() - t0)
    return {"task": name, "runs": times, "median_seconds": statistics.median(times)}


def main():
    results = [measure(name, fn) for name, fn in TASKS]
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
