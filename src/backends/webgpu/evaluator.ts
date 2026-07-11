/**
 * WebGPU BatchEvaluator (BRIEF §12, §22-A7/A14).
 *
 * Exactness regimes:
 * - binary/FI targets: cover sizes and positives are u32 popcounts —
 *   INTEGER-EXACT; batches carry no screening metadata and downstream
 *   decisions are identical to CPU ones by construction.
 * - numeric targets (sum-family plans only — needStd/needMedian/needOrder/
 *   needTail plans stay on CPU, docs/design.md): f32 sums are SCREENING
 *   values. Each batch carries conservative per-candidate error bounds
 *   derived from the kernel's accumulation shape:
 *
 *     u = 2^-24 (f32 unit roundoff); T_i = min(⌈wpr/256⌉·32, size_i) bounds
 *     the terms any single thread accumulates sequentially; +8 for the
 *     256-lane reduction tree; +1 per-value rounding; +1 slack →
 *       sumEps_i    = S·u·(T_i + 10)·Σ|x|_i
 *       excessEps_i = S·u·((T_i + 10)·(Σ|x|_i + size_i·|c0|)
 *                     + size_i·(max|x| + |c0|))            (S = safety 4)
 *
 *   The second excess term bounds boundary misclassification: a row's f32
 *   excess dir·(x−c0) can differ from the f64 excess by at most
 *   ≈ u·(|x|+|c0|) ≤ u·(max|x|+|c0|), flipping rows within that margin of
 *   the centroid in or out of the tail. The browser gate validates both
 *   bounds empirically against f64 statistics on every fixture candidate
 *   (test/browser/backends.spec.ts) and §6.2 proves end-to-end exactness.
 *
 * Atlas residency: for all-categorical-equality spaces the atlas is built
 * ON the GPU from dictionary codes (codes mode — wgsl.ts atlasBuildKernel);
 * the CPU-side atlas is never constructed (PreparedTask.atlas is lazy) and
 * nothing is uploaded beyond the (n × columns) u8 code matrix. Other spaces
 * upload the CPU-built atlas. Either way the atlas binds as ≤
 * maxStorageBuffersPerShaderStage chunks of whole selector rows (A14).
 *
 * Resource discipline (A14): dispatches are capped by a word budget and the
 * 65535 workgroups/dimension limit, submitted sequentially with mapAsync
 * pacing; buffers are destroyed on dispose; device.lost surfaces as a typed
 * BackendError.
 */

import { maskTail, wordsFor } from "../../bitset/bitset.js";
import { BackendError } from "../../errors.js";
import type { PreparedTask } from "../../search/task.js";
import type { NumericStatsPlan } from "../../targets/stats.js";
import type { PreparedTarget } from "../../targets/types.js";
import { allocBatch } from "../cpu/evaluator.js";
import type { BatchEvaluator, StatsBatch } from "../types.js";
import {
  atlasBuildKernel,
  countsKernel,
  countsPairsKernel,
  numericKernel,
  PAIRS_TILE,
  PARAMS_WORDS,
} from "./wgsl.js";

const F32_U = 2 ** -24;
const EPS_SAFETY = 4;

export interface WebGpuEvaluatorOptions {
  /** Cap on candidates × words × arity per dispatch (A14 pacing). */
  maxWordsPerDispatch?: number;
  /** Test hook: force small atlas chunks to exercise the multi-binding path. */
  forceChunkBytes?: number;
  /** Test hook: disable the codes-mode GPU atlas build (upload instead). */
  disableCodesMode?: boolean;
}

/** Is this (target, plan) combination on the GPU fast path? (design.md) */
export function gpuApplicable(prepared: PreparedTarget, plan: NumericStatsPlan | null): boolean {
  if (prepared.kind === "binary" || prepared.kind === "fi") return true;
  if (prepared.kind === "emm") return false;
  return plan !== null && !plan.needStd && !plan.needMedian && !plan.needOrder && !plan.needTail;
}

interface CodesPlan {
  /** u8 codes packed into u32 words, column-major with padded stride. */
  codes: Uint32Array;
  colStrideWords: number;
  /** Per selector: colSlot << 16 | code (0xff = the NA sentinel, unused). */
  selMeta: Uint32Array;
}

