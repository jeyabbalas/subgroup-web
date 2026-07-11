/**
 * Shared fixture-spec → subgroup-web object mapping (targets, QFs,
 * descriptions). Used by the differential QF-value comparator (M2) and the
 * matrix-driven exactness/differential runners (M3+).
 */
import {
  area,
  binary,
  Conjunction,
  chiSquared,
  count,
  emm,
  emmLikelihood,
  equality,
  frequentItemset,
  gaStandard,
  gaStandardNumeric,
  generalizationAware,
  interval,
  isNull,
  lift,
  negated,
  numeric,
  polyRegression,
  type QF,
  type Selector,
  simpleBinomial,
  standard,
  standardNumeric,
  standardNumericMedian,
  standardNumericTscore,
  type Target,
  wracc,
} from "../../src/index.js";
import type { FixtureBound, FixtureSelector, FixtureValue } from "./fixtures.js";

function decodeValue(v: FixtureValue): string | number | boolean | null {
  switch (v.t) {
    case "str":
      return v.v;
    case "bool":
      return v.v;
    case "num":
      return v.v.value;
    case "nan":
      return null; // NaN equality selector = isNull
    case "none":
      return null;
  }
}

function boundValue(b: FixtureBound): number {
  return b.value;
}

export function fixtureSelectorToSelector(sel: FixtureSelector): Selector {
  switch (sel.kind) {
    case "equality": {
      const v = decodeValue(sel.value);
      if (v === null) return isNull(sel.attribute);
      const numInt = sel.value.t === "num" ? sel.value.v.int : undefined;
      return equality(sel.attribute, v, numInt);
    }
    case "interval":
      return interval(sel.attribute, boundValue(sel.lo), boundValue(sel.hi), {
        loInt: sel.lo.int,
        hiInt: sel.hi.int,
      });
    case "negated":
      return negated(fixtureSelectorToSelector(sel.inner));
  }
}

export function fixtureConjunction(selectors: FixtureSelector[]): Conjunction {
  return new Conjunction(selectors.map(fixtureSelectorToSelector));
}

export interface QfSpec {
  name: string;
  a?: number;
  direction?: "both" | "positive" | "negative";
  minInstances?: number;
  stat?: string;
  invert?: boolean;
  estimator?: string;
  strategy?: string;
  inner?: QfSpec;
  x?: string;
  y?: string;
  weight?: number;
}

/** Map a fixture/matrix QF spec to a subgroup-web QF (spec §6 naming). */
export function makeQF(spec: QfSpec, maxDepth?: number): QF {
  switch (spec.name) {
    case "wracc":
      return wracc();
    case "lift":
      return lift();
    case "simpleBinomial":
      return simpleBinomial();
    case "standard":
      return standard(spec.a ?? 1);
    case "chiSquared":
      return chiSquared({
        direction: spec.direction ?? "both",
        minInstances: spec.minInstances ?? 5,
        stat: spec.stat === "p" || spec.stat === "pValue" ? "pValue" : "chi2",
      });
    case "standardNumeric":
      return standardNumeric(spec.a ?? 1, {
        invert: spec.invert ?? false,
        estimator: (spec.estimator as never) ?? "sum",
      });
    case "standardNumericMedian":
      return standardNumericMedian(spec.a ?? 1, { invert: spec.invert ?? false });
    case "standardNumericTscore":
      return standardNumericTscore({ invert: spec.invert ?? false });
    case "count":
      return count();
    case "area":
      return area(maxDepth);
    case "generalizationAware": {
      if (!spec.inner) throw new Error("generalizationAware spec needs inner");
      return generalizationAware(makeQF(spec.inner, maxDepth));
    }
    case "gaStandard":
      return gaStandard(spec.a ?? 1, (spec.strategy as never) ?? "difference");
    case "gaStandardNumeric":
      return gaStandardNumeric(spec.a ?? 1);
    case "emmLikelihood": {
      if (!spec.x || !spec.y) throw new Error("emmLikelihood spec needs x/y");
      return emmLikelihood(polyRegression(spec.x, spec.y));
    }
    default:
      throw new Error(`unknown qf spec ${JSON.stringify(spec)}`);
  }
}

export interface TargetSpec {
  type: string;
  attribute?: string;
  value?: string | number | boolean;
  x?: string;
  y?: string;
}

export function makeTarget(spec: TargetSpec): Target {
  switch (spec.type) {
    case "binary":
      return binary({ attribute: spec.attribute!, value: spec.value! });
    case "numeric":
      return numeric(spec.attribute!);
    case "fi":
      return frequentItemset();
    case "emm":
      return emm(polyRegression(spec.x!, spec.y!));
    default:
      throw new Error(`unknown target spec ${JSON.stringify(spec)}`);
  }
}

/** rel-1e-9 comparison with NaN/±inf identity (spec §6.3 gate tolerance). */
export function valuesAgree(ours: number, ref: number, relTol = 1e-9): boolean {
  if (Number.isNaN(ours) && Number.isNaN(ref)) return true;
  if (!Number.isFinite(ours) || !Number.isFinite(ref)) return ours === ref;
  const scale = Math.max(Math.abs(ours), Math.abs(ref), 1e-300);
  return Math.abs(ours - ref) <= relTol * scale || Math.abs(ours - ref) < 1e-15;
}
