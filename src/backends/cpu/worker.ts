/**
 * Worker-pool worker entry (BRIEF §11). Runs in `node:worker_threads` AND in
 * browser `Worker({ type: "module" })` — the environment is detected at
 * startup. The worker instantiates the SAME `CpuEvaluator` class over the
 * shared (or copied) atlas and answers candidate shards with statistics
 * batches; qualities are never computed here (central ranking, BRIEF §7).
 *
 * Built as its own bundle entry (`dist/worker.js`, see tsdown.config.ts) so
 * the pool can address it by URL in both environments.
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

interface Port {
  post(msg: PoolReply, transfer?: ArrayBuffer[]): void;
  onMessage(handler: (msg: PoolRequest) => void): void;
}

async function resolvePort(): Promise<Port> {
  // Node worker_threads?
  try {
    const wt = await import("node:worker_threads");
    if (wt.parentPort) {
      const pp = wt.parentPort;
      return {
        post: (msg, transfer) => pp.postMessage(msg, transfer ?? []),
        onMessage: (handler) => pp.on("message", handler),
      };
    }
  } catch {
    // not Node — fall through to the browser worker scope
  }
  const scope = globalThis as unknown as {
    postMessage(msg: unknown, transfer?: Transferable[]): void;
    onmessage: ((ev: MessageEvent) => void) | null;
  };
  return {
    post: (msg, transfer) => scope.postMessage(msg, transfer ?? []),
    onMessage: (handler) => {
      scope.onmessage = (ev: MessageEvent) => handler(ev.data as PoolRequest);
    },
  };
}

const port = await resolvePort();
let evaluator: CpuEvaluator | null = null;

port.onMessage((msg) => {
  try {
    switch (msg.type) {
      case "init": {
        // Selector descriptors stay on the main thread; the evaluator only
        // needs offset math over the bit matrix.
        const atlas = new SelectorAtlas(msg.nRows, [], msg.bits, new Map());
        evaluator = new CpuEvaluator(atlas, fromWireTarget(msg.target), msg.plan);
        port.post({ type: "ready" });
        break;
      }
      case "tuples": {
        if (evaluator === null) throw new Error("worker received tuples before init");
        const batch = evaluator.evaluateTuples(msg.tuples, msg.arity, msg.count) as StatsBatch;
        port.post({ type: "stats", id: msg.id, batch }, batchTransferables(batch));
        break;
      }
      case "extensions": {
        if (evaluator === null) throw new Error("worker received extensions before init");
        const batch = evaluator.evaluateExtensions(
          msg.parent,
          msg.extensions,
          msg.op,
        ) as StatsBatch;
        port.post({ type: "stats", id: msg.id, batch }, batchTransferables(batch));
        break;
      }
    }
  } catch (err) {
    port.post({
      type: "error",
      id: msg.type === "init" ? null : msg.id,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
