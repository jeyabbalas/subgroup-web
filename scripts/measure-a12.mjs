#!/usr/bin/env node
/**
 * A12 measurement (BRIEF §22-A12, §9): apriori's next level needs the covers
 * of frequent (L−1)-candidates. Compare, on a real apriori-shaped workload
 * (parent-major sorted arity-3 tuples, exactly the order apriori emits):
 *
 *   A. naive recompute — every candidate re-derives its full AND-chain from
 *      the atlas: (L−2) materialized ANDs + 1 fused AND+popcount;
 *   B. consecutive-prefix reuse — what CpuEvaluator.evaluateTuples does:
 *      re-derive a prefix row only when it differs from the previous
 *      candidate's (one scratch row per depth, nothing retained);
 *   C. retained parent-cover cache — materialize every parent cover once,
 *      keep all of them, per candidate one fused AND+popcount against the
 *      cached row (the "cache under a byte budget" option, budget = ∞).
 *
 * Prints a markdown table (wall ms, median of 5; retained bytes) consumed by
 * docs/design.md §A12. Run: `pnpm build && node scripts/measure-a12.mjs`.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(REPO, "dist", "index.js");
if (!fs.existsSync(DIST)) {
  console.error("measure-a12: dist/index.js missing — run `pnpm build` first");
  process.exit(1);
}
const sw = await import(DIST);

function median(xs) {
  return xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
}

function timeIt(fn, runs = 5) {
  fn(); // warmup + correctness reference computed by caller from this call
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

/**
 * Build an apriori-level-3-shaped workload: parents are the frequent pairs
 * (i,j), i<j drawn from the first `parentSel` selectors; each parent extends
 * with every k>j from the full selector list — parent-major sorted, the
 * exact tuple order apriori's candidate generation produces.
 */
function buildWorkload(atlas, parentSel, maxCandidates) {
  const nSel = atlas.selectors.length;
  const tuples = [];
  let parents = 0;
  outer: for (let i = 0; i < parentSel; i++) {
    for (let j = i + 1; j < parentSel; j++) {
      let emitted = false;
      for (let k = j + 1; k < nSel; k++) {
        if (tuples.length / 3 >= maxCandidates) break outer;
        tuples.push(i, j, k);
        emitted = true;
      }
      if (emitted) parents++;
    }
  }
  return { tuples: Uint16Array.from(tuples), count: tuples.length / 3, parents };
}

function run(name, table, selectors, parentSel, maxCandidates) {
  const atlas = sw.buildAtlas(table, selectors);
  const w = atlas.wordsPerRow;
  const { tuples, count, parents } = buildWorkload(atlas, parentSel, maxCandidates);
  const sizes = new Uint32Array(count);

  // A. naive: full AND-chain per candidate.
  const tmp = new Uint32Array(w);
  const naive = () => {
    for (let c = 0; c < count; c++) {
      const i = tuples[c * 3];
      const j = tuples[c * 3 + 1];
      const k = tuples[c * 3 + 2];
      sw.andInto(tmp, 0, atlas.bits, atlas.offset(i), atlas.bits, atlas.offset(j), w);
      sizes[c] = sw.andCount(tmp, 0, atlas.bits, atlas.offset(k), w);
    }
  };
  const tA = timeIt(naive);
  const refSizes = sizes.slice();

  // B. consecutive-prefix reuse (the engine's strategy, isolated).
  const reuse = () => {
    let pi = -1;
    let pj = -1;
    for (let c = 0; c < count; c++) {
      const i = tuples[c * 3];
      const j = tuples[c * 3 + 1];
      const k = tuples[c * 3 + 2];
      if (i !== pi || j !== pj) {
        sw.andInto(tmp, 0, atlas.bits, atlas.offset(i), atlas.bits, atlas.offset(j), w);
        pi = i;
        pj = j;
      }
      sizes[c] = sw.andCount(tmp, 0, atlas.bits, atlas.offset(k), w);
    }
  };
  const tB = timeIt(reuse);
  const okB = sizes.every((v, idx) => v === refSizes[idx]);

  // C. retained parent-cover cache (byte budget = ∞): build + query.
  let cacheBytes = 0;
  const cache = new Map();
  const cached = () => {
    cache.clear();
    cacheBytes = 0;
    for (let c = 0; c < count; c++) {
      const i = tuples[c * 3];
      const j = tuples[c * 3 + 1];
      const k = tuples[c * 3 + 2];
      const key = i * 65536 + j;
      let cover = cache.get(key);
      if (cover === undefined) {
        cover = new Uint32Array(w);
        sw.andInto(cover, 0, atlas.bits, atlas.offset(i), atlas.bits, atlas.offset(j), w);
        cache.set(key, cover);
        cacheBytes += cover.byteLength;
      }
      sizes[c] = sw.andCount(cover, 0, atlas.bits, atlas.offset(k), w);
    }
  };
  const tC = timeIt(cached);
  const okC = sizes.every((v, idx) => v === refSizes[idx]);

  if (!okB || !okC) throw new Error(`${name}: variant disagreement (B=${okB} C=${okC})`);
  const atlasMB = (atlas.bits.byteLength / 1e6).toFixed(1);
  const scratchKB = ((2 * w * 4) / 1024).toFixed(0);
  const cacheMB = (cacheBytes / 1e6).toFixed(1);
  console.log(
    `| ${name} | ${table.nRows.toLocaleString("en-US")} | ${w} | ${parents} | ${count.toLocaleString("en-US")} | ${tA.toFixed(1)} | ${tB.toFixed(1)} | ${tC.toFixed(1)} | ${scratchKB} KB | ${cacheMB} MB |`,
  );
  return { name, tA, tB, tC, cacheBytes, atlasMB };
}

console.log(
  "| dataset | rows | words/row | parents | candidates | A naive (ms) | B reuse (ms) | C cache (ms) | B retained | C retained |",
);
console.log("|---|---|---|---|---|---|---|---|---|---|");

// adult: the P1 dataset (real categorical+interval selector mix).
const adultCsv = path.join(REPO, "reference", ".cache", "adult.csv");
if (fs.existsSync(adultCsv)) {
  const table = sw.fromCSV(fs.readFileSync(adultCsv, "utf8"));
  const space = sw.allSelectors(table, { ignore: ["income"], bins: 5 });
  run("adult d3 level", table, space, 24, 200_000);
} else {
  console.error("(adult.csv not cached — skipping the adult row)");
}

// synth-2M: the P2/P3 scale (w = 62,500 — covers are 250 KB each).
const ds = sw.synth2MBinary();
const space2m = sw.allSelectors(ds.table, { ignore: ["y"] });
run("synth-2M d3 level", ds.table, space2m, 12, 12_000);
