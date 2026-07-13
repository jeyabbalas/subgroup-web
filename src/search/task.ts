/**
 * Task specification, validation, and preparation (BRIEF §5.4/§5.5;
 * spec §3, §7.3).
 */

import { buildAtlas, type SelectorAtlas } from "../bitset/atlas.js";
import { canonicalSelectors } from "../desc/conjunction.js";
import { type Selector, selectorAttribute } from "../desc/selector.js";
import { SearchSpaceError, ValidationError } from "../errors.js";
import type { QF } from "../qf/types.js";
import type { DataTable } from "../table/table.js";
import { prepareTarget } from "../targets/prepare.js";
import type { PreparedTarget, Target } from "../targets/types.js";
import { targetAttributes } from "../targets/types.js";

/** Progress snapshot delivered to onProgress (BRIEF §5). */
export interface SearchProgress {
  /** Current depth/layer (1-based). */
  layer: number;
  candidatesEvaluated: number;
  candidatesPruned: number;
  bestQuality: number;
  bestDescription: string | null;
}

export interface Constraint {
  readonly name: string;
  readonly isMonotone: boolean;
  /** Decide on per-candidate statistics; `size` is always present. */
  isSatisfied(stats: { size: number }): boolean;
}

/**
 * Monotone minimum-support constraint (spec §7.3). `minSupport(20)` = at
 * least 20 rows; `minSupport({ fraction: 0.05 })` resolves to
 * ceil(0.05 · N) at task preparation.
 */
export function minSupport(spec: number | { count?: number; fraction?: number }): Constraint {
  const normalized = typeof spec === "number" ? { count: spec } : spec;
  if (
    (normalized.count === undefined) === (normalized.fraction === undefined) ||
    (normalized.count !== undefined &&
      (!Number.isInteger(normalized.count) || normalized.count < 0)) ||
    (normalized.fraction !== undefined && !(normalized.fraction >= 0 && normalized.fraction <= 1))
  ) {
    throw new ValidationError(
      "minSupport: pass either a nonnegative integer count or { fraction } in [0, 1]",
    );
  }
  const resolve = (n: number): number =>
    normalized.count !== undefined ? normalized.count : Math.ceil(normalized.fraction! * n);
  let rows = -1;
  return {
    name:
      normalized.count !== undefined
        ? `minSupport(${normalized.count})`
        : `minSupport(fraction=${normalized.fraction})`,
    isMonotone: true,
    isSatisfied(stats) {
      return stats.size >= rows;
    },
    // resolved by prepareTask
    ...({
      __resolve(n: number) {
        rows = resolve(n);
        return rows;
      },
    } as object),
  };
}

export interface SubgroupTask {
  table: DataTable;
  target: Target;
  searchSpace: readonly Selector[];
  qf: QF;
  resultSetSize?: number;
  depth?: number;
  minQuality?: number;
  constraints?: readonly Constraint[];
  onProgress?: (progress: SearchProgress) => void;
  signal?: AbortSignal;
}

export interface PreparedTask {
  readonly table: DataTable;
  readonly target: Target;
  readonly prepared: PreparedTarget;
  readonly qf: QF;
  /** Deduplicated selectors in canonical §2.2 order (spec §7.1). */
  readonly selectors: readonly Selector[];
  /**
   * The selector-bitset atlas, built LAZILY on first access (memoized).
   * Engines that never materialize CPU covers — the GPU codes-mode fast
   * path with stats-carrying results (BRIEF §12/§8 P2) — skip the build
   * entirely; every other consumer is unaffected.
   */
  readonly atlas: SelectorAtlas;
  readonly k: number;
  readonly depth: number;
  readonly minQuality: number;
  readonly constraints: readonly Constraint[];
  readonly monotoneConstraints: readonly Constraint[];
  /** Resolved minimum-support row count over all monotone size constraints (0 if none). */
  readonly minSupportRows: number;
  readonly onProgress: ((progress: SearchProgress) => void) | null;
  readonly signal: AbortSignal | null;
}

export function prepareTask(task: SubgroupTask): PreparedTask {
  const { table } = task;
  const k = task.resultSetSize ?? 10;
  const depth = task.depth ?? 3;
  if (!Number.isInteger(k) || k < 1) {
    throw new ValidationError(`resultSetSize must be a positive integer, got ${k}`);
  }
  if (!Number.isInteger(depth) || depth < 1) {
    throw new ValidationError(`depth must be a positive integer, got ${depth}`);
  }

  // Selector validation: attributes exist and column kinds fit.
  const checkSelector = (sel: Selector): void => {
    if (sel.kind === "negated") {
      checkSelector(sel.inner);
      return;
    }
    const col = table.column(sel.attribute); // throws on unknown attribute
    if (sel.kind === "interval" && col.kind !== "numeric") {
      throw new ValidationError(
        `interval selector on ${JSON.stringify(sel.attribute)} requires a numeric column, ` +
          `got ${col.kind}`,
      );
    }
  };
  for (const sel of task.searchSpace) checkSelector(sel);

  const selectors = canonicalSelectors(task.searchSpace);
  if (selectors.length === 0) {
    throw new SearchSpaceError(
      "the search space is empty after deduplication; build one with allSelectors(table)",
    );
  }
  if (selectors.length > 65535) {
    throw new SearchSpaceError(
      `search space has ${selectors.length} selectors; the engines index selectors ` +
        `as Uint16 (max 65535) — reduce bins or split the space`,
    );
  }

  // Target-leak check (BRIEF §5.5): search-space selectors over target attributes.
  const targetAttrs = new Set(targetAttributes(task.target));
  if (targetAttrs.size > 0) {
    const leaking = selectors.filter((s) => targetAttrs.has(selectorAttribute(s)));
    if (leaking.length > 0) {
      throw new ValidationError(
        `${leaking.length} search-space selector(s) constrain target attribute(s) ` +
          `${[...targetAttrs].map((a) => JSON.stringify(a)).join(", ")}; ` +
          `use removeTargetAttributes(selectors, target) to drop them`,
      );
    }
  }

  const prepared = prepareTarget(table, task.target);
  // Stats-QF task-setup validation (spec §6.2: e.g. chiSquared requires
  // 0 < P < N). The kind guard makes the cast sound; a QF/target kind
  // mismatch itself is rejected later by the scorer.
  if (task.qf.kind !== "description" && task.qf.kind === prepared.kind) {
    (task.qf.validateTarget as ((p: PreparedTarget) => void) | undefined)?.(prepared);
  }
  const constraints = task.constraints ?? [];
  let minSupportRows = 0;
  for (const c of constraints) {
    const resolver = (c as unknown as { __resolve?: (n: number) => number }).__resolve;
    if (resolver) minSupportRows = Math.max(minSupportRows, resolver(table.nRows));
  }

  let atlas: SelectorAtlas | null = null;
  return {
    table,
    target: task.target,
    prepared,
    qf: task.qf,
    selectors,
    get atlas(): SelectorAtlas {
      if (atlas === null) atlas = buildAtlas(table, selectors);
      return atlas;
    },
    k,
    depth,
    minQuality: task.minQuality ?? Number.NEGATIVE_INFINITY,
    constraints,
    monotoneConstraints: constraints.filter((c) => c.isMonotone),
    minSupportRows,
    onProgress: task.onProgress ?? null,
    signal: task.signal ?? null,
  };
}
