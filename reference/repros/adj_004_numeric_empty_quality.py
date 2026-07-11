"""ADJ-004: numeric-family QFs return finite qualities on EMPTY subgroups.

pysubgroup's StandardQFNumeric.calculate_statistics substitutes centroid 0
when the cover is empty (numeric_target.py:335-345), so an empty subgroup
evaluates to 0**a * (0 - mu0):
  a > 0  ->  0.0 (well-defined-looking quality for an undefined mean!)
  a = 0  ->  -mu0 (can be ANY value, even positive when mu0 < 0)
StandardQFNumericTscore returns int 0 through an array-truthiness accident
(numeric_target.py:739-752: sg_mean = np.array([0]); std check truthy).

The mean of an empty set is undefined; docs/spec.md §5.5 pins quality = NaN
(excluded from results). Run: uv run python repros/adj_004_numeric_empty_quality.py
"""
import numpy as np
import pandas as pd
import pysubgroup as ps

data = pd.DataFrame(
    {
        "age": [30.0, 40.0, 50.0, 60.0],
        "c": ["a", "b", "a", "b"],
    }
)
target = ps.NumericTarget("age")
# same-attribute disjoint equalities: cover is empty
empty_sg = ps.Conjunction([ps.EqualitySelector("c", "a"), ps.EqualitySelector("c", "b")])
assert int(np.count_nonzero(empty_sg.covers(data))) == 0

qf1 = ps.StandardQFNumeric(1.0)
qf1.calculate_constant_statistics(data, target)
q1 = qf1.evaluate(empty_sg, target, data)
assert q1 == 0.0, q1  # a=1: quality 0.0 for an empty subgroup

qf0 = ps.StandardQFNumeric(0.0)
qf0.calculate_constant_statistics(data, target)
q0 = qf0.evaluate(empty_sg, target, data)
assert q0 == -45.0, q0  # a=0: -mu0 — an arbitrary, possibly positive number

qft = ps.StandardQFNumericTscore()
qft.calculate_constant_statistics(data, target)
qt = qft.evaluate(empty_sg, target, data)
assert qt == 0, qt  # array-truthiness accident

# With min_quality=-inf (the task default!) the empty-cover subgroup ENTERS
# results at quality 0.0 while carrying an undefined mean:
task = ps.SubgroupDiscoveryTask(
    data, target, [ps.EqualitySelector("c", "a"), ps.EqualitySelector("c", "b")],
    result_set_size=10, depth=2, qf=ps.StandardQFNumeric(1.0),
)
res = ps.SimpleSearch(show_progress=False).execute(task).to_descriptions()
assert any(str(sg) == "c=='a' AND c=='b'" for _q, sg in res), res
print("ADJ-004 reproduced: empty subgroup gets quality", q1, "/", q0, "/", qt,
      "and enters results under default min_quality")
