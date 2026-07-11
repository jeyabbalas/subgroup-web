"""ADJ-007: the Max/'average' numeric estimator returns -inf when a subgroup
has no target value above the dataset centroid, under-estimating reachable
refinement qualities — and the reference's own Apriori paths disagree on the
consequence.

Max_Estimator.get_estimate returns -inf when no value exceeds the centroid
(numeric_target.py:505-506). An optimistic estimate must upper-bound every
refinement's quality; refinements of such subgroups have finite (negative or
zero) qualities, which belong in the result while the top-k is unfilled and
min_quality = -inf (the SubgroupDiscoveryTask default). The non-vectorized
Apriori path prunes with a strict `estimate > min_quality` filter
(algorithms.py:188-194) and drops them; the vectorized path uses `>=`
(algorithms.py:233-235) and keeps them; SimpleSearch keeps them.

docs/spec.md §6.3 pins the admissible closure oe = 0 when the above-centroid
tail is empty (every refinement quality is <= 0 there).
Run: uv run python repros/adj_007_max_estimator_overprune.py
"""
import pandas as pd
import pysubgroup as ps

data = pd.DataFrame(
    {
        "x": [10.0, 1.0, 1.0, 1.0],  # mu0 = 3.25
        "c1": [0, 1, 1, 1],  # covers only values 1.0 < mu0
        "c2": [0, 1, 1, 0],
    }
)
target = ps.NumericTarget("x")
space = [ps.EqualitySelector("c1", 1), ps.EqualitySelector("c2", 1)]


def run(algo):
    task = ps.SubgroupDiscoveryTask(
        data, target, space, result_set_size=10, depth=2,
        qf=ps.StandardQFNumeric(1.0, estimator="average"),
        min_quality=float("-inf"),
    )
    return sorted((round(q, 6), str(sg)) for q, sg in algo.execute(task).to_descriptions())


simple = run(ps.SimpleSearch(show_progress=False))
non_vectorized = ps.Apriori()
non_vectorized.use_vectorization = False
apriori_nv = run(non_vectorized)
apriori_v = run(ps.Apriori())

assert ("c1==1 AND c2==1" in {s for _q, s in simple})
assert simple == apriori_v, (simple, apriori_v)
assert simple != apriori_nv, "expected the non-vectorized path to over-prune"
missing = set(simple) - set(apriori_nv)
assert missing == {(-4.5, "c1==1 AND c2==1")}, missing
print("ADJ-007 reproduced: non-vectorized Apriori drops", missing,
      "while vectorized Apriori and SimpleSearch keep it")
