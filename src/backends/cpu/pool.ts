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
 *
 * Worker PROCESSES are cached at module level and re-initialized per task
 * (classic thread-pool design): spawning threads costs 10–20 ms each, which
 * would otherwise dominate short searches. Cached idle workers are unref'd
 * in Node so they never hold the process open; message ids are globally
 * unique so late replies from a previous task can never be mistaken for
 * current ones.
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
  /** Milliseconds to wait for worker startup before failing (default 30000). */
  spawnTimeoutMs?: number;
  /** Bypass the process-level worker cache (spawn fresh, terminate on dispose). */
  noCache?: boolean;
}

interface WorkerHandle {
  post(msg: PoolRequest, transfer?: ArrayBuffer[]): void;
  setHandlers(
    onMessage: ((msg: PoolReply) => void) | null,
    onError: ((err: Error) => void) | null,
  ): void;
  ref(): void;
  unref(): void;
  terminate(): void;
}

interface Pending {
  resolve(batch: StatsBatch): void;
  reject(err: Error): void;
}

/** Globally unique message ids (workers are reused across pools). */
let nextMessageId = 1;

/** Idle spawned workers by script key (returned by dispose, unref'd). */
const workerCache = new Map<string, WorkerHandle[]>();

/** Terminate every cached idle worker (bench teardown / leak audits). */
export function terminateCachedWorkers(): void {
  for (const [, handles] of workerCache) {
    for (const h of handles) h.terminate();
  }
  workerCache.clear();
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
    let onMessage: ((msg: PoolReply) => void) | null = null;
    let onError: ((err: Error) => void) | null = null;
    w.on("message", (m: PoolReply) => onMessage?.(m));
    w.on("error", (e: Error) => onError?.(e));
    return {
      post: (msg, transfer) => w.postMessage(msg, (transfer ?? []) as readonly ArrayBuffer[]),
      setHandlers: (m, e) => {
        onMessage = m;
        onError = e;
      },
      ref: () => w.ref(),
      unref: () => w.unref(),
      terminate: () => void w.terminate(),
    };
  }
  const w = new Worker(script, { type: "module" });
  let onMessage: ((msg: PoolReply) => void) | null = null;
  let onError: ((err: Error) => void) | null = null;
  w.onmessage = (ev: MessageEvent) => onMessage?.(ev.data as PoolReply);
  w.onerror = (ev: ErrorEvent) => onError?.(new Error(ev.message || "worker error"));
  return {
    post: (msg, transfer) => w.postMessage(msg, transfer ?? []),
    setHandlers: (m, e) => {
      onMessage = m;
      onError = e;
    },
    ref: () => {},
    unref: () => {},
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
  private readonly scriptKey: string;
  private readonly cacheable: boolean;
  private readonly local: CpuEvaluator;
  private readonly localThreshold: number;
  private readonly prepared: PreparedTarget;
  private readonly plan: NumericStatsPlan | null;
  private readonly pending = new Map<number, Pending>();
  private dead: Error | null = null;
  private disposed = false;

  private constructor(
    handles: WorkerHandle[],
    scriptKey: string,
    cacheable: boolean,
    local: CpuEvaluator,
    prepared: PreparedTarget,
    plan: NumericStatsPlan | null,
    sharedMemory: boolean,
    localThreshold: number,
  ) {
    this.handles = handles;
    this.scriptKey = scriptKey;
    this.cacheable = cacheable;
    this.local = local;
    this.prepared = prepared;
    this.plan = plan;
    this.workerCount = handles.length;
    this.sharedMemory = sharedMemory;
    this.localThreshold = localThreshold;
    this.name = `cpu-workers(${handles.length}${sharedMemory ? ",sab" : ""})`;
    for (const h of handles) {
      h.ref();
      h.setHandlers(
        (msg) => this.onReply(msg),
        (err) => this.fail(new BackendError(`worker crashed: ${err.message}`)),
      );
    }
  }

  /** Spawn/reuse + initialize the pool (workers ack before this resolves). */
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
    const scriptKey = String(script);
    const cacheable = options.noCache !== true;
    const handles: WorkerHandle[] = [];
    if (cacheable) {
      const idle = workerCache.get(scriptKey) ?? [];
      while (handles.length < count && idle.length > 0) handles.push(idle.pop()!);
      workerCache.set(scriptKey, idle);
    }
    try {
      while (handles.length < count) handles.push(await spawnWorker(script));
    } catch (err) {
      // Spawn failed mid-loop: terminate what was already acquired instead
      // of leaking it — and never re-cache workers from a failing
      // environment.
      for (const h of handles) h.terminate();
      throw err;
    }

    let bits = atlas.bits;
    let wire = toWireTarget(prepared);
    if (sharedMemory) {
      bits = intoShared(bits, Uint32Array);
      wire = shareWireTarget(wire);
    }
    const pool = new WorkerPoolEvaluator(
      handles,
      scriptKey,
      cacheable,
      new CpuEvaluator(atlas, prepared, plan),
      prepared,
      plan,
      sharedMemory,
      options.localThreshold ?? 256,
    );
    const spawnTimeoutMs = options.spawnTimeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      pool.fail(
        new BackendError(
          `worker pool startup timed out after ${spawnTimeoutMs} ms — the worker script ` +
            `(${scriptKey}) may be unreachable or failing to load`,
        ),
      );
    }, spawnTimeoutMs);
    try {
      await Promise.all(
        handles.map(
          (h) =>
            new Promise<void>((resolve, reject) => {
              const id = nextMessageId++;
              pool.pending.set(id, {
                resolve: () => resolve(),
                reject,
              } as unknown as Pending);
              h.post({ type: "init", id, nRows: atlas.nRows, bits, target: wire, plan });
            }),
        ),
      );
    } catch (err) {
      pool.dispose();
      throw err;
    } finally {
      clearTimeout(timer);
    }
    return pool;
  }

  private onReply(msg: PoolReply): void {
    if (msg.type === "error") {
      this.fail(new BackendError(`worker error: ${msg.message}`));
      return;
    }
    const p = this.pending.get(msg.id);
    if (p === undefined) return; // stale reply from a previous task — ignore
    this.pending.delete(msg.id);
    if (msg.type === "ready") {
      (p.resolve as unknown as () => void)();
    } else {
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
          { type: "tuples", id: nextMessageId++, tuples: slice, arity, count: s.count },
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
          { type: "extensions", id: nextMessageId++, parent: parentCopy, extensions: slice, op },
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
    const healthy = this.dead === null;
    this.fail(new BackendError("worker pool disposed"));
    if (healthy && this.cacheable) {
      const idle = workerCache.get(this.scriptKey) ?? [];
      for (const h of this.handles) {
        h.setHandlers(null, null);
        h.unref();
        idle.push(h);
      }
      workerCache.set(this.scriptKey, idle);
    } else {
      for (const h of this.handles) h.terminate();
    }
  }
}
