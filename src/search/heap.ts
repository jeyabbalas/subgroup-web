/**
 * Minimal binary heap over a strict total-order comparator. With a TOTAL
 * order (all elements distinct under `compare`), the pop sequence is the
 * sorted order of the pushed multiset regardless of push interleaving —
 * the §7 determinism argument for best-first frontiers.
 */

export class BinaryHeap<T> {
  private readonly items: T[] = [];
  private readonly compare: (a: T, b: T) => number;

  /** `compare(a, b) < 0` ⇔ a pops before b. */
  constructor(compare: (a: T, b: T) => number) {
    this.compare = compare;
  }

  get size(): number {
    return this.items.length;
  }

  push(item: T): void {
    const items = this.items;
    items.push(item);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(items[i]!, items[parent]!) < 0) {
        const tmp = items[i]!;
        items[i] = items[parent]!;
        items[parent] = tmp;
        i = parent;
      } else break;
    }
  }

  pop(): T | undefined {
    const items = this.items;
    const n = items.length;
    if (n === 0) return undefined;
    const top = items[0]!;
    const last = items.pop()!;
    if (n > 1) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let best = i;
        if (l < items.length && this.compare(items[l]!, items[best]!) < 0) best = l;
        if (r < items.length && this.compare(items[r]!, items[best]!) < 0) best = r;
        if (best === i) break;
        const tmp = items[i]!;
        items[i] = items[best]!;
        items[best] = tmp;
        i = best;
      }
    }
    return top;
  }
}
