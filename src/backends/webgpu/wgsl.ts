/**
 * WGSL kernel generation (BRIEF §12). Two compute kernels, one workgroup per
 * candidate, 256 threads striding the bitset words of the candidate's cover:
 *
 * - counts kernel (binary/FI targets): word-wise AND/OR chain over atlas
 *   rows + `countOneBits` popcount of the cover and of cover ∧ target.
 *   Pure u32 arithmetic — INTEGER-EXACT, no error band.
 * - numeric kernel (sum-family plans): per set bit accumulate f32
 *   sum / Σ|x| / positive excess dir·(x − c0). f32 partials → SCREENING
 *   values; the CPU derives conservative error bounds from Σ|x| (see
 *   evaluator.ts / docs/design.md §GPU exactness band).
 *
 * The atlas is bound as `chunks` storage buffers of whole selector rows
 * (A14: large atlases exceed maxStorageBufferBindingSize); `atlasWord`
 * dispatches on a compile-time chunk switch. Candidate modes: 0 = tuple
 * batches (ascending selector-id tuples of `arity`), 1/2 = extension batches
 * (parent cover AND/OR one selector row).
 */

/** Uniform layout shared by both kernels (8 × u32). */
export const PARAMS_WORDS = 8;

/**
 * Codes-mode atlas construction (BRIEF §12 / §8 P2): build one atlas chunk
 * directly on the GPU from dictionary-encoded categorical codes (u8, NA =
 * 0xff — never equal to a selector code, which realizes the spec §1.2 NA
 * policy). One thread per (selector, word): tests 32 rows' bytes and packs
 * the bits. Eliminates the CPU-side atlas build AND the 64 MB upload for
 * all-categorical-equality spaces.
 */
export function atlasBuildKernel(): string {
  return `
struct BuildParams {
  wordsPerRow: u32,
  nRows: u32,
  firstSel: u32,
  selCount: u32,
  colStrideWords: u32, // padded column stride in u32 words of the codes buffer
  pad0: u32,
  pad1: u32,
  pad2: u32,
}
@group(0) @binding(0) var<uniform> B: BuildParams;
@group(0) @binding(1) var<storage, read> selMeta: array<u32>; // colSlot << 16 | code
@group(0) @binding(2) var<storage, read> codes: array<u32>;   // u8 packed, col-major
@group(0) @binding(3) var<storage, read_write> outChunk: array<u32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let w = gid.x;
  let s = gid.y;
  if (w >= B.wordsPerRow || s >= B.selCount) { return; }
  let selInfo = selMeta[B.firstSel + s];
  let colBase = (selInfo >> 16u) * B.colStrideWords; // word offset of the column
  let code = selInfo & 0xffu;
  var bits = 0u;
  let rowBase = w * 32u;
  // 32 rows = 8 u32 words of packed bytes.
  for (var q = 0u; q < 8u; q = q + 1u) {
    let word = codes[colBase + w * 8u + q];
    for (var byte = 0u; byte < 4u; byte = byte + 1u) {
      let row = rowBase + q * 4u + byte;
      if (row < B.nRows && ((word >> (byte * 8u)) & 0xffu) == code) {
        bits = bits | (1u << ((q * 4u + byte) & 31u));
      }
    }
  }
  outChunk[s * B.wordsPerRow + w] = bits;
}
`;
}

function commonHeader(chunks: number, valuesBinding: boolean): string {
  const atlasBindings = Array.from(
    { length: chunks },
    (_, i) => `@group(0) @binding(${5 + i}) var<storage, read> atlas${i}: array<u32>;`,
  ).join("\n");
  const chunkCases = Array.from(
    { length: chunks },
    (_, i) => `    case ${i}u: { return atlas${i}[local]; }`,
  ).join("\n");
  return `
struct Params {
  wordsPerRow: u32,
  arity: u32,
  count: u32,
  rowsPerChunk: u32,
  mode: u32,      // 0 = tuples(and), 1 = extensions(and), 2 = extensions(or)
  candBase: u32,  // first candidate of this dispatch
  dirBits: u32,   // numeric: f32 direction (+1/-1) as bits
  c0Bits: u32,    // numeric: f32 centroid as bits
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> cand: array<u32>;
@group(0) @binding(2) var<storage, read> parent: array<u32>;
@group(0) @binding(3) var<storage, read_write> out: array<u32>;
@group(0) @binding(4) var<storage, read> ${valuesBinding ? "values: array<f32>" : "aux: array<u32>"};
${atlasBindings}

fn atlasWord(sel: u32, w: u32) -> u32 {
  let chunk = sel / P.rowsPerChunk;
  let local = (sel % P.rowsPerChunk) * P.wordsPerRow + w;
  switch chunk {
${chunkCases}
    default: { return 0u; }
  }
}

fn coverWord(c: u32, w: u32) -> u32 {
  if (P.mode == 0u) {
    let base = c * P.arity;
    var m = atlasWord(cand[base], w);
    for (var d = 1u; d < P.arity; d = d + 1u) {
      m = m & atlasWord(cand[base + d], w);
    }
    return m;
  }
  let m = atlasWord(cand[c], w);
  if (P.mode == 1u) {
    return parent[w] & m;
  }
  return parent[w] | m;
}
`;
}

