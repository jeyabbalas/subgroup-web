import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "test/spec/**/*.test.ts",
      "test/unit/**/*.test.ts",
      "test/property/**/*.test.ts",
      "test/exactness/**/*.test.ts",
      "test/differential/**/*.test.ts",
    ],
    allowOnly: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
    pool: "threads",
  },
});
