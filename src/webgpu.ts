/**
 * WebGPU backend registration for subgroup-web (`subgroup-web/webgpu`).
 *
 * The GPU `BatchEvaluator` lands in M6; this entry point exists from M0 so the
 * package `exports` map is stable.
 *
 * @packageDocumentation
 */

/** True when a WebGPU implementation is present in this environment. */
export function webgpuSupported(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.gpu !== "undefined";
}
