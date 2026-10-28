import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The root tsconfig for every file the tests import, site/src/prompts.ts
  // included: the site's own tsconfig extends astro's, which only the site's
  // npm ci installs.
  esbuild: { tsconfigRaw: readFileSync(new URL("./tsconfig.json", import.meta.url), "utf8") },
  test: {
    include: ["packages/*/test/**/*.test.ts"],
  },
});
