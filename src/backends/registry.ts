/**
 * Backend registry (BRIEF §10/§13): the main entry (`subgroup-web`) is
 * GPU-free; importing `subgroup-web/webgpu` and calling `registerWebGpu()`
 * plugs a WebGPU evaluator factory into this slot. Search engines consult it
 * through `resolveEvaluator` (engine.ts) when `backend: 'webgpu' | 'auto'`.
 */

import type { SelectorAtlas } from "../bitset/atlas.js";
import type { NumericStatsPlan } from "../targets/stats.js";
import type { PreparedTarget } from "../targets/types.js";
import type { BatchEvaluator } from "./types.js";

export interface GpuFactoryRequest {
  atlas: SelectorAtlas;
  prepared: PreparedTarget;
  plan: NumericStatsPlan | null;
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
