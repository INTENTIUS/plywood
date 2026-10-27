// Builds the plywood CLI into one file, dist/plywood.mjs, that imports Node's
// own modules and the installed @intentius/chant, which the package depends on
// at an exact pin (chant#4591). An @intentius/chant* import stays external when
// Node resolves it, from this package, to compiled JS: the bin then runs the
// pinned chant, and the chant a generated job runs is the same one. A subpath
// the installed chant serves only as TypeScript (chant 0.124.54 has no
// `import` condition) is bundled, as before.
//   node scripts/build-cli.mjs     (npm run build, just build)
// The metafile goes to the root's node_modules/.cache/plywood for
// scripts/bundle-check.mjs, so it does not ship in the tarball.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
  define: { __PLYWOOD_VERSION__: JSON.stringify(pkg.version), __PLYWOOD_CHANT__: JSON.stringify(builtChant) },
  plugins: [chantPlugin(external)],
  logLevel: "warning",
});
chmodSync(outfile, 0o755);

const metaDir = join(root, "node_modules/.cache/plywood");
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, "metafile.json"), JSON.stringify(result.metafile));

console.log(`  dist/plywood.mjs ${(statSync(outfile).size / 1024).toFixed(1)} KB, chant ${builtChant}, ${external.size} chant imports external`);
