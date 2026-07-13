/**
 * Numeric utilities backing the statistics layer (spec §5, §6.10).
 *
 * - pairwise (tree) summation mirroring numpy's `np.add.reduce` accuracy
 *   class, so f64 statistics agree with the reference to rel ≤ 1e-9;
 * - regularized incomplete gamma P/Q for the χ²(dof 1) tail probability
 *   (Abramowitz & Stegun 6.5; Numerical Recipes §6.2 regime split), the
 *   function scipy evaluates via Cephes `igamc`;
 * - the standard normal pdf used by emmLikelihood.
 */

/** Pairwise sum of values[lo, hi); blocks of 128 summed naively like numpy. */
function pairwiseSumRange(values: Float64Array, lo: number, hi: number): number {
  const n = hi - lo;
  if (n <= 128) {
    let s = 0;
    for (let i = lo; i < hi; i++) s += values[i]!;
    return s;
  }
  // Split at a multiple of 128 near the middle (mirrors numpy's blocking).
  const half = lo + (((n >>> 1) + 127) & ~127);
  return pairwiseSumRange(values, lo, half) + pairwiseSumRange(values, half, hi);
}

export function pairwiseSum(values: Float64Array): number {
  return pairwiseSumRange(values, 0, values.length);
}

/** Mean with pairwise summation; NaN on empty input. */
export function mean(values: Float64Array): number {
  if (values.length === 0) return Number.NaN;
  return pairwiseSum(values) / values.length;
}

/** Population standard deviation (ddof 0), two-pass like np.std. */
export function populationStd(values: Float64Array): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  const mu = pairwiseSum(values) / n;
  const dev = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const d = values[i]! - mu;
    dev[i] = d * d;
  }
  return Math.sqrt(pairwiseSum(dev) / n);
}

/**
 * Median matching np.median: ascending sort; odd → middle, even → mean of the
 * two middle elements. Caller passes a scratch array it owns (will be sorted
 * in place). NaN on empty.
 */
export function medianInPlace(values: Float64Array): number {
  const n = values.length;
  if (n === 0) return Number.NaN;
  values.sort();
  const half = n >>> 1;
  return n % 2 === 1 ? values[half]! : (values[half - 1]! + values[half]!) / 2;
}

const MACHEP = 1e-15;
const MAX_ITER = 400;

/** ln Γ(a) for a = 0.5 is the only value we need, but keep it general via Lanczos. */
const LANCZOS_G = 7;
const LANCZOS_C = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
  -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
  1.5056327351493116e-7,
];

export function logGamma(a: number): number {
  if (a < 0.5) {
    // Reflection: Γ(a)Γ(1−a) = π / sin(πa)
    return Math.log(Math.PI / Math.sin(Math.PI * a)) - logGamma(1 - a);
  }
  const x = a - 1;
  let s = LANCZOS_C[0]!;
  for (let i = 1; i < LANCZOS_G + 2; i++) s += LANCZOS_C[i]! / (x + i);
  const t = x + LANCZOS_G + 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(s);
}

/** Lower regularized incomplete gamma P(a, x) by power series (x < a + 1). */
function lowerGammaSeries(a: number, x: number): number {
  let ap = a;
  let sum = 1 / a;
  let del = sum;
  for (let i = 0; i < MAX_ITER; i++) {
    ap += 1;
    del *= x / ap;
    sum += del;
    if (Math.abs(del) < Math.abs(sum) * MACHEP) break;
  }
  return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Upper regularized incomplete gamma Q(a, x) by modified Lentz CF (x >= a + 1). */
function upperGammaCF(a: number, x: number): number {
  const FPMIN = 1e-300;
  let b = x + 1 - a;
  let c = 1 / FPMIN;
  let d = 1 / b;
  let h = d;
  for (let i = 1; i <= MAX_ITER; i++) {
    const an = -i * (i - a);
    b += 2;
    d = an * d + b;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = b + an / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < MACHEP) break;
  }
  return h * Math.exp(-x + a * Math.log(x) - logGamma(a));
}

