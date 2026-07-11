/**
 * Backend registry (BRIEF §10/§13): the main entry (`subgroup-web`) is
 * GPU-free; importing `subgroup-web/webgpu` and calling `registerWebGpu()`
 * plugs a WebGPU evaluator factory into this slot. Search engines consult it
 * through `resolveEvaluator` (engine.ts) when `backend: 'webgpu' | 'auto'`.
 */

import type { PreparedTask } from "../search/task.js";
import type { BatchEvaluator } from "./types.js";

export interface GpuFactoryRequest {
  /**
   * The prepared task. `task.atlas` is a LAZY build — GPU evaluators that
   * can construct their atlas on-device (codes mode) must not touch it.
   */
  task: PreparedTask;
  /** Injected GPUDevice (Node/Dawn or an app-managed device); optional. */
  device?: GPUDevice;
}

/**
 * Returns an evaluator, or null when this task is outside the GPU backend's
 * applicability (target kind / statistics plan; see docs/design.md) — the
 * engine then falls back to the CPU backend cleanly.
 */
export type GpuEvaluatorFactory = (req: GpuFactoryRequest) => Promise<BatchEvaluator | null>;

let gpuFactory: GpuEvaluatorFactory | null = null;

export function registerGpuEvaluatorFactory(factory: GpuEvaluatorFactory | null): void {
  gpuFactory = factory;
}

export function getGpuEvaluatorFactory(): GpuEvaluatorFactory | null {
  return gpuFactory;
}
