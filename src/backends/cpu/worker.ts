/**
 * Worker-pool worker entry (BRIEF §11). Runs in `node:worker_threads` AND in
 * browser `Worker({ type: "module" })` — the environment is detected at
 * startup. The worker instantiates the SAME `CpuEvaluator` class over the
 * shared (or copied) atlas and answers candidate shards with statistics
 * batches; qualities are never computed here (central ranking, BRIEF §7).
 *
 * Built as its own bundle entry (`dist/worker.js`, see tsdown.config.ts) so
 * the pool can address it by URL in both environments.
 *
 * IMPORTANT ordering constraint: in a browser dedicated worker, a message
 * dispatched while no listener is attached is dropped. The browser branch
 * therefore installs `onmessage` during the SYNCHRONOUS part of module
 * evaluation — no `await` may precede it on that path. Node's parentPort is
 * a MessagePort that buffers until a 'message' listener attaches, so the
 * dynamic `node:worker_threads` import is safe there.
 */

import { SelectorAtlas } from "../../bitset/atlas.js";
import type { StatsBatch } from "../types.js";
import { CpuEvaluator } from "./evaluator.js";
import {
  batchTransferables,
  fromWireTarget,
  type PoolReply,
  type PoolRequest,
} from "./protocol.js";

type PostFn = (msg: PoolReply, transfer?: ArrayBuffer[]) => void;

let evaluator: CpuEvaluator | null = null;

function handleMessage(msg: PoolRequest, post: PostFn): void {
  try {
    switch (msg.type) {
      case "init": {
        // Selector descriptors stay on the main thread; the evaluator only
        // needs offset math over the bit matrix. Re-init (worker reuse from
        // the process-level cache) simply replaces the evaluator.
        const atlas = new SelectorAtlas(msg.nRows, [], msg.bits, new Map());
        evaluator = new CpuEvaluator(atlas, fromWireTarget(msg.target), msg.plan);
        post({ type: "ready", id: msg.id });
        break;
      }
      case "tuples": {
        if (evaluator === null) throw new Error("worker received tuples before init");
        const batch = evaluator.evaluateTuples(msg.tuples, msg.arity, msg.count) as StatsBatch;
        post({ type: "stats", id: msg.id, batch }, batchTransferables(batch));
        break;
      }
      case "extensions": {
        if (evaluator === null) throw new Error("worker received extensions before init");
        const batch = evaluator.evaluateExtensions(
          msg.parent,
          msg.extensions,
          msg.op,
        ) as StatsBatch;
        post({ type: "stats", id: msg.id, batch }, batchTransferables(batch));
        break;
      }
    }
  } catch (err) {
    post({
      type: "error",
      id: (msg as { id?: number }).id ?? null,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

const isNode =
  typeof process !== "undefined" &&
  typeof (process as { versions?: { node?: string } }).versions?.node === "string";

if (!isNode) {
  // Browser dedicated worker: attach the handler SYNCHRONOUSLY (see above).
  const scope = globalThis as unknown as {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    onmessage: ((ev: MessageEvent) => void) | null;
  };
  const post: PostFn = (msg, transfer) => scope.postMessage(msg, transfer ?? []);
  scope.onmessage = (ev: MessageEvent) => handleMessage(ev.data as PoolRequest, post);
} else {
  const wt = await import("node:worker_threads");
  const pp = wt.parentPort;
  if (pp !== null) {
    const post: PostFn = (msg, transfer) => pp.postMessage(msg, transfer ?? []);
    pp.on("message", (msg: PoolRequest) => handleMessage(msg, post));
  }
}
