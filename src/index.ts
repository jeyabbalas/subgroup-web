/**
 * subgroup-web — privacy-preserving subgroup discovery and exceptional model
 * mining for browsers and Node.
 *
 * A spec-first TypeScript implementation of the pysubgroup 0.9.0 feature set:
 * selector spaces, conjunctive descriptions, binary/numeric/frequent-itemset/
 * model targets, the full quality-function battery with optimistic estimates,
 * exhaustive and heuristic search, constraints, statistics, and result
 * filtering — with bitset kernels, worker parallelism, and WebGPU
 * acceleration.
 *
 * @packageDocumentation
 */

/** Library version (mirrors package.json). */
export const VERSION = "0.1.0";

// Bitsets
export { buildAtlas, SelectorAtlas } from "./bitset/atlas.js";
export {
  andCount,
  andCount3,
  andInto,
  Bitset,
  countRange,
  forEachSetBit,
  gatherSum,
  maskTail,
  popcount32,
  wordsFor,
} from "./bitset/bitset.js";
// Descriptions
export { Conjunction, canonicalSelectors, Disjunction, DNF } from "./desc/conjunction.js";
export {
  conjunctionCover,
  disjunctionCover,
  selectorCover,
  validityMask,
} from "./desc/cover.js";
export type {
  EqualitySelector,
  IntervalSelector,
  IsNullSelector,
  NegatedSelector,
  Selector,
  SelectorValue,
} from "./desc/selector.js";
export {
  compareSelectors,
  equality,
  interval,
  isNull,
  negated,
  printSelector,
  selectorAttribute,
  selectorKey,
  selectorsEqual,
} from "./desc/selector.js";
export type {
  AllSelectorsOptions,
  NominalOptions,
  NumericOptions,
} from "./desc/space.js";
export {
  allSelectors,
  equalFrequencyCutpoints,
  equalWidthCutpoints,
  nominalSelectors,
  numericSelectors,
  removeTargetAttributes,
} from "./desc/space.js";
// Errors
export {
  AbortedError,
  BackendError,
  CsvError,
  SearchSpaceError,
  SubgroupWebError,
  ValidationError,
} from "./errors.js";
export { lift, simpleBinomial, standard, wracc } from "./qf/binary.js";
export type { ChiSquaredOptions } from "./qf/chisq.js";
export { chiSquared } from "./qf/chisq.js";
export type { CombinedMember } from "./qf/combined.js";
export { combined } from "./qf/combined.js";
export { CoverEvalContext } from "./qf/context.js";
export { emmLikelihood } from "./qf/emm.js";
export { area, count } from "./qf/fi.js";
export type { GaStandardStrategy } from "./qf/ga.js";
export { gaStandard, gaStandardNumeric, generalizationAware } from "./qf/ga.js";
export type {
  NumericEstimator,
  StandardNumericMedianOptions,
  StandardNumericOptions,
  TscoreOptions,
} from "./qf/numeric.js";
export {
  standardNumeric,
  standardNumericMedian,
  standardNumericTscore,
} from "./qf/numeric.js";

// Quality functions
export type {
  BinaryQF,
  DescriptionQF,
  EmmQF,
  EvalContext,
  FiQF,
  NumericQF,
  QF,
  StatsQF,
} from "./qf/types.js";
// Table model
export type {
  BooleanColumn,
  CategoricalColumn,
  CategoryValue,
  Column,
  NumericColumn,
} from "./table/column.js";
export type { FromCSVOptions } from "./table/csv.js";
export { DEFAULT_NA_TOKENS, fromCSV, parseCsvRecords } from "./table/csv.js";
export type { CellValue } from "./table/table.js";
export { DataTable, fromColumns, fromRows } from "./table/table.js";
export type { EmmCoverStats, EmmFit, EmmSufficientStats } from "./targets/emm.js";
export {
  emmFit,
  emmMerge,
  emmStatsFromBits,
  emmStatsFromMask,
  emmStatsTable,
  emmSufficientFromBits,
  emmSufficientFromMask,
} from "./targets/emm.js";
export {
  binary,
  emm,
  ensureDescOrder,
  frequentItemset,
  numeric,
  polyRegression,
  prepareTarget,
} from "./targets/prepare.js";
export type {
  BinaryCoverStats,
  FiCoverStats,
  NumericCoverStats,
  NumericStatsPlan,
} from "./targets/stats.js";
export {
  BASIC_NUMERIC_PLAN,
  binaryStatsFromBits,
  binaryStatsFromMask,
  binaryStatsTable,
  fiStatsTable,
  gatherValuesFromBits,
  gatherValuesFromMask,
  numericStatsFromBits,
  numericStatsFromMask,
  numericStatsTable,
  sizeFromBits,
  sizeFromMask,
} from "./targets/stats.js";
// Targets
export type {
  BinaryTargetSpec,
  EMMTargetSpec,
  FITargetSpec,
  NumericTargetSpec,
  PolyRegressionModel,
  PreparedBinary,
  PreparedEMM,
  PreparedFI,
  PreparedNumeric,
  PreparedTarget,
  Target,
} from "./targets/types.js";
export { targetAttributes } from "./targets/types.js";

// Utilities
export {
  chi2TailProbability,
  logGamma,
  mean,
  medianInPlace,
  normPdf,
  pairwiseSum,
  populationStd,
  upperIncompleteGammaRegularized,
} from "./util/math.js";
export { pyFloatRepr, pyFormatFixed } from "./util/pyfloat.js";
export { Pcg32 } from "./util/rng.js";