/** counts kernel: out[c*2] = |cover|, out[c*2+1] = |cover ∧ aux| (u32-exact). */
export function countsKernel(chunks: number, withPositives: boolean): string {
  return `${commonHeader(chunks, false)}
var<workgroup> wgSize: array<u32, 256>;
var<workgroup> wgPos: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let c = wg.x;
  var size = 0u;
  var pos = 0u;
  if (c < P.count) {
    for (var w = lid.x; w < P.wordsPerRow; w = w + 256u) {
      let m = coverWord(c + P.candBase, w);
      size = size + countOneBits(m);
      ${withPositives ? "pos = pos + countOneBits(m & aux[w]);" : ""}
    }
  }
  wgSize[lid.x] = size;
  wgPos[lid.x] = pos;
  workgroupBarrier();
  var s = 128u;
  loop {
    if (lid.x < s) {
      wgSize[lid.x] = wgSize[lid.x] + wgSize[lid.x + s];
      wgPos[lid.x] = wgPos[lid.x] + wgPos[lid.x + s];
    }
    workgroupBarrier();
    s = s >> 1u;
    if (s == 0u) { break; }
  }
  if (lid.x == 0u && c < P.count) {
    out[c * 2u] = wgSize[0];
    out[c * 2u + 1u] = wgPos[0];
  }
}
`;
}

/** Words per shared-memory tile of the pairs kernel (fits default limits). */
export const PAIRS_TILE = 1536;

/**
 * Grouped arity-2 counts kernel (the P2 hot path): tuple batches arrive
 * lex-sorted, so candidates sharing a first selector form contiguous runs.
 * One workgroup handles (run, word-tile): the prefix row and the target
 * bits are staged into workgroup memory ONCE and reused for every extension
 * in the run — cutting global traffic from 3 to ≈ 1 atlas-row read per
 * candidate. Per-(candidate, tile) partial counts land via u32 atomicAdd:
 * integer, order-free — bit-identical to any other summation order.
 */
