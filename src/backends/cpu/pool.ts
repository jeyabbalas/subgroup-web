/**
 * Worker-pool BatchEvaluator (BRIEF §11): shards candidate batches across
 * `node:worker_threads` / browser `Worker`s, each running the SAME
 * `CpuEvaluator` kernels (see worker.ts). Workers return statistics only;
 * scoring and ranking stay on the main thread — results are bit-identical
 * to the single-thread evaluator regardless of worker count or shard
 * boundaries, because each candidate's statistics depend only on its own
 * cover and the kernels are shared code.
 *
 * Memory regimes:
 * - SharedArrayBuffer (Node always; browsers when `crossOriginIsolated`):
 *   the atlas + target vectors are copied into SABs once and shared.
 * - Non-SAB (GitHub Pages, BRIEF §15): the init message clones the buffers
 *   into each worker once; per-batch traffic is still tuples in / stats out.
 */

import type { SelectorAtlas } from "../../bitset/atlas.js";
import { BackendError } from "../../errors.js";
import type { NumericStatsPlan } from "../../targets/stats.js";
import type { PreparedTarget } from "../../targets/types.js";
import type { BatchEvaluator, StatsBatch } from "../types.js";
import { allocBatch, CpuEvaluator } from "./evaluator.js";
import type { PoolReply, PoolRequest, WireTarget } from "./protocol.js";
import { toWireTarget } from "./protocol.js";

/** `workers` option shape (BRIEF §5.4). */
export interface WorkerPoolOptions {
  /** Worker count; default max(1, hardware concurrency − 1). */
  count?: number;
  /** Worker module URL; default `./worker.js` next to the built library. */
  script?: string | URL;
  /** Force the SAB (true) / copy (false) regime; default: autodetect. */
  sharedMemory?: boolean;
  /** Batches with ≤ this many candidates run on the main thread (default 256). */
  localThreshold?: number;
}

interface WorkerHandle {
  post(msg: PoolRequest, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (msg: PoolReply) => void): void;
  onError(handler: (err: Error) => void): void;
  terminate(): void;
}

interface Pending {
  resolve(batch: StatsBatch): void;
  reject(err: Error): void;
}

function isNode(): boolean {
  return (
    typeof process !== "undefined" &&
    typeof (process as { versions?: { node?: string } }).versions?.node === "string"
  );
}

