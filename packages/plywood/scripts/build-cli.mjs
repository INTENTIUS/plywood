// Builds the plywood CLI into one file, dist/plywood.mjs, that imports only
// Node's own modules. The chant code plywood calls is bundled in; the package
// depends on @intentius/chant at an exact pin for the chant a generated job
// runs beside it.
//   node scripts/build-cli.mjs     (npm run build, just build)
// The metafile goes to the root's node_modules/.cache/plywood for
// scripts/bundle-check.mjs, so it does not ship in the tarball.
import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const pkgDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const root = join(pkgDir, "../..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const outfile = join(pkgDir, "dist/plywood.mjs");
mkdirSync(dirname(outfile), { recursive: true });

// chant subpaths a released chant may lack (src/exit-codes.ts,
// src/chant-product.ts). One the
// installed chant lacks resolves to a module that throws when imported, so
// the bundle builds on the pin and the caller's fallback takes over; a chant
// that has it is bundled in.
const CHANT_NEXT = /^@intentius\/chant\/(exit-codes|ci-product)$/;
const chantNext = {
  name: "chant-next",
  setup(b) {
    b.onResolve({ filter: CHANT_NEXT }, async (args) => {
      if (args.pluginData?.chantNext) return undefined;
      const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { chantNext: true } });
      return r.errors.length === 0 ? undefined : { path: args.path, namespace: "chant-next-missing" };
    });
    b.onLoad({ filter: /.*/, namespace: "chant-next-missing" }, (args) => ({
      loader: "js",
      contents: `throw new Error(${JSON.stringify(`the installed chant has no ${args.path}`)});\n`,
    }));
  },
};

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
  plugins: [chantNext],
  logLevel: "warning",
});
chmodSync(outfile, 0o755);

const metaDir = join(root, "node_modules/.cache/plywood");
mkdirSync(metaDir, { recursive: true });
writeFileSync(join(metaDir, "metafile.json"), JSON.stringify(result.metafile));

console.log(`  dist/plywood.mjs ${(statSync(outfile).size / 1024).toFixed(1)} KB`);
