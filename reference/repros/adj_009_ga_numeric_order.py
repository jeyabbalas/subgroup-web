"""ADJ-009: GeneralizationAware_StandardQFNumeric quality depends on the
CONSTRUCTION ORDER of the conjunction's selectors.

aggregate_statistics (numeric_target.py:813-835) picks the generalization
whose max(centroid(agg), centroid(stat)) is largest under a STRICT `>` with
seed 0.0. When several generalizations tie (e.g. all subgroup means below the
dataset mean, so every pair ties at mu0 via its own aggregate), the FIRST pair
in iteration order wins — and iteration order is `combinations(selectors,
k-1)` over the conjunction's stored selector list, i.e. construction order.
The same logical description therefore gets different qualities depending on
how it was written. The picked tuple's OWN centroid (not the tied max) then
enters the quality.

docs/spec.md §6.8 pins subgroup-web's behavior: selectors are canonicalized,
generalizations iterate in the reference's combinations order over the
CANONICAL sequence — reproducing the reference wherever its conjunction was
built in canonical order, and deterministic everywhere.
Run: uv run python repros/adj_009_ga_numeric_order.py
"""
import pandas as pd
import pysubgroup as ps

data = pd.read_csv("datasets/credit-g.csv")
target = ps.NumericTarget("age")
A = ps.EqualitySelector("checking_status", "<0")        # mean age 35.34 < mu0 35.55
B = ps.EqualitySelector("property_magnitude", "car")    # mean age 33.23 < mu0

def evaluate(selectors):
    qf = ps.GeneralizationAware_StandardQFNumeric(1.0)
    qf.calculate_constant_statistics(data, target)
    return qf.evaluate(ps.Conjunction(list(selectors)), target, data)

q_ab = evaluate([A, B])
q_ba = evaluate([B, A])
assert repr(ps.Conjunction([A, B])) == repr(ps.Conjunction([B, A]))  # same description!
assert q_ab != q_ba, (q_ab, q_ba)
print("ADJ-009 reproduced: same description, order-dependent quality:", q_ab, "vs", q_ba)
