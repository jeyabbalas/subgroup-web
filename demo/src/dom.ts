/** Tiny DOM helpers for the demo (no framework — BRIEF §15). */

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | number> = {},
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (typeof v === "boolean") {
      if (v) node.setAttribute(k, "");
    } else node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c);
  }
  return node;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Compact number formatting for stats cells. */
export function fmt(v: number): string {
  if (Number.isNaN(v)) return "NaN";
  if (!Number.isFinite(v)) return v > 0 ? "∞" : "−∞";
  if (Number.isInteger(v) && Math.abs(v) < 1e15) return v.toLocaleString("en-US");
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-4 || a >= 1e7)) return v.toExponential(3);
  return v.toFixed(4).replace(/\.?0+$/, (m) => (m.startsWith(".") ? "" : m));
}

export function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms.toFixed(1)} ms`;
}

/** An inline horizontal bar with an optional reference marker (both 0..1). */
export function bar(
  fraction: number,
  marker?: number,
  kind: "size" | "share" = "size",
): HTMLElement {
  const f = Math.max(0, Math.min(1, fraction));
  const wrap = el("span", { class: `bar ${kind === "share" ? "share" : ""}` });
  const fill = el("i");
  fill.style.width = `${(f * 100).toFixed(1)}%`;
  wrap.append(fill);
  if (marker !== undefined && Number.isFinite(marker)) {
    const m = el("u");
    m.style.left = `${(Math.max(0, Math.min(1, marker)) * 100).toFixed(1)}%`;
    wrap.append(m);
  }
  return wrap;
}

export function download(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
