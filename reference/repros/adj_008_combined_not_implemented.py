"""ADJ-008: CombinedInterestingnessMeasure is unusable in pysubgroup 0.9.0.

The constructor unconditionally raises NotImplementedError
(measures.py:46-57, marked "FIX ME: This is currently not working anymore"),
so no fixture can be generated for it. Its dead code documents the intended
semantics — a weighted dot product of member qualities/estimates — which
docs/spec.md §6.9 pins for subgroup-web's `combined([{qf, weight}])`
(estimate defined only for all-nonnegative weights over estimable members).
Run: uv run python repros/adj_008_combined_not_implemented.py
"""
import pysubgroup as ps

try:
    ps.CombinedInterestingnessMeasure([ps.WRAccQF(), ps.LiftQF()], weights=[1, 2])
except NotImplementedError as e:
    print("ADJ-008 reproduced: CombinedInterestingnessMeasure raises:", e)
else:
    raise AssertionError("expected NotImplementedError")
