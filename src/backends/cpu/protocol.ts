/**
 * Worker-pool wire protocol (BRIEF §11). Messages carry typed arrays only —
 * structured clone shares SharedArrayBuffer backings zero-copy and copies
 * plain buffers, so the same code path serves the SAB (Node, cross-origin-
 * isolated browsers) and non-SAB (GitHub Pages) regimes.
 *
 * Workers receive the atlas + the target's evaluation vectors ONCE at init
 * and afterwards exchange candidate shards for statistics — never covers,
 * never qualities (ranking stays central, BRIEF §7/§11).
 */

import type { NumericStatsPlan } from "../../targets/stats.js";
import type {
  PreparedBinary,
  PreparedEMM,
  PreparedFI,
  PreparedNumeric,
  PreparedTarget,
} from "../../targets/types.js";
import type { StatsBatch } from "../types.js";

/** The subset of a PreparedTarget the bitset statistics kernels consume. */
export type WireTarget =
  | { kind: "binary"; n: number; positives: number; positivesBits: Uint32Array }
  | {
      kind: "numeric";
      n: number;
      values: Float64Array;
      mean: number;
      median: number;
      std: number;
      min: number;
      max: number;
    }
  | { kind: "fi"; n: number }
  | { kind: "emm"; n: number; x: Float64Array; y: Float64Array };

export interface InitMessage {
  type: "init";
  nRows: number;
  /** Selector-major atlas bit matrix (possibly SAB-backed). */
  bits: Uint32Array;
  target: WireTarget;
  plan: NumericStatsPlan | null;
}

export interface TuplesMessage {
  type: "tuples";
  id: number;
  tuples: Uint16Array;
  arity: number;
  count: number;
}

export interface ExtensionsMessage {
  type: "extensions";
  id: number;
  parent: Uint32Array | null;
  extensions: Uint16Array;
  op: "and" | "or";
}

export type PoolRequest = InitMessage | TuplesMessage | ExtensionsMessage;

export interface ReadyReply {
  type: "ready";
}

export interface StatsReply {
  type: "stats";
  id: number;
  batch: StatsBatch;
}

export interface ErrorReply {
  type: "error";
  id: number | null;
  message: string;
}

export type PoolReply = ReadyReply | StatsReply | ErrorReply;

/** Extract the wire form of a prepared target (drops row-scan masks). */
export function toWireTarget(prepared: PreparedTarget): WireTarget {
  switch (prepared.kind) {
    case "binary":
      return {
        kind: "binary",
        n: prepared.n,
        positives: prepared.positives,
        positivesBits: prepared.positivesBits,
      };
    case "numeric":
      return {
        kind: "numeric",
        n: prepared.n,
        values: prepared.values,
        mean: prepared.mean,
        median: prepared.median,
        std: prepared.std,
        min: prepared.min,
        max: prepared.max,
      };
    case "fi":
      return { kind: "fi", n: prepared.n };
    case "emm":
      return { kind: "emm", n: prepared.n, x: prepared.x, y: prepared.y };
  }
}

/**
 * Rebuild a PreparedTarget from its wire form. The row-scan mask of the
 * binary target is intentionally empty: workers evaluate through the bitset
 * kernels exclusively (the identical code path as the single-thread
 * evaluator, which is what makes worker results bit-identical).
 */
export function fromWireTarget(wire: WireTarget): PreparedTarget {
  switch (wire.kind) {
    case "binary": {
      const prepared: PreparedBinary = {
        kind: "binary",
        n: wire.n,
        positives: wire.positives,
        positivesMask: new Uint8Array(0),
        positivesBits: wire.positivesBits,
      };
      return prepared;
    }
    case "numeric": {
      const prepared: PreparedNumeric = {
        kind: "numeric",
        n: wire.n,
        values: wire.values,
        mean: wire.mean,
        median: wire.median,
        std: wire.std,
        min: wire.min,
        max: wire.max,
        descOrder: null,
      };
      return prepared;
    }
    case "fi": {
      const prepared: PreparedFI = { kind: "fi", n: wire.n };
      return prepared;
    }
    case "emm": {
      const prepared: PreparedEMM = { kind: "emm", n: wire.n, x: wire.x, y: wire.y };
      return prepared;
    }
  }
}

/** Transferable buffers of a stats batch (all arrays are freshly allocated). */
export function batchTransferables(batch: StatsBatch): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const push = (a: { buffer: ArrayBufferLike } | null): void => {
    if (a !== null && a.buffer instanceof ArrayBuffer) out.push(a.buffer);
  };
  push(batch.size);
  push(batch.positives);
  push(batch.sum);
  push(batch.excessSum);
  push(batch.tailCount);
  push(batch.tailExtreme);
  push(batch.median);
  push(batch.std);
  push(batch.orderEstimate);
  push(batch.emmSlope);
  push(batch.emmIntercept);
  push(batch.emmSgLikelihood);
  push(batch.emmComplementLikelihood);
  return out;
}
