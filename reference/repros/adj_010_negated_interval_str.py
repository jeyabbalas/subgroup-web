"""ADJ-010: str() of a negated interval selector crashes in pysubgroup 0.9.0.

NegatedSelector.__str__ forwards (open_brackets, closing_brackets) to the
inner selector's __str__ (subgroup_description.py:338-340), but
IntervalSelector.__str__ accepts no arguments -> TypeError. Any result table,
fixture export, or repr-to-display path containing NOT over an interval
selector crashes; the display dialect simply cannot express it.

subgroup-web prints NOT <interval-str> (spec §2.4) — there is no reference
string to diverge from (the reference raises instead). Differential negation
cells restrict to nominal selectors for this reason.
Run: uv run python repros/adj_010_negated_interval_str.py
"""
import pysubgroup as ps

sel = ps.NegatedSelector(ps.IntervalSelector("age", 20, 30))
assert repr(sel) == "(not age: [20:30[)"  # repr works
try:
    str(sel)
except TypeError as e:
    print("ADJ-010 reproduced: str(NOT interval) raises TypeError:", e)
else:
    raise AssertionError("expected TypeError")