/**
 * Codes mode applies when every selector is an equality over a categorical
 * column with ≤ 254 categories: byte 255 encodes NA (satisfies no selector,
 * spec §1.2) and `categories.length` encodes a value absent from the column
 * (empty cover) — both below the sentinel.
 */
function planCodesMode(task: PreparedTask): CodesPlan | null {
  const table = task.table;
  const nRows = table.nRows;
  const colStrideWords = wordsFor(nRows) * 8;
  const slotByAttr = new Map<string, number>();
  const slotCodes: Int32Array[] = [];
  const selMeta = new Uint32Array(task.selectors.length);
  for (let i = 0; i < task.selectors.length; i++) {
    const sel = task.selectors[i]!;
    if (sel.kind !== "equality") return null;
    const col = table.column(sel.attribute);
    if (col.kind !== "categorical" || col.categories.length > 254) return null;
    let slot = slotByAttr.get(sel.attribute);
    if (slot === undefined) {
      slot = slotCodes.length;
      slotByAttr.set(sel.attribute, slot);
      slotCodes.push(col.codes);
    }
    let code = -1;
    for (let c = 0; c < col.categories.length; c++) {
      if (col.categories[c] === sel.value) {
        code = c;
        break;
      }
    }
    // Absent value → a code no row carries (empty cover, still < 255).
    selMeta[i] = (slot << 16) | (code >= 0 ? code : col.categories.length);
  }
  const packed = new Uint32Array(slotCodes.length * colStrideWords);
  const bytes = new Uint8Array(packed.buffer);
  for (let s = 0; s < slotCodes.length; s++) {
    const codes = slotCodes[s]!;
    const wordBase = s * colStrideWords;
    // Branchless: code & 0xff maps −1 → 255, the NA sentinel (codes are
    // ≤ 254 by the cardinality guard above). Pack 4 rows per u32 write.
    const quads = nRows >> 2;
    for (let q = 0; q < quads; q++) {
      const r = q << 2;
      packed[wordBase + q] =
        (codes[r]! & 0xff) |
        ((codes[r + 1]! & 0xff) << 8) |
        ((codes[r + 2]! & 0xff) << 16) |
        ((codes[r + 3]! & 0xff) << 24);
    }
    for (let r = quads << 2; r < nRows; r++) {
      bytes[wordBase * 4 + r] = codes[r]! & 0xff;
    }
  }
  return { codes: packed, colStrideWords, selMeta };
}

export class WebGpuEvaluator implements BatchEvaluator {
  readonly name: string;
  readonly screening: boolean;
  private readonly device: GPUDevice;
  private readonly task: PreparedTask;
  private readonly prepared: PreparedTarget;
  private readonly plan: NumericStatsPlan | null;
  private readonly nRows: number;
  private readonly wordsPerRow: number;
  private readonly nSel: number;
  private readonly pipeline: GPUComputePipeline;
  private readonly usesAux: boolean;
  private readonly stride: number;
  private readonly rowsPerChunk: number;
  private readonly maxWordsPerDispatch: number;
  private readonly buffers: GPUBuffer[] = [];
  private readonly atlasChunks: GPUBuffer[];
  private readonly auxBuffer: GPUBuffer | null;
  private readonly parentBuffer: GPUBuffer;
  private readonly paramsBuffer: GPUBuffer;
  private candBuffer: GPUBuffer;
  private candCapacity: number;
  private outBuffer: GPUBuffer;
  private stagingBuffer: GPUBuffer;
  private outCapacity: number;
  private bindGroup: GPUBindGroup;
  /** Grouped arity-2 counts pipeline (lazily built; counts targets only). */
  private pairsPipeline: GPUComputePipeline | null = null;
  private pairsBindGroup: GPUBindGroup | null = null;
  private runsBuffer: GPUBuffer | null = null;
  private runsCapacity = 0;
  private readonly chunks: number;
  private lostError: BackendError | null = null;
  private disposed = false;
  /** Numeric error-bound constants (design.md §GPU exactness band). */
  private readonly c0Abs: number = 0;
  private readonly maxAbs: number = 0;
  private readonly perThreadTerms: number;

