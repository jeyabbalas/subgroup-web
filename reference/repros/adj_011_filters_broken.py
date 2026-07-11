"""ADJ-011: three of the reference's result filters crash on 0.9.0's own results.

`unique_attributes`, `minimum_statistic_filter`, and `maximum_statistic_filter`
(measures.py:121-157) access `sg.subgroup_description` / `sg.statistics` —
the pre-0.8 `Subgroup` object API. 0.9.0 result sets contain bare
Conjunction descriptions (`to_descriptions()` rows are `(quality, Conjunction)`),
so every call raises AttributeError. `minimum_quality_filter` and
`overlap_filter` operate on `(q, sg)` tuples only and still work; their
semantics (>= threshold; greedy Jaccard with strict > similarity_level drop)
are the pinned spec behavior.

Run: uv run python repros/adj_011_filters_broken.py
Expected: both broken filters raise AttributeError (printed), the two
working filters succeed.
"""

import pandas as pd
import pysubgroup as ps

data = pd.DataFrame(
    {"a": ["x", "y"] * 10, "n": list(range(20)), "t": [0, 1] * 10}
)
task = ps.SubgroupDiscoveryTask(
    data,
    ps.BinaryTarget("t", 1),
    ps.create_selectors(data, ignore=["t"]),
    result_set_size=5,
    depth=2,
    qf=ps.WRAccQF(),
)
rows = ps.Apriori().execute(task).to_descriptions()
print(f"result rows: {len(rows)}; row type: {type(rows[0][1]).__name__}")

for name, call in [
    ("unique_attributes", lambda: ps.unique_attributes(rows, data)),
    ("minimum_statistic_filter", lambda: ps.minimum_statistic_filter(rows, "size_sg", 5, data)),
    ("maximum_statistic_filter", lambda: ps.maximum_statistic_filter(rows, "size_sg", 15)),
]:
    try:
        call()
        print(f"{name}: unexpectedly succeeded")
    except AttributeError as e:
        print(f"{name}: AttributeError: {e}")

print("minimum_quality_filter (>=):", len(ps.minimum_quality_filter(rows, 0.0)))
print("overlap_filter (Jaccard >):", len(ps.overlap_filter(rows, data, 0.5)))
