"""ADJ-002 repro: pysubgroup's algorithms disagree on whether the EMPTY
conjunction ("Dataset") is a candidate.

- Apriori: level-1 candidates are the single selectors (algorithms.py:320-326)
  -> empty description never evaluated.
- SimpleSearch: `combinations(search_space, r) for r in range(1, depth+1)`
  (algorithms.py:602) -> never evaluated.
- BestFirstSearch: pops the empty description but only evaluates its
  refinements (algorithms.py:382-400) -> never added to results.
- SimpleDFS: search_internal starts with prefix=[] and calls add_if_required
  on Conjunction([]) (algorithms.py:674-689) -> "Dataset" CAN appear in
  results when min_quality <= 0.
- DFSNumeric: same (algorithms.py:854-857).
- BeamSearch: the beam is initialized with (0, Conjunction([]), stats) and the
  final trim keeps it when fewer than k better candidates exist
  (algorithms.py:531-573); its "quality" 0 is HARDCODED, never evaluated.

Run: uv run python repros/adj_002_empty_conjunction.py
"""

import pandas as pd
import pysubgroup as ps

# Tiny table where every selector has NEGATIVE WRAcc quality, but the empty
# description has quality 0 (WRAcc of the full dataset is always 0).
df = pd.DataFrame(
    {
        "a": ["u", "u", "v", "v"],
        "t": [True, False, True, False],
    }
)
target = ps.BinaryTarget("t", True)
space = ps.create_selectors(df, ignore=["t"])
task_kwargs = dict(
    data=df,
    target=target,
    search_space=space,
    result_set_size=5,
    depth=2,
    qf=ps.WRAccQF(),
    min_quality=float("-inf"),
)

apriori_res = ps.Apriori().execute(ps.SubgroupDiscoveryTask(**task_kwargs)).to_descriptions()
simpledfs_res = ps.SimpleDFS().execute(ps.SubgroupDiscoveryTask(**task_kwargs)).to_descriptions()

print("Apriori results:")
for q, sg in apriori_res:
    print(f"  {q:+.4f}  {sg}")
print("SimpleDFS results:")
for q, sg in simpledfs_res:
    print(f"  {q:+.4f}  {sg}")

apriori_descs = {str(sg) for _, sg in apriori_res}
simpledfs_descs = {str(sg) for _, sg in simpledfs_res}
assert "Dataset" not in apriori_descs, "Apriori returned the empty description?!"
assert "Dataset" in simpledfs_descs, "SimpleDFS did not return the empty description?!"
print()
print("SimpleDFS returns 'Dataset'; Apriori never evaluates it. subgroup-web")
print("spec §3.1 excludes the empty conjunction from every algorithm's space.")
