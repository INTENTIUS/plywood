// Builds the plywood CLI into one file, dist/plywood.mjs, that imports Node's
// own modules and the installed @intentius/chant, which the package depends on
// at an exact pin (chant#4591). An @intentius/chant* import stays external when
// Node resolves it, from this package, to compiled JS: the bin then runs the
// pinned chant, and the chant a generated job runs is the same one. A subpath
// the installed chant serves only as TypeScript is bundled.
//   node scripts/build-cli.mjs     (npm run build, just build)
// The metafile goes to the root's node_modules/.cache/plywood for chant's
// bundle check (`chant dev bundle-check`, package.json's chantBundleCheck), so
// it does not ship in the tarball.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { releaseImagePins, writeReleaseImagePins } from "@intentius/chant/lifecycle/release-images";
import { chantExternalPlugin } from "@intentius/chant/bundle-check";
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
// first and names their digests in the file CHANT_RELEASE_DIGESTS points at. chant's
// releaseImagePins keys them by each image's reference at this version, which
// src/images.ts names; the bundle carries the table, and dist/image-digests.json carries
// it for the npm target's `pins`. Any other build has no table, and a pipeline names the
// images by tag.
const digests = await chantRelease(async () => releaseImagePins({ images: await imageReferences(), version: pkg.version }));
const digestsFile = join(pkgDir, "dist/image-digests.json");

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
  plugins: [chantExternalPlugin(pkgDir, external)],
  logLevel: "warning",
});
chmodSync(outfile, 0o755);
// The npm target's `pins` reads this file; the publish plan refuses a digest the release did not build.
// Outside a release build chant removes it.
await chantRelease(() => writeReleaseImagePins(digests, { out: digestsFile, bundles: [outfile] }));

const metaDir = join(root, "node_modules/.cache/plywood");
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, "metafile.json"), JSON.stringify(result.metafile));

console.log(`  dist/plywood.mjs ${(statSync(outfile).size / 1024).toFixed(1)} KB, chant ${builtChant}, ${external.size} chant imports external`);

/** Each image's reference at this version, by engine, from src/images.ts. */
async function imageReferences() {
  const bundled = join(root, "node_modules/.cache/plywood/images-refs.mjs");
  await build({ entryPoints: [join(pkgDir, "src/images.ts")], outfile: bundled, bundle: true, platform: "node", format: "esm", target: "node22", plugins: [chantExternalPlugin(pkgDir)], logLevel: "warning" });
  const { imageFor, TOOL_VERSIONS } = await import(`${pathToFileURL(bundled).href}?t=${Date.now()}`);
  return Object.fromEntries(Object.keys(TOOL_VERSIONS).map((engine) => {
    const ref = imageFor(engine, {});
    return [engine, `${ref.repository}:${ref.tag}`];
  }));
}

/** Run one of chant's release steps, printing its refusal and fix line in place of a stack trace. */
async function chantRelease(step) {
  try {
    return await step();
  } catch (e) {
    if (!e || typeof e.code !== "string") throw e;
    console.error(e.fix ? `${e.message}\n${e.fix}` : e.message);
    process.exit(1);
  }
}
