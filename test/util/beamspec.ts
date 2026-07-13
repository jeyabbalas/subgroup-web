/**
 * Independent executable mirror of the beamSearch spec (spec §7.8): plain
 * arrays + full re-sorts + row-scan covers, sharing ONLY the statistics
 * kernels with the engine (the dual-path philosophy: engine logic under
 * test, arithmetic shared so qualities are comparable bit-for-bit). Used by
 * the "beam matches its own spec at widths {1, 20}" M5 gate.
 */
import { wordsFor } from "../../src/bitset/bitset.js";
import {
  binaryStatsFromBits,
  Conjunction,
  conjunctionCover,
  emmStatsFromBits,
  numericStatsFromBits,
  type PreparedTask,
  prepareTask,
  type SubgroupTask,
  sizeFromBits,
} from "../../src/index.js";

interface MirrorEntry {
  tuple: number[];
  quality: number;
}

function maskToWords(mask: Uint8Array): Uint32Array {
  const words = new Uint32Array(wordsFor(mask.length));
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] === 1) words[i >>> 5]! |= 1 << (i & 31);
  }
  return words;
}

/** §3.2: quality desc → depth asc → tuple lex asc. */
function compareEntries(a: MirrorEntry, b: MirrorEntry): number {
  if (a.quality !== b.quality) return a.quality > b.quality ? -1 : 1;
  if (a.tuple.length !== b.tuple.length) return a.tuple.length - b.tuple.length;
  for (let i = 0; i < a.tuple.length; i++) {
    const d = a.tuple[i]! - b.tuple[i]!;
    if (d !== 0) return d;
  }
  return 0;
}

function evaluateTuple(task: PreparedTask, tuple: number[]): { quality: number; size: number } {
  const selectors = tuple.map((i) => task.selectors[i]!);
  const mask = conjunctionCover(task.table, selectors);
  const words = maskToWords(mask);
  const prep = task.prepared;
  const qf = task.qf;
  switch (qf.kind) {
    case "binary": {
      const s = binaryStatsFromBits(prep as never, words);
      return { quality: qf.evaluate(s.size, s.positives, prep as never), size: s.size };
    }
    case "numeric": {
      const s = numericStatsFromBits(prep as never, words, qf.plan);
      return { quality: qf.evaluate(s, prep as never), size: s.size };
    }
    case "fi": {
      const size = sizeFromBits(words);
      return { quality: qf.evaluate({ size, depth: tuple.length }, prep as never), size };
    }
    case "emm": {
      const s = emmStatsFromBits(prep as never, words);
      return { quality: qf.evaluate(s, prep as never), size: s.size };
    }
    case "description":
      throw new Error("beam spec mirror: description QFs not exercised");
  }
}

/** Run the beam spec naively; returns the result list fingerprints. */
export function beamSpecMirror(
  taskSpec: SubgroupTask,
  options: { width?: number; adaptive?: boolean },
): { key: string; quality: number }[] {
  const task = prepareTask(taskSpec);
  const width = options.adaptive ? task.k : (options.width ?? 20);
  if (width < task.k) throw new Error("mirror: width < k");
  const nSel = task.selectors.length;

  const membership = (size: number, quality: number): boolean => {
    if (!(quality > task.minQuality)) return false;
    if (task.minSupportRows > 0 && size < task.minSupportRows) return false;
    return task.constraints.every((c) => c.isSatisfied({ size }));
  };

  const beam: MirrorEntry[] = [];
  const offered = new Set<string>();
  const expanded = new Set<string>();

  const offer = (tuple: number[]): void => {
    const key = tuple.join(",");
    if (offered.has(key)) return;
    offered.add(key);
    const { quality, size } = evaluateTuple(task, tuple);
    if (!membership(size, quality)) return;
    beam.push({ tuple, quality });
    beam.sort(compareEntries);
    if (beam.length > width) beam.length = width;
  };

  // Iteration 1: root expansion.
  for (let s = 0; s < nSel; s++) offer([s]);
  // Iterations 2..depth.
  for (let iteration = 2; iteration <= task.depth; iteration++) {
    const snapshot = beam.slice();
    let expansions = 0;
    for (const member of snapshot) {
      if (member.tuple.length >= task.depth) continue;
      const key = member.tuple.join(",");
      if (expanded.has(key)) continue;
      expanded.add(key);
      expansions++;
      for (let s = 0; s < nSel; s++) {
        if (member.tuple.includes(s)) continue;
        const child = [...member.tuple, s].sort((x, y) => x - y);
        offer(child);
      }
    }
    if (expansions === 0) break;
  }

  return beam.slice(0, task.k).map((e) => ({
    key: new Conjunction(e.tuple.map((i) => task.selectors[i]!)).canonicalKey(),
    quality: e.quality,
  }));
}
