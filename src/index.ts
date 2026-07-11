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

// Utilities
export { pyFloatRepr, pyFormatFixed } from "./util/pyfloat.js";
export { Pcg32 } from "./util/rng.js";
