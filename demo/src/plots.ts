/**
 * Canvas views (BRIEF §15): ROC-space scatter and subgroup-bars, recreating
 * the reference's `plot_roc` / `plot_sgbars` matplotlib module, plus the
 * subgroup-detail comparison drawing (share bars / histograms).
 */

import type { SubgroupResults } from "subgroup-web";

const AXIS = "#8b98a9";
const GRID = "#2a3341";
const POINT = "#4da3ff";
const POINT_SEL = "#ffb454";
const POS = "#3f8f66";
const REST = "#39465a";
const COMPLEMENT = "#7a5ea8";

/** Prepare a canvas for crisp drawing at device pixel ratio; returns ctx + CSS size. */
function setup(canvas: HTMLCanvasElement, cssHeight: number) {
  const cssWidth = canvas.clientWidth || 420;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.height = `${cssHeight}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("2d canvas unavailable");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssWidth, cssHeight);
  ctx.font = "11px system-ui, sans-serif";
  return { ctx, w: cssWidth, h: cssHeight };
}

export interface RocPoint {
  fpr: number;
  tpr: number;
  label: string;
}

/**
 * ROC-space scatter (reference `plot_roc`): each subgroup at
 * (false-positive rate, true-positive rate); diagonal = chance.
 * Returns a hit-test function mapping a canvas click to a point index.
 */
export function drawRoc(
  canvas: HTMLCanvasElement,
  points: RocPoint[],
  selected: number,
): (x: number, y: number) => number {
  const { ctx, w, h } = setup(canvas, 300);
  const m = { l: 40, r: 12, t: 14, b: 30 };
  const px = (fpr: number) => m.l + fpr * (w - m.l - m.r);
  const py = (tpr: number) => h - m.b - tpr * (h - m.t - m.b);

  ctx.strokeStyle = GRID;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const f = i / 4;
    ctx.beginPath();
    ctx.moveTo(px(f), py(0));
    ctx.lineTo(px(f), py(1));
    ctx.moveTo(px(0), py(f));
    ctx.lineTo(px(1), py(f));
    ctx.stroke();
    ctx.fillStyle = AXIS;
    ctx.fillText(f.toFixed(2), px(f) - 10, h - m.b + 14);
    ctx.fillText(f.toFixed(2), 8, py(f) + 4);
  }
  ctx.fillStyle = AXIS;
  ctx.fillText("false positive rate", w / 2 - 40, h - 6);
  ctx.save();
  ctx.translate(10, h / 2 + 40);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText("true positive rate", 0, 0);
  ctx.restore();

  ctx.strokeStyle = AXIS;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(px(0), py(0));
  ctx.lineTo(px(1), py(1));
  ctx.stroke();
  ctx.setLineDash([]);

  points.forEach((p, i) => {
    ctx.beginPath();
    ctx.fillStyle = i === selected ? POINT_SEL : POINT;
    ctx.arc(px(p.fpr), py(p.tpr), i === selected ? 5.5 : 4, 0, Math.PI * 2);
    ctx.fill();
  });
  if (selected >= 0 && selected < points.length) {
    const p = points[selected]!;
    ctx.fillStyle = POINT_SEL;
    const label = p.label.length > 40 ? `${p.label.slice(0, 39)}…` : p.label;
    ctx.fillText(label, Math.min(px(p.fpr) + 8, w - 180), py(p.tpr) - 8);
  }

  return (x, y) => {
    let best = -1;
    let bestD = 12 * 12;
    points.forEach((p, i) => {
      const d = (px(p.fpr) - x) ** 2 + (py(p.tpr) - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  };
}

export interface SgBar {
  label: string;
  /** Bar length as a fraction of the dataset (relative size). */
  relSize: number;
  /** Colored split point 0..1 within the bar (target share); NaN → solid. */
  share: number;
}

/**
 * Subgroup-bars view (reference `plot_sgbars`): one horizontal bar per
 * subgroup, length = relative size, split into target-positive (green) and
 * rest; the dataset row on top is the baseline. Returns a row hit-test.
 */
export function drawSgBars(
  canvas: HTMLCanvasElement,
  bars: SgBar[],
  selected: number,
): (x: number, y: number) => number {
  const rowH = 22;
  const h = Math.max(80, bars.length * rowH + 34);
  const { ctx, w } = setup(canvas, h);
  const labelW = Math.min(240, w * 0.45);
  const m = { l: labelW + 8, r: 12, t: 8 };
  const bw = w - m.l - m.r;

  bars.forEach((b, i) => {
    const y = m.t + i * rowH;
    ctx.fillStyle = i === selected ? POINT_SEL : AXIS;
    const label = b.label.length > 36 ? `${b.label.slice(0, 35)}…` : b.label;
    ctx.fillText(label, 8, y + 14);
    const len = Math.max(2, b.relSize * bw);
    if (Number.isFinite(b.share)) {
      const split = Math.max(0, Math.min(1, b.share)) * len;
      ctx.fillStyle = POS;
      ctx.fillRect(m.l, y + 4, split, rowH - 9);
      ctx.fillStyle = REST;
      ctx.fillRect(m.l + split, y + 4, len - split, rowH - 9);
    } else {
      ctx.fillStyle = REST;
      ctx.fillRect(m.l, y + 4, len, rowH - 9);
    }
    if (i === selected) {
      ctx.strokeStyle = POINT_SEL;
      ctx.strokeRect(m.l - 1, y + 3, len + 2, rowH - 7);
    }
  });
  ctx.fillStyle = AXIS;
  ctx.fillText("bar length = relative size · green = target share", m.l, h - 8);

  return (_x, y) => {
    const i = Math.floor((y - m.t) / rowH);
    return i >= 0 && i < bars.length ? i : -1;
  };
}

/** Detail view, binary target: subgroup vs complement vs dataset share bars. */
export function drawShareComparison(
  canvas: HTMLCanvasElement,
  groups: { label: string; share: number; size: number }[],
): void {
  const { ctx, w, h } = setup(canvas, 200);
  const m = { l: 110, r: 60, t: 12, b: 24 };
  const bw = w - m.l - m.r;
  const rowH = (h - m.t - m.b) / groups.length;
  groups.forEach((g, i) => {
    const y = m.t + i * rowH;
    ctx.fillStyle = AXIS;
    ctx.fillText(g.label, 8, y + rowH / 2 + 4);
    const share = Number.isFinite(g.share) ? Math.max(0, Math.min(1, g.share)) : 0;
    ctx.fillStyle = REST;
    ctx.fillRect(m.l, y + 6, bw, rowH - 12);
    ctx.fillStyle = i === 0 ? POS : i === 1 ? COMPLEMENT : POINT;
    ctx.fillRect(m.l, y + 6, share * bw, rowH - 12);
    ctx.fillStyle = "#dbe2ec";
    ctx.fillText(
      `${(share * 100).toFixed(1)}%  (n=${g.size.toLocaleString("en-US")})`,
      m.l + share * bw + 6,
      y + rowH / 2 + 4,
    );
  });
  ctx.fillStyle = AXIS;
  ctx.fillText("target share", w / 2 - 30, h - 6);
}

/** Detail view, numeric target: subgroup vs complement histogram (density). */
export function drawHistogram(
  canvas: HTMLCanvasElement,
  sg: number[],
  complement: number[],
  bins = 24,
): void {
  const { ctx, w, h } = setup(canvas, 200);
  const all = sg.concat(complement);
  if (all.length === 0) return;
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const v of all) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!(hi > lo)) {
    lo -= 1;
    hi += 1;
  }
  const m = { l: 34, r: 10, t: 16, b: 22 };
  const bw = (w - m.l - m.r) / bins;
  const count = (vals: number[]) => {
    const c = new Array(bins).fill(0) as number[];
    for (const v of vals) {
      const b = Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins));
      c[b] = (c[b] ?? 0) + 1 / Math.max(1, vals.length);
    }
    return c;
  };
  const hs = count(sg);
  const hc = count(complement);
  const peak = Math.max(...hs, ...hc, 1e-9);
  const py = (d: number) => h - m.b - (d / peak) * (h - m.t - m.b);

  for (const [hist, color] of [
    [hc, COMPLEMENT],
    [hs, POS],
  ] as const) {
    ctx.fillStyle = `${color}99`;
    ctx.strokeStyle = color;
    for (let b = 0; b < bins; b++) {
      const x = m.l + b * bw;
      const y = py(hist[b]!);
      ctx.fillRect(x, y, bw - 1, h - m.b - y);
    }
  }
  ctx.fillStyle = AXIS;
  ctx.fillText(String(fmtTick(lo)), m.l, h - 8);
  ctx.fillText(String(fmtTick(hi)), w - m.r - 40, h - 8);
  ctx.fillStyle = POS;
  ctx.fillText("■ subgroup", m.l, 12);
  ctx.fillStyle = COMPLEMENT;
  ctx.fillText("■ complement", m.l + 80, 12);
}

function fmtTick(v: number): string {
  const a = Math.abs(v);
  if (a !== 0 && (a < 1e-3 || a >= 1e6)) return v.toExponential(1);
  return String(Math.round(v * 100) / 100);
}

/** Build ROC points from binary-target results (needs the §5.1 stats table). */
export function rocPoints(results: SubgroupResults): RocPoint[] {
  return results.entries.map((e) => {
    const s = e.stats;
    const P = s.positives_dataset!;
    const N = s.size_dataset!;
    const p = s.positives_sg!;
    const n = s.size_sg!;
    return {
      tpr: P > 0 ? p / P : 0,
      fpr: N - P > 0 ? (n - p) / (N - P) : 0,
      label: e.description.toString(),
    };
  });
}
