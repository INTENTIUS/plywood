// How plywood's build scripts treat @intentius/chant* imports (chant#4591).
//   used by scripts/build-cli.mjs, build-images.mjs, build-schema.mjs and
//   bundle-check.mjs

/**
 * Where Node, running plywood's bin, would load `specifier` from. Resolution
 * starts in this directory, which sits in the package beside dist/, so it
 * walks the same node_modules the bin does, with Node's own conditions
 * (`import`, `node`, `default`). The answer is the file URL when that is
 * compiled JS, else undefined: a subpath the installed chant does not export,
 * or one it exports only as TypeScript, which plain Node does not load from
 * node_modules.
 */
export function chantRuntimeTarget(specifier) {
  let url;
  try {
    url = import.meta.resolve(specifier);
  } catch {
    return undefined;
  }
  return /^file:.*\.(?:m?js|cjs)$/.test(url) ? url : undefined;
}

const CHANT = /^@intentius\/chant(?:-[a-z0-9-]+)?(?:\/.*)?$/;

// chant subpaths a released chant may lack (src/exit-codes.ts,
// src/chant-product.ts, src/control.ts, src/init/backend.ts, src/init.ts), and the pulumi
// lexicon's ci-setup (src/images.ts, chant#4592) and release-copy (src/stack-ops.ts, chant#4542). One the installed chant lacks resolves to a module
// that throws when imported, so the bundle builds on the pin and the caller's
// fallback takes over.
const CHANT_NEXT = /^@intentius\/(?:chant\/(?:exit-codes|ci-product|ci-control|bucket-check|components\/check-hooks)|chant-lexicon-pulumi\/(?:ci-setup|release-copy))$/;

/**
 * An esbuild plugin that leaves an @intentius/chant* import external when the
 * installed chant serves it as compiled JS ({@link chantRuntimeTarget}), so
 * the code runs the installed, pinned chant. A subpath it serves only as
 * TypeScript (chant 0.124.54 has no `import` condition) is bundled, and a
 * missing CHANT_NEXT subpath becomes a module that throws. `external`
 * collects the specifiers left external.
 */
export function chantPlugin(external = new Set()) {
  return {
    name: "chant",
    setup(b) {
      b.onResolve({ filter: CHANT }, async (args) => {
        if (args.pluginData?.chantNext) return undefined;
        if (chantRuntimeTarget(args.path)) {
          external.add(args.path);
          return { path: args.path, external: true };
        }
        if (!CHANT_NEXT.test(args.path)) return undefined;
        const r = await b.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, pluginData: { chantNext: true } });
        return r.errors.length === 0 ? undefined : { path: args.path, namespace: "chant-next-missing" };
      });
      b.onLoad({ filter: /.*/, namespace: "chant-next-missing" }, (args) => ({
        loader: "js",
        contents: `throw new Error(${JSON.stringify(`the installed chant has no ${args.path}`)});\n`,
      }));
    },
  };
}
