// Writes plywood.schema.json from the config groups in src/config: each group
// holds the schema of its own keys, and src/config/index.ts composes them.
//   node scripts/build-schema.mjs             (npm run schema) writes the file
//   node scripts/build-schema.mjs --out <dir> writes it at the same path below <dir>, for
//                                             chant dev generated-check (chantGenerated in package.json)
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chantExternalPlugin } from "@intentius/chant/bundle-check";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "../..");
const at = process.argv.indexOf("--out");
const out = join(at >= 0 ? process.argv[at + 1] : root, "packages/plywood/plywood.schema.json");
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
  plugins: [chantExternalPlugin(pkgDir)],
  logLevel: "warning",
});
const { plywoodSchema } = await import(`${pathToFileURL(bundled).href}?t=${Date.now()}`);
const text = JSON.stringify(plywoodSchema(), null, 2) + "\n";

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text);
console.log("  wrote plywood.schema.json");
