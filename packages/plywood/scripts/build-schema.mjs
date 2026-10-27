// Writes plywood.schema.json from the config groups in src/config: each group
// holds the schema of its own keys, and src/config/index.ts composes them.
//   node scripts/build-schema.mjs           (npm run schema) writes the file
//   node scripts/build-schema.mjs --check   fails when the committed file differs
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chantPlugin } from "./chant-exports.mjs";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "../..");
const out = join(pkgDir, "plywood.schema.json");
const cacheDir = join(root, "node_modules/.cache/plywood");
mkdirSync(cacheDir, { recursive: true });
const bundled = join(cacheDir, "config-schema.mjs");

await build({
  entryPoints: [join(pkgDir, "src/config/index.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The installed chant runs as itself, as it does under the bin.
  plugins: [chantPlugin()],
  logLevel: "warning",
});
const { plywoodSchema } = await import(`${pathToFileURL(bundled).href}?t=${Date.now()}`);
const text = JSON.stringify(plywoodSchema(), null, 2) + "\n";

if (process.argv.includes("--check")) {
  let committed = "";
  try {
    committed = readFileSync(out, "utf8");
  } catch {
    // Missing counts as different.
  }
  if (committed !== text) {
    console.error("plywood.schema.json differs from the config groups; run npm run schema -w @intentius/plywood");
    process.exit(1);
  }
  console.log("  plywood.schema.json matches the config groups");
} else {
  writeFileSync(out, text);
  console.log("  wrote plywood.schema.json");
}
