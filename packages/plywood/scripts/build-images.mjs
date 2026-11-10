// Writes images/plywood-pulumi/Dockerfile and images/plywood-plunge/Dockerfile
// from src/images.ts, which holds the engine pins and their checksums.
//   node scripts/build-images.mjs             (npm run images) writes the files
//   node scripts/build-images.mjs --out <dir> writes them at the same paths below <dir>, for
//                                             chant dev generated-check (chantGenerated in package.json)
//   node scripts/build-images.mjs --tags      prints `<engine> <ref>` for each image this version names,
//                                             which the publish workflow pushes and the release records
// Building an image is `just images`; nothing here builds or pushes one.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { chantExternalPlugin } from "@intentius/chant/bundle-check";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "../..");
const cacheDir = join(root, "node_modules/.cache/plywood");
mkdirSync(cacheDir, { recursive: true });
const bundled = join(cacheDir, "images.mjs");

await build({
  entryPoints: [join(pkgDir, "src/images.ts")],
  outfile: bundled,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // The installed chant runs as itself, as it does under the bin.
  plugins: [chantExternalPlugin(pkgDir)],
  logLevel: "warning",
});
const { dockerfiles, imageFor, TOOL_VERSIONS } = await import(`${pathToFileURL(bundled).href}?t=${Date.now()}`);
const files = dockerfiles();

if (process.argv.includes("--tags")) {
  for (const engine of Object.keys(TOOL_VERSIONS)) {
    const ref = imageFor(engine, {});
    console.log(`${engine} ${ref.repository}:${ref.tag}`);
  }
} else {
  const at = process.argv.indexOf("--out");
  const outRoot = at >= 0 ? process.argv[at + 1] : root;
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(outRoot, path)), { recursive: true });
    writeFileSync(join(outRoot, path), text);
    console.log(`  wrote ${path}`);
  }
}
