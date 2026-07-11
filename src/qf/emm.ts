/**
 * emmLikelihood (spec §6.7): mean per-row likelihood φ(residual) inside the
 * subgroup minus the mean over the complement, under the subgroup's own
 * degree-1 fit (model_target.py:11-111). NaN when n = 0, n = N, or the fit is
 * degenerate (NaN β).
 */

import { ValidationError } from "../errors.js";
import type { PolyRegressionModel } from "../targets/types.js";
import type { EmmQF } from "./types.js";

export function emmLikelihood(model: PolyRegressionModel): EmmQF {
  if (model.type !== "polyRegression") {
    throw new ValidationError("emmLikelihood: only polyRegression models are supported");
  }
  return {
    kind: "emm",
    name: `emmLikelihood(${model.x},${model.y})`,
    pruningSafe: false,
    evaluate(s) {
      return s.sgLikelihood - s.complementLikelihood;
    },
  };
}