/** SAB availability for this environment (Node: always; browser: isolated). */
export function sharedMemoryAvailable(): boolean {
  if (typeof SharedArrayBuffer === "undefined") return false;
  if (isNode()) return true;
  return (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated === true;
}

function defaultWorkerCount(): number {
  const hc =
    (globalThis as { navigator?: { hardwareConcurrency?: number } }).navigator
      ?.hardwareConcurrency ?? 4;
  return Math.max(1, hc - 1);
}

/**
 * Resolve the worker module URL. From the built package this is
 * `dist/worker.js` next to `dist/index.js`; when running from TypeScript
 * sources (vitest), probe upward for `dist/worker.js` (the gate builds
 * before testing). Browsers always use the sibling URL (or an explicit
 * `script` option, e.g. a Vite `?url` asset).
 */
async function resolveWorkerScript(explicit: string | URL | undefined): Promise<string | URL> {
  if (explicit !== undefined) return explicit;
  const sibling = new URL("./worker.js", import.meta.url);
  if (!isNode()) return sibling;
  const { existsSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const candidates = [
    sibling,
    new URL("../../../dist/worker.js", import.meta.url), // src/backends/cpu → repo root
    new URL("../../dist/worker.js", import.meta.url),
    new URL("../dist/worker.js", import.meta.url),
  ];
  for (const url of candidates) {
    try {
      if (existsSync(fileURLToPath(url))) return url;
    } catch {
      // non-file URL — skip
    }
  }
  throw new BackendError(
    "worker script not found: build the library first (`pnpm build` emits dist/worker.js) " +
      "or pass workers: { script } explicitly",
  );
}

async function spawnWorker(script: string | URL): Promise<WorkerHandle> {
  if (isNode()) {
    const { Worker } = await import("node:worker_threads");
    const w = new Worker(script);
    return {
      post: (msg, transfer) => w.postMessage(msg, transfer as readonly ArrayBuffer[]),
      onMessage: (handler) => w.on("message", handler),
      onError: (handler) => w.on("error", handler),
      terminate: () => void w.terminate(),
    };
  }
  const w = new Worker(script, { type: "module" });
  return {
    post: (msg, transfer) => w.postMessage(msg, transfer ?? []),
    onMessage: (handler) => {
      w.onmessage = (ev: MessageEvent) => handler(ev.data as PoolReply);
    },
    onError: (handler) => {
      w.onerror = (ev: ErrorEvent) => handler(new Error(ev.message || "worker error"));
    },
    terminate: () => w.terminate(),
  };
}

function intoShared<T extends Uint32Array | Float64Array>(
  src: T,
  ctor: new (buffer: SharedArrayBuffer) => T,
): T {
  const sab = new SharedArrayBuffer(src.byteLength);
  const out = new ctor(sab);
  out.set(src as never);
  return out;
}

/** Copy the wire target's vectors into SABs (shared-memory regime). */
function shareWireTarget(wire: WireTarget): WireTarget {
  switch (wire.kind) {
    case "binary":
      return { ...wire, positivesBits: intoShared(wire.positivesBits, Uint32Array) };
    case "numeric":
      return { ...wire, values: intoShared(wire.values, Float64Array) };
    case "emm":
      return {
        ...wire,
        x: intoShared(wire.x, Float64Array),
        y: intoShared(wire.y, Float64Array),
      };
    case "fi":
      return wire;
  }
}

export class WorkerPoolEvaluator implements BatchEvaluator {
  readonly name: string;
  readonly screening = false;
  readonly workerCount: number;
  readonly sharedMemory: boolean;
  private readonly handles: WorkerHandle[];
  private readonly local: CpuEvaluator;
  private readonly localThreshold: number;
  private readonly prepared: PreparedTarget;
  private readonly plan: NumericStatsPlan | null;
  private readonly pending = new Map<number, Pending>();
  private seq = 0;
  private dead: Error | null = null;
  private disposed = false;

  private constructor(
    handles: WorkerHandle[],
    local: CpuEvaluator,
    prepared: PreparedTarget,
    plan: NumericStatsPlan | null,
    sharedMemory: boolean,
    localThreshold: number,
  ) {
    this.handles = handles;
    this.local = local;
    this.prepared = prepared;
    this.plan = plan;
    this.workerCount = handles.length;
    this.sharedMemory = sharedMemory;
    this.localThreshold = localThreshold;
    this.name = `cpu-workers(${handles.length}${sharedMemory ? ",sab" : ""})`;
    for (const h of handles) {
      h.onMessage((msg) => this.onReply(msg));
      h.onError((err) => this.fail(new BackendError(`worker crashed: ${err.message}`)));
    }
  }

  /** Spawn + initialize the pool (workers ack before this resolves). */
  static async create(
    atlas: SelectorAtlas,
    prepared: PreparedTarget,
    plan: NumericStatsPlan | null,
    options: WorkerPoolOptions = {},
  ): Promise<WorkerPoolEvaluator> {
    const count = Math.max(1, options.count ?? defaultWorkerCount());
    const sharedMemory = options.sharedMemory ?? sharedMemoryAvailable();
    if (sharedMemory && typeof SharedArrayBuffer === "undefined") {
      throw new BackendError("workers.sharedMemory: SharedArrayBuffer is not available here");
    }
    const script = await resolveWorkerScript(options.script);
    const handles = await Promise.all(Array.from({ length: count }, () => spawnWorker(script)));

    let bits = atlas.bits;
    let wire = toWireTarget(prepared);
    if (sharedMemory) {
      bits = intoShared(bits, Uint32Array);
      wire = shareWireTarget(wire);
    }
    const pool = new WorkerPoolEvaluator(
      handles,
      new CpuEvaluator(atlas, prepared, plan),
      prepared,
      plan,
      sharedMemory,
      options.localThreshold ?? 256,
    );
    await Promise.all(
      handles.map(
        (h, i) =>
          new Promise<void>((resolve, reject) => {
            pool.pending.set(-1 - i, {
              resolve: () => resolve(),
              reject,
            } as unknown as Pending);
            h.post({ type: "init", nRows: atlas.nRows, bits, target: wire, plan });
          }),
      ),
    );
    return pool;
  }

  private onReply(msg: PoolReply): void {
    if (msg.type === "ready") {
      // Resolve the first outstanding init slot (negative ids).
      for (const [id, p] of this.pending) {
        if (id < 0) {
          this.pending.delete(id);
          (p.resolve as () => void)();
          return;
        }
      }
      return;
    }
    if (msg.type === "error") {
      this.fail(new BackendError(`worker error: ${msg.message}`));
      return;
    }
    const p = this.pending.get(msg.id);
    if (p !== undefined) {
      this.pending.delete(msg.id);
      p.resolve(msg.batch);
    }
  }

  private fail(err: Error): void {
    this.dead = err;
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  private call(worker: number, msg: PoolRequest, transfer: ArrayBuffer[]): Promise<StatsBatch> {
    return new Promise<StatsBatch>((resolve, reject) => {
      if (this.dead) {
        reject(this.dead);
        return;
      }
      this.pending.set((msg as { id: number }).id, { resolve, reject });
      this.handles[worker]!.post(msg, transfer);
    });
  }

  /** Contiguous shards of `count` candidates over the pool. */
  private shards(count: number): { start: number; count: number }[] {
    const per = Math.ceil(count / this.workerCount);
    const out: { start: number; count: number }[] = [];
    for (let start = 0; start < count; start += per) {
      out.push({ start, count: Math.min(per, count - start) });
    }
    return out;
  }

  private stitch(parts: StatsBatch[], counts: number[], total: number): StatsBatch {
    const out = allocBatch(total, this.prepared, this.plan);
    const fields = [
      "size",
      "positives",
      "sum",
      "excessSum",
      "tailCount",
      "tailExtreme",
      "median",
      "std",
      "orderEstimate",
      "emmSlope",
      "emmIntercept",
      "emmSgLikelihood",
      "emmComplementLikelihood",
    ] as const;
    let offset = 0;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]!;
      for (const f of fields) {
        const dst = out[f];
        const src = part[f];
        if (dst !== null && src !== null) (dst as Uint32Array).set(src as Uint32Array, offset);
      }
      offset += counts[i]!;
    }
    return out;
  }

  async evaluateTuples(tuples: Uint16Array, arity: number, count: number): Promise<StatsBatch> {
    if (this.dead) throw this.dead;
    if (count <= this.localThreshold) return this.local.evaluateTuples(tuples, arity, count);
    const shards = this.shards(count);
    const parts = await Promise.all(
      shards.map((s, i) => {
        const slice = tuples.slice(s.start * arity, (s.start + s.count) * arity);
        return this.call(
          i % this.workerCount,
          { type: "tuples", id: ++this.seq, tuples: slice, arity, count: s.count },
          [slice.buffer as ArrayBuffer],
        );
      }),
    );
    return this.stitch(
      parts,
      shards.map((s) => s.count),
      count,
    );
  }

  async evaluateExtensions(
    parent: Uint32Array | null,
    extensions: ArrayLike<number>,
    op: "and" | "or" = "and",
  ): Promise<StatsBatch> {
    if (this.dead) throw this.dead;
    const count = extensions.length;
    if (count <= this.localThreshold) return this.local.evaluateExtensions(parent, extensions, op);
    const ids = Uint16Array.from(extensions as ArrayLike<number>);
    const shards = this.shards(count);
    const parts = await Promise.all(
      shards.map((s, i) => {
        const slice = ids.slice(s.start, s.start + s.count);
        const parentCopy = parent === null ? null : parent.slice();
        const transfer: ArrayBuffer[] = [slice.buffer as ArrayBuffer];
        if (parentCopy !== null) transfer.push(parentCopy.buffer as ArrayBuffer);
        return this.call(
          i % this.workerCount,
          { type: "extensions", id: ++this.seq, parent: parentCopy, extensions: slice, op },
          transfer,
        );
      }),
    );
    return this.stitch(
      parts,
      shards.map((s) => s.count),
      count,
    );
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fail(new BackendError("worker pool disposed"));
    for (const h of this.handles) h.terminate();
  }
}
