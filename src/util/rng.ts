/**
 * PCG32 — the single seeded PRNG used anywhere randomness is permitted
 * (synthetic-data generators, property-test seeding). Search algorithms
 * contain no randomness (determinism contract, BRIEF §7); `Math.random`
 * is banned in `src/` by lint rule.
 *
 * Reference: O'Neill, "PCG: A Family of Simple Fast Space-Efficient
 * Statistically Good Algorithms for Random Number Generation" (2014).
 * Variant: PCG-XSH-RR 64/32 (LCG multiplier 6364136223846793005).
 */
import { portableCos, portableLog } from "./math.js";

export class Pcg32 {
  private state: bigint;
  private readonly inc: bigint;

  constructor(seed: bigint | number, streamId: bigint | number = 54n) {
    const seed64 = BigInt(seed) & 0xffffffffffffffffn;
    const stream64 = BigInt(streamId) & 0xffffffffffffffffn;
    this.inc = ((stream64 << 1n) | 1n) & 0xffffffffffffffffn;
    this.state = 0n;
    this.nextUint32();
    this.state = (this.state + seed64) & 0xffffffffffffffffn;
    this.nextUint32();
  }

  /** Next uniform uint32. */
  nextUint32(): number {
    const old = this.state;
    this.state = (old * 6364136223846793005n + this.inc) & 0xffffffffffffffffn;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << ((-rot >>> 0) & 31))) >>> 0;
  }

  /** Uniform float in [0, 1) with 32 bits of entropy. */
  nextFloat(): number {
    return this.nextUint32() / 4294967296;
  }

  /** Uniform integer in [0, bound) without modulo bias. */
  nextBounded(bound: number): number {
    if (!Number.isInteger(bound) || bound <= 0 || bound > 0xffffffff) {
      throw new RangeError(`bound must be an integer in [1, 2^32): got ${bound}`);
    }
    const b = bound >>> 0;
    const threshold = (0x100000000 % b) >>> 0;
    for (;;) {
      const r = this.nextUint32();
      if (r >= threshold) return r % b;
    }
  }

  /** Standard normal via Box–Muller (deterministic, no cached spare). */
  nextGaussian(): number {
    let u1 = this.nextFloat();
    if (u1 === 0) u1 = 2.3283064365386963e-10; // 2^-32: avoid log(0)
    const u2 = this.nextFloat();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * Standard normal via Box–Muller over PORTABLE transcendentals
   * (util/math.ts): byte-identical output across JS engines. Used by
   * generators whose output is hash-pinned and regenerated per environment
   * (synth-2M, BRIEF §6.4/§21). `nextGaussian` keeps the native-Math form
   * because the small planted fixtures were frozen with it.
   */
  nextGaussianPortable(): number {
    let u1 = this.nextFloat();
    if (u1 === 0) u1 = 2.3283064365386963e-10;
    const u2 = this.nextFloat();
    return Math.sqrt(-2 * portableLog(u1)) * portableCos(2 * Math.PI * u2);
  }
}
