/**
 * Python-compatible float formatting.
 *
 * pysubgroup's description strings embed numbers formatted by CPython
 * (`str(float)` shortest-round-trip repr, and `"{0:.2f}".format` for the
 * 2-digit interval display dialect). Differential fixtures speak that dialect
 * (BRIEF §22-A16), so we reproduce it exactly here.
 *
 * CPython `repr(float)` rule: shortest digit string that round-trips, printed
 * in fixed notation when the decimal exponent e (of the leading digit)
 * satisfies -4 <= e < 16, else scientific with a sign and >= 2 exponent
 * digits. Integral floats get a trailing ".0" in fixed notation.
 */

/** Decompose a finite nonzero double into shortest digits and decimal exponent. */
function decomposeShortest(abs: number): { digits: string; e: number } {
  const s = String(abs); // JS also emits shortest-round-trip digits
  const eIdx = s.indexOf("e");
  if (eIdx >= 0) {
    const mant = s.slice(0, eIdx);
    const exp = Number.parseInt(s.slice(eIdx + 1), 10);
    const dot = mant.indexOf(".");
    const digits = (dot >= 0 ? mant.slice(0, dot) + mant.slice(dot + 1) : mant).replace(/0+$/, "");
    // JS scientific mantissa is d or d.ddd -> exponent of leading digit is exp
    return { digits: digits === "" ? "0" : digits, e: exp };
  }
  const dot = s.indexOf(".");
  const intPart = dot >= 0 ? s.slice(0, dot) : s;
  const fracPart = dot >= 0 ? s.slice(dot + 1) : "";
  if (intPart !== "0") {
    const digits = (intPart + fracPart).replace(/0+$/, "");
    return { digits: digits === "" ? "0" : digits, e: intPart.length - 1 };
  }
  // 0.000ddd
  let i = 0;
  while (i < fracPart.length && fracPart[i] === "0") i++;
  const digits = fracPart.slice(i).replace(/0+$/, "");
  return { digits, e: -(i + 1) };
}

/** CPython `repr(float)` / `str(float)`, e.g. 5 -> "5.0", 1e16 -> "1e+16", 1e-5 -> "1e-05". */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Number.POSITIVE_INFINITY) return "inf";
  if (x === Number.NEGATIVE_INFINITY) return "-inf";
  if (x === 0) return Object.is(x, -0) ? "-0.0" : "0.0";
  const neg = x < 0;
  const { digits, e } = decomposeShortest(Math.abs(x));
  let out: string;
  if (e >= -4 && e < 16) {
    if (e >= 0) {
      const intDigits = digits.length > e ? digits.slice(0, e + 1) : digits.padEnd(e + 1, "0");
      const frac = digits.length > e + 1 ? digits.slice(e + 1) : "";
      out = `${intDigits}.${frac === "" ? "0" : frac}`;
    } else {
      out = `0.${"0".repeat(-e - 1)}${digits}`;
    }
  } else {
    const mant = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    const absE = Math.abs(e);
    const expStr = absE < 10 ? `0${absE}` : String(absE);
    out = `${mant}e${e < 0 ? "-" : "+"}${expStr}`;
  }
  return neg ? `-${out}` : out;
}

/**
 * CPython `"{0:.<digits>f}".format(x)`: correctly-rounded fixed-point decimal
 * of the exact binary double, ties resolved to even (exact via BigInt).
 */
export function pyFormatFixed(x: number, fracDigits: number): string {
  if (Number.isNaN(x)) return "nan";
  if (x === Number.POSITIVE_INFINITY) return "inf";
  if (x === Number.NEGATIVE_INFINITY) return "-inf";
  const neg = x < 0 || Object.is(x, -0);
  const abs = Math.abs(x);
  // Extract exact mantissa/exponent: abs = m * 2^k with m, k integers.
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, abs);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const biasedExp = (hi >>> 20) & 0x7ff;
  const mantBits = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  let m: bigint;
  let k: number;
  if (biasedExp === 0) {
    m = mantBits;
    k = -1074;
  } else {
    m = mantBits | (1n << 52n);
    k = biasedExp - 1075;
  }
  const scale = 10n ** BigInt(fracDigits);
  let n: bigint;
  if (k >= 0) {
    n = m * (1n << BigInt(k)) * scale;
  } else {
    const num = m * scale;
    const den = 1n << BigInt(-k);
    const q = num / den;
    const r = num % den;
    const twice = r * 2n;
    if (twice > den) n = q + 1n;
    else if (twice < den) n = q;
    else n = q % 2n === 0n ? q : q + 1n; // half-to-even
  }
  const digits = n.toString().padStart(fracDigits + 1, "0");
  const intPart = digits.slice(0, digits.length - fracDigits);
  const frac = fracDigits > 0 ? `.${digits.slice(digits.length - fracDigits)}` : "";
  const out = `${intPart}${frac}`;
  // CPython keeps the sign even when the value rounds to zero: '%.2f' % -0.001 == '-0.00'
  return neg ? `-${out}` : out;
}