/** Upper regularized incomplete gamma Q(a, x) = 1 − P(a, x). */
export function upperIncompleteGammaRegularized(a: number, x: number): number {
  if (Number.isNaN(a) || Number.isNaN(x)) return Number.NaN;
  if (x <= 0) return 1;
  if (x < a + 1) return 1 - lowerGammaSeries(a, x);
  return upperGammaCF(a, x);
}

/** χ² upper tail probability with dof degrees of freedom (scipy chi2.sf). */
export function chi2TailProbability(x: number, dof: number): number {
  if (x <= 0) return 1;
  return upperIncompleteGammaRegularized(dof / 2, x / 2);
}

const SQRT_2PI = 2.5066282746310002; // f64(√(2π)), the constant scipy's norm.pdf uses

/** Standard normal pdf φ(r) = e^{−r²/2} / √(2π). */
export function normPdf(r: number): number {
  return Math.exp(-0.5 * r * r) / SQRT_2PI;
}

// ---------------------------------------------------------------------------
// Portable transcendentals (cross-engine determinism)
//
// JS pins +, −, ×, ÷ and Math.sqrt to correctly-rounded IEEE-754 results,
// but Math.log / Math.cos are implementation-approximated — V8 versions
// (Node vs Chromium) disagree by an ulp on sparse inputs. Generators whose
// output must be BYTE-IDENTICAL across environments (the never-committed
// synth-2M datasets, hash-pinned in test/fixtures/synth2m-manifest.json)
// therefore use these pure-arithmetic implementations: deterministic
// everywhere, accurate to ~1 ulp (which is all determinism needs).

const LOG_VIEW = new DataView(new ArrayBuffer(8));

/** Deterministic ln(x) for x > 0 (exponent split + atanh series). */
export function portableLog(x: number): number {
  LOG_VIEW.setFloat64(0, x);
  const hi = LOG_VIEW.getUint32(0);
  let e = ((hi >>> 20) & 0x7ff) - 1023;
  LOG_VIEW.setUint32(0, (hi & 0x800fffff) | (1023 << 20));
  let m = LOG_VIEW.getFloat64(0);
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: ES pins Math.SQRT2 only "approximately"; this literal's exact bit pattern feeds the hash-pinned synth-2M fixtures — do not substitute.
  if (m > 1.4142135623730951) {
    m *= 0.5;
    e += 1;
  }
  const t = (m - 1) / (m + 1);
  const t2 = t * t;
  let s = 0;
  for (let k = 12; k >= 0; k--) s = s * t2 + 1 / (2 * k + 1);
  // biome-ignore lint/suspicious/noApproximativeNumericConstant: ES pins Math.LN2 only "approximately"; this literal's exact bit pattern feeds the hash-pinned synth-2M fixtures — do not substitute.
  return e * 0.6931471805599453 + 2 * t * s;
}

const COS_C = [
  1,
  -1 / 2,
  1 / 24,
  -1 / 720,
  1 / 40320,
  -1 / 3628800,
  1 / 479001600,
  -1 / 87178291200,
  1 / 20922789888000,
];
const SIN_C = [
  1,
  -1 / 6,
  1 / 120,
  -1 / 5040,
  1 / 362880,
  -1 / 39916800,
  1 / 6227020800,
  -1 / 1307674368000,
];

/** Deterministic cos(y) for y ∈ [0, 2π) (quadrant reduction + Taylor). */
export function portableCos(y: number): number {
  const halfPiHi = 1.5707963267948966;
  const halfPiLo = 6.123233995736766e-17;
  const k = Math.round(y / halfPiHi);
  const r = y - k * halfPiHi - k * halfPiLo;
  const r2 = r * r;
  let c = 0;
  for (let i = COS_C.length - 1; i >= 0; i--) c = c * r2 + COS_C[i]!;
  let s = 0;
  for (let i = SIN_C.length - 1; i >= 0; i--) s = s * r2 + SIN_C[i]!;
  s *= r;
  switch (((k % 4) + 4) % 4) {
    case 0:
      return c;
    case 1:
      return -s;
    case 2:
      return -c;
    default:
      return s;
  }
}
