// Builds the plywood CLI into one file, dist/plywood.mjs, that imports Node's
// own modules and the installed @intentius/chant, which the package depends on
// at an exact pin (chant#4591). An @intentius/chant* import stays external when
// Node resolves it, from this package, to compiled JS: the bin then runs the
// pinned chant, and the chant a generated job runs is the same one. A subpath
// the installed chant serves only as TypeScript is bundled.
//   node scripts/build-cli.mjs     (npm run build, just build)
// The metafile goes to the root's node_modules/.cache/plywood for
// scripts/bundle-check.mjs, so it does not ship in the tarball.
import { chmodSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chantPlugin } from "./chant-exports.mjs";
import { build } from "esbuild";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "../..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const outfile = join(pkgDir, "dist/plywood.mjs");
mkdirSync(dirname(outfile), { recursive: true });

const external = new Set();

// The chant the bundle is built with, named in src/chant-product.ts's message
// when that chant has no product pipeline.
const chantPkg = JSON.parse(readFileSync(join(root, "node_modules/@intentius/chant/package.json"), "utf8"));
const builtChant = chantPkg.chantLocal ? `${chantPkg.version} (local ${String(chantPkg.chantLocal.commit).slice(0, 10)})` : chantPkg.version;

// A release's build (chant's release block, chant.config.ts): the cut built both images
// first and names their digests in the file CHANT_RELEASE_DIGESTS points at,
// { "pulumi": "sha256:...", "plunge": "sha256:..." }. The bundle carries them keyed by
// each image's reference at this version, and dist/image-digests.json carries the same
// table for the npm target's `pins`. Any other build has no table, and a pipeline names
// the images by tag.
const digests = releaseDigests();
const digestsFile = join(pkgDir, "dist/image-digests.json");
if (!digests) rmSync(digestsFile, { force: true });

const result = await build({
  entryPoints: [join(pkgDir, "src/bin.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  metafile: true,
  external: [...builtinModules, ...builtinModules.map((m) => `node:${m}`)],
  banner: {
    js: [
      "#!/usr/bin/env node",
      // Bundled CommonJS calls require; give it one.
      'import { createRequire as __plywoodRequire } from "node:module";',
      "const require = __plywoodRequire(import.meta.url);",
    ].join("\n"),
  },
  define: {
    __PLYWOOD_VERSION__: JSON.stringify(pkg.version),
    __PLYWOOD_CHANT__: JSON.stringify(builtChant),
    ...(digests ? { __PLYWOOD_IMAGE_DIGESTS__: JSON.stringify(digests) } : {}),
  },
  plugins: [chantPlugin(external)],
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
if (digests) {
  // The npm target's `pins` reads this file; the publish plan refuses a digest the release did not build.
  const bundled = readFileSync(outfile, "utf8");
  for (const [ref, digest] of Object.entries(digests)) {
    if (!bundled.includes(digest)) {
      console.error(`the bundle does not carry ${ref}@${digest}`);
      process.exit(1);
    }
  }
  writeFileSync(digestsFile, `${JSON.stringify(digests, null, 2)}\n`);
}

const metaDir = join(root, "node_modules/.cache/plywood");
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, "metafile.json"), JSON.stringify(result.metafile));

console.log(`  dist/plywood.mjs ${(statSync(outfile).size / 1024).toFixed(1)} KB, chant ${builtChant}, ${external.size} chant imports external`);

/** The release's image digests by reference, or undefined outside a release build. */
function releaseDigests() {
  const file = process.env.CHANT_RELEASE_DIGESTS;
  if (!file) return undefined;
  // The release's label is the version: `just release-bump` set it on main before the cut.
  const label = process.env.CHANT_RELEASE_LABEL;
  if (label && label !== pkg.version) {
    console.error(`the release is labelled ${label}, and packages/plywood/package.json is at ${pkg.version}; run just release-bump ${label} and cut the merged commit`);
    process.exit(1);
  }
  const named = JSON.parse(readFileSync(file, "utf8"));
  const src = readFileSync(join(pkgDir, "src/images.ts"), "utf8");
  const table = {};
  for (const engine of ["pulumi", "plunge"]) {
    const tool = new RegExp(`${engine}: "([^"]+)"`).exec(src)[1];
    const digest = named[engine];
    if (typeof digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      console.error(`${file} has no digest for the ${engine} image, which the release builds`);
      process.exit(1);
    }
    table[`ghcr.io/intentius/plywood-${engine}:${pkg.version}-${engine}${tool}`] = digest;
  }
  return table;
}
