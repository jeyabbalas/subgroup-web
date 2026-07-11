"""ADJ-012: reference Apriori and DFS crash on quality functions without an
optimistic estimate.

Apriori.get_next_level_candidates (algorithms.py:169) and DFS.search_internal
(algorithms.py:760) call `qf.optimistic_estimate` unconditionally. QFs that
define none — ChiSquaredQF, EMM_Likelihood, StandardQFNumericTscore — raise
AttributeError inside `execute`, so entire (algorithm × QF) combinations the
API implies are usable simply crash. SimpleSearch/SimpleDFS/BeamSearch guard
the attribute and work.

subgroup-web behavior (spec §7.4): every engine accepts estimate-free QFs;
§3.4 estimate pruning simply disengages (`pruningSafe` gating), exactness
unaffected — proven by the §6.2 gates on chi²/EMM/tscore cells across
apriori/dfs/bestFirst.

Run: uv run python repros/adj_012_apriori_requires_estimate.py
Expected: AttributeError from Apriori and DFS for ChiSquaredQF and
EMM_Likelihood; SimpleSearch succeeds on both.
"""

import pandas as pd
import pysubgroup as ps

data = pd.DataFrame(
    {
        "a": ["x", "y"] * 30,
        "b": ["u", "v", "w"] * 20,
        "n": [float(i % 7) for i in range(60)],
        "t": [0, 1, 1] * 20,
    }
)
target = ps.BinaryTarget("t", 1)
space = ps.create_nominal_selectors(data, ignore=["t"])


def attempt(algorithm_name, algorithm, qf_name, qf, tgt):
    task = ps.SubgroupDiscoveryTask(
        data, tgt, space, result_set_size=3, depth=2, qf=qf, min_quality=0
    )
    try:
        algorithm.execute(task)
        print(f"{algorithm_name} × {qf_name}: OK")
    except AttributeError as e:
        print(f"{algorithm_name} × {qf_name}: AttributeError: {e}")


attempt("Apriori", ps.Apriori(), "ChiSquaredQF", ps.ChiSquaredQF(), target)
attempt("DFS", ps.DFS(), "ChiSquaredQF", ps.ChiSquaredQF(), target)
attempt("SimpleSearch", ps.SimpleSearch(show_progress=False), "ChiSquaredQF", ps.ChiSquaredQF(), target)
attempt(
    "Apriori",
    ps.Apriori(),
    "EMM_Likelihood",
    ps.EMM_Likelihood(ps.PolyRegression_ModelClass("n", "t")),
    ps.FITarget(),
)
attempt(
    "SimpleSearch",
    ps.SimpleSearch(show_progress=False),
    "EMM_Likelihood",
    ps.EMM_Likelihood(ps.PolyRegression_ModelClass("n", "t")),
    ps.FITarget(),
)
