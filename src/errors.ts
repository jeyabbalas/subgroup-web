/**
 * Typed error hierarchy (BRIEF §5.5). Every error message is actionable: it
 * names the offending input and, where possible, the fix.
 */

/** Base class for all subgroup-web errors. */
export class SubgroupWebError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** Invalid user input: unknown attributes, bad parameters, type mismatches. */
export class ValidationError extends SubgroupWebError {}

/** CSV syntax or type-inference failure (row/column context included). */
export class CsvError extends SubgroupWebError {}

/** Search-space problems: empty spaces, target leakage. */
export class SearchSpaceError extends SubgroupWebError {}

/** Backend failures (worker pool, WebGPU device loss, unsupported environment). */
export class BackendError extends SubgroupWebError {}

/** Operation aborted via AbortSignal. */
export class AbortedError extends SubgroupWebError {
  constructor(message = "operation aborted") {
    super(message);
  }
}
