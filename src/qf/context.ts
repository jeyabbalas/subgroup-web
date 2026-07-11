/**
 * Cover-based evaluation context (spec §6): computes per-description
 * statistics from row-scan covers with canonical-key caching, and dispatches
 * QF evaluation. This is the reference-shaped, obviously-correct evaluation
 * path used by micro-fixtures, the differential formula runner, and the
 * oracle's cross-checks; search engines add batched bitset paths on top.
 */

import type { Conjunction } from "../desc/conjunction.js";
import { ValidationError } from "../errors.js";
import type { DataTable } from "../table/table.js";
import { type EmmCoverStats, emmStatsFromMask } from "../targets/emm.js";
import {
  type BinaryCoverStats,
  binaryStatsFromMask,
  type FiCoverStats,
  type NumericCoverStats,
  type NumericStatsPlan,
  numericStatsFromMask,
  sizeFromMask,
} from "../targets/stats.js";
import type { PreparedTarget } from "../targets/types.js";
import type { EvalContext, QF } from "./types.js";

function planKey(plan: NumericStatsPlan): string {
  return [
    plan.centroid,
    plan.direction,
    plan.needStd ? 1 : 0,
    plan.needMedian ? 1 : 0,
    plan.needExcess ? 1 : 0,
    plan.needTail ? 1 : 0,
    plan.needOrder ? 1 : 0,
    plan.orderA,
  ].join("|");
}

export class CoverEvalContext implements EvalContext {
  readonly nRows: number;
  private readonly table: DataTable;
  private readonly prepared: PreparedTarget;
  private readonly coverCache = new Map<string, Uint8Array>();
  private readonly binaryCache = new Map<string, BinaryCoverStats>();
  private readonly numericCache = new Map<string, NumericCoverStats>();
  private readonly fiCache = new Map<string, FiCoverStats>();
  private readonly emmCache = new Map<string, EmmCoverStats>();

  constructor(table: DataTable, prepared: PreparedTarget) {
    this.table = table;
    this.prepared = prepared;
    this.nRows = table.nRows;
  }

  coverOf(desc: Conjunction): Uint8Array {
    const key = desc.canonicalKey();
    let cover = this.coverCache.get(key);
    if (cover === undefined) {
      cover = desc.covers(this.table);
      this.coverCache.set(key, cover);
    }
    return cover;
  }

  binaryStats(desc: Conjunction): BinaryCoverStats {
    if (this.prepared.kind !== "binary") {
      throw new ValidationError(`binaryStats on a ${this.prepared.kind} target`);
    }
    const key = desc.canonicalKey();
    let s = this.binaryCache.get(key);
    if (s === undefined) {
      s = binaryStatsFromMask(this.prepared, this.coverOf(desc));
      this.binaryCache.set(key, s);
    }
    return s;
  }

  numericStats(desc: Conjunction, plan: NumericStatsPlan): NumericCoverStats {
    if (this.prepared.kind !== "numeric") {
      throw new ValidationError(`numericStats on a ${this.prepared.kind} target`);
    }
    const key = `${desc.canonicalKey()} @ ${planKey(plan)}`;
    let s = this.numericCache.get(key);
    if (s === undefined) {
      s = numericStatsFromMask(this.prepared, this.coverOf(desc), plan);
      this.numericCache.set(key, s);
    }
    return s;
  }

  fiStats(desc: Conjunction): FiCoverStats {
    if (this.prepared.kind !== "fi") {
      throw new ValidationError(`fiStats on a ${this.prepared.kind} target`);
    }
    const key = desc.canonicalKey();
    let s = this.fiCache.get(key);
    if (s === undefined) {
      s = { size: sizeFromMask(this.coverOf(desc)), depth: desc.depth };
      this.fiCache.set(key, s);
    }
    return s;
  }

  emmStats(desc: Conjunction): EmmCoverStats {
    if (this.prepared.kind !== "emm") {
      throw new ValidationError(`emmStats on a ${this.prepared.kind} target`);
    }
    const key = desc.canonicalKey();
    let s = this.emmCache.get(key);
    if (s === undefined) {
      s = emmStatsFromMask(this.prepared, this.coverOf(desc));
      this.emmCache.set(key, s);
    }
    return s;
  }

  evaluate(qf: QF, desc: Conjunction): number {
    switch (qf.kind) {
      case "binary": {
        const s = this.binaryStats(desc);
        return qf.evaluate(s.size, s.positives, this.requireKind("binary"));
      }
      case "numeric":
        return qf.evaluate(this.numericStats(desc, qf.plan), this.requireKind("numeric"));
      case "fi":
        return qf.evaluate(this.fiStats(desc), this.requireKind("fi"));
      case "emm":
        return qf.evaluate(this.emmStats(desc), this.requireKind("emm"));
      case "description":
        return qf.evaluate(desc, this);
    }
  }

  optimisticEstimate(qf: QF, desc: Conjunction): number {
    switch (qf.kind) {
      case "binary": {
        if (qf.optimisticEstimate === undefined) return Number.POSITIVE_INFINITY;
        const s = this.binaryStats(desc);
        return qf.optimisticEstimate(s.size, s.positives, this.requireKind("binary"));
      }
      case "numeric":
        if (qf.optimisticEstimate === undefined) return Number.POSITIVE_INFINITY;
        return qf.optimisticEstimate(this.numericStats(desc, qf.plan), this.requireKind("numeric"));
      case "fi":
        if (qf.optimisticEstimate === undefined) return Number.POSITIVE_INFINITY;
        return qf.optimisticEstimate(this.fiStats(desc), this.requireKind("fi"));
      case "emm":
        return Number.POSITIVE_INFINITY;
      case "description":
        if (qf.optimisticEstimate === undefined) return Number.POSITIVE_INFINITY;
        return qf.optimisticEstimate(desc, this);
    }
  }

  private requireKind<K extends PreparedTarget["kind"]>(
    kind: K,
  ): Extract<PreparedTarget, { kind: K }> {
    if (this.prepared.kind !== kind) {
      throw new ValidationError(`QF expects a ${kind} target, task has ${this.prepared.kind}`);
    }
    return this.prepared as Extract<PreparedTarget, { kind: K }>;
  }
}