export function countsPairsKernel(chunks: number, withPositives: boolean): string {
  const atlasBindings = Array.from(
    { length: chunks },
    (_, i) => `@group(0) @binding(${5 + i}) var<storage, read> atlas${i}: array<u32>;`,
  ).join("\n");
  const chunkCases = Array.from(
    { length: chunks },
    (_, i) => `    case ${i}u: { return atlas${i}[local]; }`,
  ).join("\n");
  return `
struct Params {
  wordsPerRow: u32,
  arity: u32,
  count: u32,
  rowsPerChunk: u32,
  mode: u32,
  candBase: u32,
  dirBits: u32,
  c0Bits: u32,
}
struct Run {
  prefixSel: u32,
  extStart: u32,
  extCount: u32,
  pad: u32,
}
@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> cand: array<u32>;
@group(0) @binding(2) var<storage, read> runs: array<Run>;
@group(0) @binding(3) var<storage, read_write> out: array<atomic<u32>>;
@group(0) @binding(4) var<storage, read> ${withPositives ? "aux: array<u32>" : "auxUnused: array<u32>"};
${atlasBindings}

fn atlasWord(sel: u32, w: u32) -> u32 {
  let chunk = sel / P.rowsPerChunk;
  let local = (sel % P.rowsPerChunk) * P.wordsPerRow + w;
  switch chunk {
${chunkCases}
    default: { return 0u; }
  }
}

const TILE = ${PAIRS_TILE}u;
var<workgroup> shPrefix: array<u32, ${PAIRS_TILE}>;
${withPositives ? `var<workgroup> shPos: array<u32, ${PAIRS_TILE}>;` : ""}
var<workgroup> redSize: array<u32, 256>;
var<workgroup> redPos: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let run = runs[wg.y];
  let base = wg.x * TILE;
  let tileLen = min(TILE, P.wordsPerRow - min(base, P.wordsPerRow));
  for (var w = lid.x; w < tileLen; w = w + 256u) {
    shPrefix[w] = atlasWord(run.prefixSel, base + w);
    ${withPositives ? "shPos[w] = aux[base + w];" : ""}
  }
  workgroupBarrier();
  for (var e = 0u; e < run.extCount; e = e + 1u) {
    let candIdx = run.extStart + e;
    let extSel = cand[candIdx * 2u + 1u];
    var size = 0u;
    var pos = 0u;
    for (var w = lid.x; w < tileLen; w = w + 256u) {
      let m = shPrefix[w] & atlasWord(extSel, base + w);
      size = size + countOneBits(m);
      ${withPositives ? "pos = pos + countOneBits(m & shPos[w]);" : ""}
    }
    redSize[lid.x] = size;
    redPos[lid.x] = pos;
    workgroupBarrier();
    var s = 128u;
    loop {
      if (lid.x < s) {
        redSize[lid.x] = redSize[lid.x] + redSize[lid.x + s];
        redPos[lid.x] = redPos[lid.x] + redPos[lid.x + s];
      }
      workgroupBarrier();
      s = s >> 1u;
      if (s == 0u) { break; }
    }
    if (lid.x == 0u) {
      atomicAdd(&out[candIdx * 2u], redSize[0]);
      ${withPositives ? "atomicAdd(&out[candIdx * 2u + 1u], redPos[0]);" : ""}
    }
    workgroupBarrier();
  }
}
`;
}

/**
 * numeric kernel: out stride 4 = [size, bits(sum), bits(Σ|x|), bits(excess)].
 * Plain sequential per-thread f32 accumulation + binary-tree workgroup
 * reduction — the error bound in evaluator.ts models EXACTLY this shape
 * (per-thread terms + tree depth); no compensation tricks the compiler
 * could legally reassociate away.
 */
export function numericKernel(chunks: number): string {
  return `${commonHeader(chunks, true)}
var<workgroup> wgSize: array<u32, 256>;
var<workgroup> wgSum: array<f32, 256>;
var<workgroup> wgAbs: array<f32, 256>;
var<workgroup> wgExcess: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wg: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>) {
  let c = wg.x;
  let dir = bitcast<f32>(P.dirBits);
  let c0 = bitcast<f32>(P.c0Bits);
  var size = 0u;
  var sum = 0.0f;
  var absSum = 0.0f;
  var excess = 0.0f;
  if (c < P.count) {
    for (var w = lid.x; w < P.wordsPerRow; w = w + 256u) {
      var m = coverWord(c + P.candBase, w);
      let base = w * 32u;
      loop {
        if (m == 0u) { break; }
        let t = firstTrailingBit(m);
        m = m & (m - 1u);
        let v = values[base + t];
        size = size + 1u;
        sum = sum + v;
        absSum = absSum + abs(v);
        let e = dir * (v - c0);
        if (e > 0.0f) { excess = excess + e; }
      }
    }
  }
  wgSize[lid.x] = size;
  wgSum[lid.x] = sum;
  wgAbs[lid.x] = absSum;
  wgExcess[lid.x] = excess;
  workgroupBarrier();
  var s = 128u;
  loop {
    if (lid.x < s) {
      wgSize[lid.x] = wgSize[lid.x] + wgSize[lid.x + s];
      wgSum[lid.x] = wgSum[lid.x] + wgSum[lid.x + s];
      wgAbs[lid.x] = wgAbs[lid.x] + wgAbs[lid.x + s];
      wgExcess[lid.x] = wgExcess[lid.x] + wgExcess[lid.x + s];
    }
    workgroupBarrier();
    s = s >> 1u;
    if (s == 0u) { break; }
  }
  if (lid.x == 0u && c < P.count) {
    let o = c * 4u;
    out[o] = wgSize[0];
    out[o + 1u] = bitcast<u32>(wgSum[0]);
    out[o + 2u] = bitcast<u32>(wgAbs[0]);
    out[o + 3u] = bitcast<u32>(wgExcess[0]);
  }
}
`;
}