  private constructor(
    device: GPUDevice,
    task: PreparedTask,
    codesPlan: CodesPlan | null,
    options: WebGpuEvaluatorOptions,
  ) {
    this.device = device;
    this.task = task;
    this.prepared = task.prepared;
    this.plan = task.qf.kind === "numeric" ? task.qf.plan : null;
    this.nRows = task.table.nRows;
    this.wordsPerRow = wordsFor(this.nRows);
    this.nSel = task.selectors.length;
    this.screening = this.prepared.kind === "numeric";
    this.stride = this.screening ? 4 : 2;
    this.maxWordsPerDispatch = options.maxWordsPerDispatch ?? 1 << 30;
    this.perThreadTerms = Math.ceil(this.wordsPerRow / 256) * 32;

    const limits = device.limits;
    const rowBytes = this.wordsPerRow * 4;
    const chunkBytesLimit = Math.min(
      limits.maxStorageBufferBindingSize,
      options.forceChunkBytes ?? Number.POSITIVE_INFINITY,
    );
    const rowsPerChunk = Math.max(1, Math.floor(chunkBytesLimit / rowBytes));
    if (rowBytes > chunkBytesLimit) {
      throw new BackendError(
        `webgpu: one selector row (${rowBytes} B) exceeds maxStorageBufferBindingSize ` +
          `(${chunkBytesLimit} B) — table too tall for this adapter`,
      );
    }
    const chunks = Math.max(1, Math.ceil(this.nSel / rowsPerChunk));
    // Non-atlas storage bindings: cand, parent, out (+ aux/values).
    const budget = limits.maxStorageBuffersPerShaderStage - 4;
    if (chunks > budget) {
      throw new BackendError(
        `webgpu: atlas needs ${chunks} chunk bindings but only ${budget} are available ` +
          `(maxStorageBuffersPerShaderStage=${limits.maxStorageBuffersPerShaderStage}) — ` +
          `request a device with higher limits (registerWebGpu does) or reduce the space`,
      );
    }
    this.rowsPerChunk = rowsPerChunk;
    this.chunks = chunks;

    device.lost.then(
      (info) => {
        this.lostError = new BackendError(
          `WebGPU device lost (${info.reason}): ${info.message} — falling back requires a new run`,
        );
      },
      () => {
        // device destroyed with the evaluator — not an error path
      },
    );

    // --- shaders + pipeline
    const withPositives = this.prepared.kind === "binary";
    this.usesAux = withPositives || this.screening;
    const code = this.screening ? numericKernel(chunks) : countsKernel(chunks, withPositives);
    const module = device.createShaderModule({ code, label: "subgroup-web-kernel" });
    this.pipeline = device.createComputePipeline({
      label: "subgroup-web-pipeline",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });

    // --- static buffers
    const track = (b: GPUBuffer): GPUBuffer => {
      this.buffers.push(b);
      return b;
    };
    this.atlasChunks = [];
    for (let cIdx = 0; cIdx < chunks; cIdx++) {
      const firstRow = cIdx * rowsPerChunk;
      const rows = Math.min(rowsPerChunk, this.nSel - firstRow);
      this.atlasChunks.push(
        track(
          device.createBuffer({
            label: `atlas-chunk-${cIdx}`,
            size: rows * rowBytes,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
          }),
        ),
      );
    }
    if (codesPlan !== null) {
      this.buildAtlasOnGpu(codesPlan);
    } else {
      // Upload the CPU-built atlas (lazy getter materializes it here).
      const bits = this.task.atlas.bits;
      for (let cIdx = 0; cIdx < chunks; cIdx++) {
        const firstRow = cIdx * rowsPerChunk;
        const rows = Math.min(rowsPerChunk, this.nSel - firstRow);
        const view = bits.subarray(
          firstRow * this.wordsPerRow,
          (firstRow + rows) * this.wordsPerRow,
        );
        device.queue.writeBuffer(
          this.atlasChunks[cIdx]!,
          0,
          view.buffer,
          view.byteOffset,
          view.byteLength,
        );
      }
    }

    if (this.prepared.kind === "binary") {
      const pb = this.prepared.positivesBits;
      const buf = track(
        device.createBuffer({
          label: "positives-bits",
          size: pb.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(buf, 0, pb.buffer, pb.byteOffset, pb.byteLength);
      this.auxBuffer = buf;
    } else if (this.prepared.kind === "numeric") {
      const f32 = new Float32Array(this.prepared.values);
      const buf = track(
        device.createBuffer({
          label: "target-values-f32",
          size: f32.byteLength,
          usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
        }),
      );
      device.queue.writeBuffer(buf, 0, f32.buffer, 0, f32.byteLength);
      this.auxBuffer = buf;
      const c0 =
        (this.plan?.centroid ?? "mean") === "mean" ? this.prepared.mean : this.prepared.median;
      this.c0Abs = Math.abs(Math.fround(c0));
      this.maxAbs = Math.max(Math.abs(this.prepared.min), Math.abs(this.prepared.max));
    } else {
      this.auxBuffer = null;
    }

    this.parentBuffer = track(
      device.createBuffer({
        label: "parent-cover",
        size: Math.max(4, this.wordsPerRow * 4),
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
    this.paramsBuffer = track(
      device.createBuffer({
        label: "params",
        size: PARAMS_WORDS * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
      }),
    );

    this.candCapacity = 4096;
    this.candBuffer = track(
      device.createBuffer({
        label: "candidates",
        size: this.candCapacity * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      }),
    );
    this.outCapacity = 4096;
    this.outBuffer = track(
      device.createBuffer({
        label: "stats-out",
        size: this.outCapacity * this.stride * 4,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
      }),
    );
    this.stagingBuffer = track(
      device.createBuffer({
        label: "stats-staging",
        size: this.outCapacity * this.stride * 4,
        usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
      }),
    );
    this.bindGroup = this.makeBindGroup();
    const mode = codesPlan !== null ? "codes" : "upload";
    this.name = this.screening
      ? `webgpu(numeric-screen,${mode},chunks=${chunks})`
      : `webgpu(counts,${mode},chunks=${chunks})`;
  }

  static async create(
    device: GPUDevice,
    task: PreparedTask,
    options: WebGpuEvaluatorOptions = {},
  ): Promise<WebGpuEvaluator> {
    const plan = task.qf.kind === "numeric" ? task.qf.plan : null;
    if (!gpuApplicable(task.prepared, plan)) {
      throw new BackendError(
        "webgpu: task outside GPU applicability (emm targets and needStd/needMedian/" +
          "needOrder/needTail numeric plans are CPU-only — docs/design.md)",
      );
    }
    const codesPlan = options.disableCodesMode === true ? null : planCodesMode(task);
    return new WebGpuEvaluator(device, task, codesPlan, options);
  }

  /** Build all atlas chunks on-device from the packed code matrix. */
  private buildAtlasOnGpu(plan: CodesPlan): void {
    const device = this.device;
    const module = device.createShaderModule({
      code: atlasBuildKernel(),
      label: "subgroup-web-atlas-build",
    });
    const pipeline = device.createComputePipeline({
      label: "subgroup-web-atlas-build",
      layout: "auto",
      compute: { module, entryPoint: "main" },
    });
    const codesBuf = device.createBuffer({
      label: "codes-u8",
      size: plan.codes.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(codesBuf, 0, plan.codes.buffer, 0, plan.codes.byteLength);
    const metaBuf = device.createBuffer({
      label: "sel-meta",
      size: Math.max(4, plan.selMeta.byteLength),
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(metaBuf, 0, plan.selMeta.buffer, 0, plan.selMeta.byteLength);
    const paramsBuf = device.createBuffer({
      label: "build-params",
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    for (let cIdx = 0; cIdx < this.atlasChunks.length; cIdx++) {
      const firstSel = cIdx * this.rowsPerChunk;
      const selCount = Math.min(this.rowsPerChunk, this.nSel - firstSel);
      const params = new Uint32Array([
        this.wordsPerRow,
        this.nRows,
        firstSel,
        selCount,
        plan.colStrideWords,
        0,
        0,
        0,
      ]);
      device.queue.writeBuffer(paramsBuf, 0, params.buffer, 0, params.byteLength);
      const bind = device.createBindGroup({
        layout: pipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramsBuf } },
          { binding: 1, resource: { buffer: metaBuf } },
          { binding: 2, resource: { buffer: codesBuf } },
          { binding: 3, resource: { buffer: this.atlasChunks[cIdx]! } },
        ],
      });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(pipeline);
      pass.setBindGroup(0, bind);
      pass.dispatchWorkgroups(Math.ceil(this.wordsPerRow / 256), selCount);
      pass.end();
      device.queue.submit([encoder.finish()]);
      // NOTE: params are consumed at submit; the next loop iteration may
      // rewrite them safely. Queue ordering makes the built atlas visible
      // to all later kernel submissions without explicit synchronization.
    }
    codesBuf.destroy();
    metaBuf.destroy();
    paramsBuf.destroy();
  }

  private makeBindGroup(): GPUBindGroup {
    const entries: GPUBindGroupEntry[] = [
      { binding: 0, resource: { buffer: this.paramsBuffer } },
      { binding: 1, resource: { buffer: this.candBuffer } },
      { binding: 2, resource: { buffer: this.parentBuffer } },
      { binding: 3, resource: { buffer: this.outBuffer } },
    ];
    if (this.usesAux && this.auxBuffer !== null) {
      entries.push({ binding: 4, resource: { buffer: this.auxBuffer } });
    }
    this.atlasChunks.forEach((buf, i) => {
      entries.push({ binding: 5 + i, resource: { buffer: buf } });
    });
    return this.device.createBindGroup({
      label: "subgroup-web-bind",
      layout: this.pipeline.getBindGroupLayout(0),
      entries,
    });
  }

  private ensureCandCapacity(words: number): void {
    if (words <= this.candCapacity) return;
    this.candCapacity = 1 << Math.ceil(Math.log2(words));
    this.candBuffer.destroy();
    this.candBuffer = this.device.createBuffer({
      label: "candidates",
      size: this.candCapacity * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.buffers.push(this.candBuffer);
    this.bindGroup = this.makeBindGroup();
    this.pairsBindGroup = null;
  }

  private ensureOutCapacity(cands: number): void {
    if (cands <= this.outCapacity) return;
    this.outCapacity = 1 << Math.ceil(Math.log2(cands));
    this.outBuffer.destroy();
    this.stagingBuffer.destroy();
    this.outBuffer = this.device.createBuffer({
      label: "stats-out",
      size: this.outCapacity * this.stride * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST,
    });
    this.stagingBuffer = this.device.createBuffer({
      label: "stats-staging",
      size: this.outCapacity * this.stride * 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    });
    this.buffers.push(this.outBuffer, this.stagingBuffer);
    this.bindGroup = this.makeBindGroup();
    this.pairsBindGroup = null;
  }

  private ensureRunsCapacity(runs: number): void {
    if (this.runsBuffer !== null && runs <= this.runsCapacity) return;
    this.runsCapacity = Math.max(1024, 1 << Math.ceil(Math.log2(runs)));
    this.runsBuffer?.destroy();
    this.runsBuffer = this.device.createBuffer({
      label: "pair-runs",
      size: this.runsCapacity * 16,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    this.buffers.push(this.runsBuffer);
    this.pairsBindGroup = null;
  }

  private getPairsPipeline(): GPUComputePipeline {
    if (this.pairsPipeline === null) {
      const module = this.device.createShaderModule({
        code: countsPairsKernel(this.chunks, this.prepared.kind === "binary"),
        label: "subgroup-web-pairs",
      });
      this.pairsPipeline = this.device.createComputePipeline({
        label: "subgroup-web-pairs",
        layout: "auto",
        compute: { module, entryPoint: "main" },
      });
    }
    return this.pairsPipeline;
  }

  private getPairsBindGroup(): GPUBindGroup {
    if (this.pairsBindGroup === null) {
      const entries: GPUBindGroupEntry[] = [
        { binding: 0, resource: { buffer: this.paramsBuffer } },
        { binding: 1, resource: { buffer: this.candBuffer } },
        { binding: 2, resource: { buffer: this.runsBuffer! } },
        { binding: 3, resource: { buffer: this.outBuffer } },
      ];
      if (this.prepared.kind === "binary" && this.auxBuffer !== null) {
        entries.push({ binding: 4, resource: { buffer: this.auxBuffer } });
      }
      this.atlasChunks.forEach((buf, i) => {
        entries.push({ binding: 5 + i, resource: { buffer: buf } });
      });
      this.pairsBindGroup = this.device.createBindGroup({
        label: "subgroup-web-pairs-bind",
        layout: this.getPairsPipeline().getBindGroupLayout(0),
        entries,
      });
    }
    return this.pairsBindGroup;
  }

  /**
   * Grouped arity-2 tuple evaluation (counts targets): stages each shared
   * prefix row + the target bits in workgroup memory (wgsl.ts
   * countsPairsKernel) — ≈ 3× less global traffic than per-candidate
   * workgroups. Statistics are u32 atomic sums: integer-exact.
   */
  private async runPairs(ids: Uint32Array, count: number): Promise<StatsBatch> {
    this.checkAlive();
    const batch = allocBatch(count, this.prepared, this.plan);
    if (count === 0) return batch;
    // Contiguous runs of equal first selector (tuples are lex-sorted).
    const runs: number[] = [];
    let runStart = 0;
    for (let c = 1; c <= count; c++) {
      if (c === count || ids[c * 2]! !== ids[runStart * 2]!) {
        runs.push(ids[runStart * 2]!, runStart, c - runStart, 0);
        runStart = c;
      }
    }
    const runCount = runs.length / 4;
    this.ensureCandCapacity(ids.length);
    this.ensureRunsCapacity(runCount);
    const runsArr = Uint32Array.from(runs);
    this.device.queue.writeBuffer(this.candBuffer, 0, ids.buffer, ids.byteOffset, ids.byteLength);
    this.device.queue.writeBuffer(this.runsBuffer!, 0, runsArr.buffer, 0, runsArr.byteLength);
    this.ensureOutCapacity(count);
    this.writeParams(3, 2, count, 0);
    const tiles = Math.ceil(this.wordsPerRow / PAIRS_TILE);
    const encoder = this.device.createCommandEncoder();
    encoder.clearBuffer(this.outBuffer, 0, count * 2 * 4);
    const pass = encoder.beginComputePass();
    pass.setPipeline(this.getPairsPipeline());
    pass.setBindGroup(0, this.getPairsBindGroup());
    pass.dispatchWorkgroups(tiles, runCount);
    pass.end();
    encoder.copyBufferToBuffer(this.outBuffer, 0, this.stagingBuffer, 0, count * 2 * 4);
    this.device.queue.submit([encoder.finish()]);
    try {
      await this.stagingBuffer.mapAsync(GPUMapMode.READ, 0, count * 2 * 4);
    } catch (err) {
      this.checkAlive();
      throw new BackendError(
        `webgpu readback failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const mapped = new Uint32Array(this.stagingBuffer.getMappedRange(0, count * 2 * 4));
    this.readInto(batch, mapped, 0, count);
    this.stagingBuffer.unmap();
    this.checkAlive();
    return batch;
  }

  private checkAlive(): void {
    if (this.lostError !== null) throw this.lostError;
    if (this.disposed) throw new BackendError("webgpu evaluator disposed");
  }

  private writeParams(mode: number, arity: number, count: number, candBase: number): void {
    const params = new Uint32Array(PARAMS_WORDS);
    const f = new Float32Array(params.buffer);
    params[0] = this.wordsPerRow;
    params[1] = arity;
    params[2] = count;
    params[3] = this.rowsPerChunk;
    params[4] = mode;
    params[5] = candBase;
    if (this.prepared.kind === "numeric") {
      const plan = this.plan;
      f[6] = plan?.direction ?? 1;
      f[7] = (plan?.centroid ?? "mean") === "mean" ? this.prepared.mean : this.prepared.median;
    }
    this.device.queue.writeBuffer(this.paramsBuffer, 0, params.buffer, 0, params.byteLength);
  }

  /** Sequential paced dispatches over the candidate range (A14). */
  private async run(
    mode: number,
    arity: number,
    ids: Uint32Array,
    count: number,
  ): Promise<StatsBatch> {
    this.checkAlive();
    const batch = allocBatch(count, this.prepared, this.plan);
    if (this.screening) {
      batch.screening = {
        sumEps: new Float64Array(count),
        excessEps: new Float64Array(count),
      };
    }
    if (count === 0) return batch;
    this.ensureCandCapacity(ids.length);
    this.device.queue.writeBuffer(this.candBuffer, 0, ids.buffer, ids.byteOffset, ids.byteLength);

    const wordsPerCand = this.wordsPerRow * Math.max(1, arity);
    const groupCap = Math.min(
      65535,
      Math.max(1, Math.floor(this.maxWordsPerDispatch / wordsPerCand)),
    );
    for (let start = 0; start < count; start += groupCap) {
      const dCount = Math.min(groupCap, count - start);
      this.ensureOutCapacity(dCount);
      this.writeParams(mode, arity, dCount, start);
      const encoder = this.device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.dispatchWorkgroups(dCount);
      pass.end();
      encoder.copyBufferToBuffer(
        this.outBuffer,
        0,
        this.stagingBuffer,
        0,
        dCount * this.stride * 4,
      );
      this.device.queue.submit([encoder.finish()]);
      try {
        await this.stagingBuffer.mapAsync(GPUMapMode.READ, 0, dCount * this.stride * 4);
      } catch (err) {
        this.checkAlive();
        throw new BackendError(
          `webgpu readback failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      const mapped = new Uint32Array(
        this.stagingBuffer.getMappedRange(0, dCount * this.stride * 4),
      );
      this.readInto(batch, mapped, start, dCount);
      this.stagingBuffer.unmap();
      this.checkAlive();
    }
    return batch;
  }

  private readInto(batch: StatsBatch, mapped: Uint32Array, start: number, dCount: number): void {
    if (!this.screening) {
      for (let i = 0; i < dCount; i++) {
        batch.size[start + i] = mapped[i * 2]!;
        if (batch.positives !== null) batch.positives[start + i] = mapped[i * 2 + 1]!;
      }
      return;
    }
    const f32 = new Float32Array(mapped.buffer, mapped.byteOffset, mapped.length);
    const scr = batch.screening!;
    for (let i = 0; i < dCount; i++) {
      const o = i * 4;
      const size = mapped[o]!;
      const sum = f32[o + 1]!;
      const absSum = f32[o + 2]!;
      const excess = f32[o + 3]!;
      const gi = start + i;
      batch.size[gi] = size;
      batch.sum![gi] = sum;
      if (batch.excessSum !== null) batch.excessSum[gi] = excess;
      const T = Math.min(this.perThreadTerms, size) + 10;
      scr.sumEps[gi] = EPS_SAFETY * F32_U * T * absSum;
      scr.excessEps[gi] =
        EPS_SAFETY * F32_U * (T * (absSum + size * this.c0Abs) + size * (this.maxAbs + this.c0Abs));
    }
  }

  async evaluateTuples(tuples: Uint16Array, arity: number, count: number): Promise<StatsBatch> {
    const ids = new Uint32Array(count * arity);
    for (let i = 0; i < ids.length; i++) ids[i] = tuples[i]!;
    if (!this.screening && arity === 2 && count > 1) {
      return this.runPairs(ids, count);
    }
    return this.run(0, arity, ids, count);
  }

  async evaluateExtensions(
    parent: Uint32Array | null,
    extensions: ArrayLike<number>,
    op: "and" | "or" = "and",
  ): Promise<StatsBatch> {
    this.checkAlive();
    const w = this.wordsPerRow;
    // Materialize the null parent (full table for ∧, empty for ∨).
    let parentWords = parent;
    if (parentWords === null) {
      parentWords = new Uint32Array(w);
      if (op === "and") {
        parentWords.fill(0xffffffff);
        maskTail(parentWords, this.nRows);
      }
    }
    this.device.queue.writeBuffer(
      this.parentBuffer,
      0,
      parentWords.buffer,
      parentWords.byteOffset,
      parentWords.byteLength,
    );
    const ids = new Uint32Array(extensions.length);
    for (let i = 0; i < ids.length; i++) ids[i] = extensions[i] as number;
    return this.run(op === "and" ? 1 : 2, 0, ids, ids.length);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const b of this.buffers) {
      try {
        b.destroy();
      } catch {
        // already destroyed with a lost device
      }
    }
  }
}
