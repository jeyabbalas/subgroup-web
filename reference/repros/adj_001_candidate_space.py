"""ADJ-001 repro: pysubgroup's algorithms disagree on the candidate space
(same-attribute selector combinations).

- Apriori generates level-2+ candidates by joining ANY two selectors sharing
  a prefix (algorithms.py:277-295): same-attribute combinations are included.
- SimpleSearch enumerates `combinations(search_space, r)` (algorithms.py:602):
  same-attribute combinations included.
- DFS and BestFirstSearch refine via StaticSpecializationOperator
  (refinement_operator.py:11-54), which groups selectors BY ATTRIBUTE and only
  appends selectors of attributes strictly AFTER the last selector's
  attribute: at most one selector per attribute, so same-attribute
  combinations are UNREACHABLE.

This repro builds a dataset where the best depth-2 description is a
same-attribute pair of negations — ¬(c=='a') ∧ ¬(c=='b') — and shows Apriori
finds it while DFS cannot.

Run: uv run python repros/adj_001_candidate_space.py
"""

import numpy as np
import pandas as pd
import pysubgroup as ps

rng = np.random.default_rng(7)
n = 400
# c has FOUR values; the target is positive exactly when c ∈ {z, w}. The set
# {z, w} is expressible at depth 2 only as ¬(c=='a') ∧ ¬(c=='b') — no single
# selector and no cross-attribute pair covers it exactly.
c = np.array(["a", "b", "z", "w"] * 100)
t = np.isin(c, ["z", "w"])
noise_idx = rng.choice(n, 20, replace=False)
t = t.copy()
t[noise_idx] = ~t[noise_idx]
# a second attribute so DFS has something to combine across attributes
other = rng.choice(["p", "q"], n)
df = pd.DataFrame({"c": c, "other": other, "t": t})

target = ps.BinaryTarget("t", True)
base = ps.create_selectors(df, ignore=["t"])
space = base + [ps.NegatedSelector(s) for s in base]

results = {}
for name, algo in [("Apriori", ps.Apriori()), ("DFS", ps.DFS()), ("SimpleSearch", ps.SimpleSearch(show_progress=False))]:
    task = ps.SubgroupDiscoveryTask(
        df, target, space, result_set_size=3, depth=2, qf=ps.WRAccQF(), min_quality=0.0
    )
    res = algo.execute(task).to_descriptions()
    results[name] = res
    print(f"{name}:")
    for q, sg in res:
        print(f"  {q:.6f}  {sg}")

top_apriori = str(results["Apriori"][0][1])
top_dfs = str(results["DFS"][0][1])
assert "NOT c=='a' AND NOT c=='b'" == top_apriori, top_apriori
assert top_apriori != top_dfs, "DFS found the same-attribute pair?!"
dfs_descriptions = {str(sg) for _, sg in results["DFS"]}
assert top_apriori not in dfs_descriptions
print()
print("Apriori's top result is a same-attribute pair; DFS cannot reach it.")
print("subgroup-web spec §3.1 pins the space to ALL <=depth-subsets of distinct")
print("selectors (the Apriori/SimpleSearch rule); its dfs/bestFirst are exact")
print("over that space, so they FIND this description (deliberate divergence")
print("from reference DFS/BestFirstSearch).")
