"""ADJ-003 repro: pysubgroup's NegatedSelector covers NA rows.

NegatedSelector.covers is `np.logical_not(inner.covers(data))`
(subgroup_description.py:332). Since NA rows fail every comparison, the inner
cover is False there, so the negation is True: ¬(x==v) COVERS rows where x is
missing. Same for negated intervals and negated categorical equalities.

subgroup-web's spec (docs/spec.md §1.2) says NA satisfies no selector,
including negations: cover(¬s) = validRows(attr) \\ cover(s).

Run: uv run python repros/adj_003_negation_na.py
Expected output demonstrates the reference behavior (assertion passes).
"""

import numpy as np
import pandas as pd
import pysubgroup as ps

df = pd.DataFrame({"x": [1.0, 2.0, np.nan], "cat": ["a", None, "b"]})

neg_eq = ps.NegatedSelector(ps.EqualitySelector("x", 1.0))
neg_iv = ps.NegatedSelector(ps.IntervalSelector("x", 0.0, 5.0))
neg_cat = ps.NegatedSelector(ps.EqualitySelector("cat", "a"))

print("data:")
print(df.to_string())
print()
print("(not x==1.0)    covers:", neg_eq.covers(df).tolist())
print("(not x:[0:5[)   covers:", neg_iv.covers(df).tolist())
print("(not cat=='a')  covers:", neg_cat.covers(df).tolist())

# The NA rows (x: row 2, cat: row 1) are covered by the negations:
assert neg_eq.covers(df).tolist() == [False, True, True], "row 2 (x=NaN) is covered"
assert neg_iv.covers(df).tolist() == [False, False, True], "row 2 (x=NaN) is covered"
assert neg_cat.covers(df).tolist() == [False, True, True], "row 1 (cat=None) is covered"

print()
print("Reference: negation COVERS NA rows (logical_not of a False comparison).")
print("subgroup-web spec §1.2: negation never covers NA (validity-masked complement).")
