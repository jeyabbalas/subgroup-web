/**
 * Worker entry for the demo bundle: Vite bundles this file (and the library
 * worker it re-exports) into a self-contained module-worker chunk; main.ts
 * imports it with `?worker&url` and hands the URL to the worker pool.
 */
import "subgroup-web/worker";
