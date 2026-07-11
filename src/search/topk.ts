/**
 * Canonical top-k structure (spec §3.2–§3.4).
 *
 * Realizes §3.3's define-by-sort semantics: the retained set is always the
 * first ≤ k eligible candidates under quality desc → depth asc → index-tuple
 * asc — independent of insertion order (proof: insertion with the full
 * comparator + worst-drop is order-invariant for a total order). Index tuples
 * compare lexicographically, which equals canonical-description order for
 * tuples over the task's §2.2-sorted selector list (spec §7.1).
 *
 * Membership requires quality > minQuality (strict; NaN fails naturally).
 * `pruneThreshold` implements §3.4: prune iff oe ≤ θ or (full and oe < θ_now)
 * — callers compare `oe <= pruneThresholdInclusive() ? prune` via the pair of
 * accessors below.
 */

export interface TopKItem {
  quality: number;
  /** Ascending selector indices over the task's canonical selector list. */
  tuple: Uint16Array;
  /**
   * Optional per-candidate statistics captured at admission (size, and
   * positives for binary targets). Lets buildResults emit statistic tables
   * without recomputing covers — decisive on the P2 GPU fast path where no
   * CPU cover ever exists (BRIEF §8/§12). Pure payload: never compared.
   */
  aux?: { size: number; positives?: number };
}

/** quality desc → depth asc → lex tuple asc; total order for distinct tuples. */
export function compareItems(
  qa: number,
  ta: ArrayLike<number>,
  qb: number,
  tb: ArrayLike<number>,
): number {
  if (qa !== qb) return qa > qb ? -1 : 1;
  if (ta.length !== tb.length) return ta.length - tb.length;
  for (let i = 0; i < ta.length; i++) {
    const d = (ta[i] as number) - (tb[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

export class TopK {
  readonly k: number;
  readonly minQuality: number;
  /** Sorted ascending by the canonical order (best first). */
  private readonly items: TopKItem[] = [];

  constructor(k: number, minQuality: number) {
    this.k = k;
    this.minQuality = minQuality;
  }

  get size(): number {
    return this.items.length;
  }

  get full(): boolean {
    return this.items.length >= this.k;
  }

  /** Quality of the current k-th (worst retained) item; NaN when not full. */
  kthQuality(): number {
    return this.full ? this.items[this.items.length - 1]!.quality : Number.NaN;
  }

  /**
   * §3.4 pruning decision for an optimistic estimate: refinements of a
   * candidate with estimate `oe` can be skipped iff this returns true.
   */
  shouldPrune(oe: number): boolean {
    if (oe <= this.minQuality) return true;
    return this.full && oe < this.kthQuality();
  }

  /**
   * Would `add(quality, tuple)` insert? Exactly add's rejection tests with
   * no mutation. Monotone in `quality` for a fixed tuple — the property the
   * §12 screening band relies on: if an UPPER bound on a candidate's quality
   * cannot admit, its exact quality cannot either (engine.ts admit).
   */
  couldAdmit(quality: number, tuple: ArrayLike<number>): boolean {
    if (!(quality > this.minQuality)) return false;
    if (!this.full) return true;
    const worst = this.items[this.items.length - 1]!;
    return compareItems(quality, tuple, worst.quality, worst.tuple) < 0;
  }

  /**
   * Offer a candidate. `tuple` may be a scratch buffer — it is copied only
   * when the candidate is retained. `aux` is retained verbatim (payload
   * only, never compared). Returns true iff retained.
   */
  add(quality: number, tuple: ArrayLike<number>, aux?: TopKItem["aux"]): boolean {
    if (!(quality > this.minQuality)) return false; // strict; drops NaN
    const items = this.items;
    if (this.full) {
      const worst = items[items.length - 1]!;
      if (compareItems(quality, tuple, worst.quality, worst.tuple) >= 0) return false;
    }
    // Binary search for insertion position under the canonical order.
    let lo = 0;
    let hi = items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const m = items[mid]!;
      if (compareItems(quality, tuple, m.quality, m.tuple) < 0) hi = mid;
      else lo = mid + 1;
    }
    items.splice(lo, 0, {
      quality,
      tuple: Uint16Array.from(tuple as ArrayLike<number>),
      ...(aux !== undefined ? { aux } : {}),
    });
    if (items.length > this.k) items.pop();
    return lo < this.k;
  }

  /** Best-first snapshot (already in §3.2 order). */
  toArray(): readonly TopKItem[] {
    return this.items;
  }

  bestQuality(): number {
    return this.items.length > 0 ? this.items[0]!.quality : Number.NaN;
  }
}
