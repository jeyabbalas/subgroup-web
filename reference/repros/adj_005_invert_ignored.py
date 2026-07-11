"""ADJ-005: StandardQFNumeric accepts `invert` and silently ignores it.

The constructor stores self.invert (numeric_target.py:204-222) and no code
path reads it: utils.conditional_invert (utils.py:151) has zero callers in
pysubgroup 0.9.0. Earlier pysubgroup versions negated the quality when
invert=True; the behavior was lost in refactoring. docs/spec.md §6.3 pins the
documented intent: invert=true evaluates the QF on the negated target,
q = n^a * (mu0 - m). Run: uv run python repros/adj_005_invert_ignored.py
"""
import inspect

import pandas as pd
import pysubgroup as ps

data = pd.DataFrame({"age": [30.0, 40.0, 50.0, 60.0], "c": ["a", "b", "a", "b"]})
target = ps.NumericTarget("age")
sg = ps.Conjunction([ps.EqualitySelector("c", "a")])  # mean 40, mu0 45

plain = ps.StandardQFNumeric(1.0, invert=False)
plain.calculate_constant_statistics(data, target)
inverted = ps.StandardQFNumeric(1.0, invert=True)
inverted.calculate_constant_statistics(data, target)

q_plain = plain.evaluate(sg, target, data)
q_inverted = inverted.evaluate(sg, target, data)
assert q_plain == q_inverted == -10.0, (q_plain, q_inverted)

# and the only invert helper in the codebase is never called:
src = inspect.getsource(ps.algorithms) + inspect.getsource(ps.numeric_target)
assert "conditional_invert(" not in src.replace("def conditional_invert(", "")
print("ADJ-005 reproduced: invert=True evaluates identically to invert=False:",
      q_plain, "==", q_inverted)
