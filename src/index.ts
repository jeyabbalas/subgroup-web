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

export { pyFloatRepr, pyFormatFixed } from "./util/pyfloat.js";
export { Pcg32 } from "./util/rng.js";
