/**
 * Worker-pool crash fixture (test/unit/worker-crash.test.ts): speaks just
 * enough of the wire protocol (src/backends/cpu/protocol.ts) to initialize
 * healthily, then answers every work request with an error reply —
 * simulating a worker whose kernel throws mid-task.
 */
import { parentPort } from "node:worker_threads";

parentPort.on("message", (msg) => {
  if (msg.type === "init") {
    parentPort.postMessage({ type: "ready", id: msg.id });
  } else {
    parentPort.postMessage({
      type: "error",
      id: msg.id ?? null,
      message: "crash-worker: simulated kernel failure",
    });
  }
});
