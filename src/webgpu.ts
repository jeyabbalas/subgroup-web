/**
 * WebGPU backend registration for subgroup-web (`subgroup-web/webgpu`).
 *
 * ```ts
 * import { registerWebGpu } from "subgroup-web/webgpu";
 * registerWebGpu();                     // browser: navigator.gpu
 * // or with an injected device (Node + Dawn bindings, BRIEF §13):
 * registerWebGpu({ device });
 * const results = await apriori(task, { backend: "webgpu" });
 * ```
 *
 * The factory negotiates elevated limits up to the adapter's
 * (maxStorageBufferBindingSize / maxBufferSize — the atlas wants one big
 * binding, BRIEF §12), caches the device across evaluators, re-requests it
 * after `device.lost`, and declines tasks outside GPU applicability so the
 * engine falls back to CPU cleanly (docs/design.md §backend applicability).
 *
 * @packageDocumentation
 */

import { registerGpuEvaluatorFactory } from "./backends/registry.js";
import type { WebGpuEvaluatorOptions } from "./backends/webgpu/evaluator.js";
import { gpuApplicable, WebGpuEvaluator } from "./backends/webgpu/evaluator.js";
import { BackendError } from "./errors.js";

export type { WebGpuEvaluatorOptions } from "./backends/webgpu/evaluator.js";
export { gpuApplicable, WebGpuEvaluator } from "./backends/webgpu/evaluator.js";

/** True when a WebGPU implementation is present in this environment. */
export function webgpuSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";
}

export interface RequestDeviceOptions {
  powerPreference?: GPUPowerPreference;
}

/**
 * Request an adapter + device with limits raised to the adapter's maxima for
 * the limits subgroup-web uses. Throws a typed BackendError when WebGPU or
 * an adapter is unavailable (BRIEF §12: fail with an actionable message).
 */
export async function requestSubgroupWebDevice(
  options: RequestDeviceOptions = {},
): Promise<GPUDevice> {
  if (!webgpuSupported()) {
    throw new BackendError(
      "WebGPU unavailable: navigator.gpu missing (secure context + Chromium-family " +
        "browser required; on Node inject a Dawn device via registerWebGpu({ device }))",
    );
  }
  const adapter = await navigator.gpu.requestAdapter({
    powerPreference: options.powerPreference ?? "high-performance",
  });
  if (adapter === null) {
    throw new BackendError(
      "WebGPU unavailable: requestAdapter() returned null — check browser flags " +
        "(--enable-unsafe-webgpu) or GPU availability",
    );
  }
  const l = adapter.limits;
  return adapter.requestDevice({
    label: "subgroup-web",
    requiredLimits: {
      maxStorageBufferBindingSize: l.maxStorageBufferBindingSize,
      maxBufferSize: l.maxBufferSize,
      maxStorageBuffersPerShaderStage: l.maxStorageBuffersPerShaderStage,
    },
  });
}

export interface RegisterWebGpuOptions extends RequestDeviceOptions {
  /** Use this device instead of requesting one (Node Dawn / app-managed). */
  device?: GPUDevice;
  /** Forwarded to every evaluator (test hooks, dispatch budget). */
  evaluator?: WebGpuEvaluatorOptions;
}

let cachedDevice: Promise<GPUDevice> | null = null;

async function deviceFor(options: RegisterWebGpuOptions): Promise<GPUDevice> {
  if (options.device !== undefined) return options.device;
  if (cachedDevice === null) {
    cachedDevice = requestSubgroupWebDevice(options).then((device) => {
      device.lost.then(
        () => {
          cachedDevice = null; // re-request on next use
        },
        () => {},
      );
      return device;
    });
    cachedDevice.catch(() => {
      cachedDevice = null;
    });
  }
  return cachedDevice;
}

/**
 * Plug the WebGPU BatchEvaluator factory into the engine registry, enabling
 * `backend: 'webgpu' | 'auto'` on search options. Idempotent; the last
 * registration wins.
 */
export function registerWebGpu(options: RegisterWebGpuOptions = {}): void {
  registerGpuEvaluatorFactory(async (req) => {
    const task = req.task;
    const plan = task.qf.kind === "numeric" ? task.qf.plan : null;
    if (!gpuApplicable(task.prepared, plan)) return null;
    const device = req.device ?? (await deviceFor(options));
    return WebGpuEvaluator.create(device, task, { ...(options.evaluator ?? {}) });
  });
}

/** Remove the registered factory (backend: 'webgpu' will then throw). */
export function unregisterWebGpu(): void {
  registerGpuEvaluatorFactory(null);
}
