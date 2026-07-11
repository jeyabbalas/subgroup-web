"""ADJ-006: EMM poly-regression on a zero-x-variance subgroup returns a
minimum-norm fit instead of treating the model as unidentifiable.

PolyRegression_ModelClass.fit calls np.polyfit (model_target.py:275-291);
for a subgroup whose x values are all equal the Vandermonde matrix is
rank-deficient: numpy emits a RankWarning and returns the minimum-norm
least-squares solution — an arbitrary line among the infinitely many optimal
ones — and EMM_Likelihood then reports a finite quality for a model that is
not identifiable. (The n <= degree+1 guard catches only the small-sample
case, model_target.py:286-287.)

docs/spec.md §5.4 pins beta = NaN (quality NaN, excluded from results) when
n*Sxx - Sx^2 = 0. Run: uv run python repros/adj_006_emm_degenerate_fit.py
"""
import warnings

import numpy as np
import pandas as pd
import pysubgroup as ps

data = pd.DataFrame(
    {
        "x": [2.0, 2.0, 2.0, 2.0, 1.0, 3.0],
        "y": [1.0, 2.0, 3.0, 4.0, 2.0, 5.0],
        "c": ["u", "u", "u", "u", "v", "v"],
    }
)
qf = ps.EMM_Likelihood(ps.PolyRegression_ModelClass(x_name="x", y_name="y"))
qf.calculate_constant_statistics(data, None)
sg = ps.Conjunction([ps.EqualitySelector("c", "u")])  # x = [2,2,2,2]: zero variance

with warnings.catch_warnings():
    warnings.simplefilter("ignore")  # numpy RankWarning
    params = qf.model.fit(sg.covers(data), data)
    quality = qf.evaluate(sg, None, data)

assert np.all(np.isfinite(params.beta)), params.beta  # finite betas for a singular fit
assert np.isfinite(quality), quality  # finite "quality" for an unidentifiable model
print("ADJ-006 reproduced: singular fit beta =", params.beta, "quality =", quality)
