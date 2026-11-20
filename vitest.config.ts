import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The root tsconfig for every file the tests import, site/src/prompts.ts
  // included: the site's own tsconfig extends astro's, which only the site's
  // npm ci installs.
  esbuild: { tsconfigRaw: readFileSync(new URL("./tsconfig.json", import.meta.url), "utf8") },
  test: {
    globalSetup: ["./scripts/clean-tree-guard.mjs"],
    // The in-process runs of plywood init resolve chant as bin.ts has them do.
    setupFiles: ["./packages/plywood/test/chant-resolve.setup.ts"],
    // The in-process runs of init take several seconds when the suite runs files in parallel.
    testTimeout: 30_000,
    include: ["packages/*/test/**/*.test.ts", "e2e/test/**/*.test.ts"],
  },
});
