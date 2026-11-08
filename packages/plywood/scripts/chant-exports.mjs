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

/**
 * An esbuild plugin that leaves an @intentius/chant* import external when the
 * installed chant serves it as compiled JS ({@link chantRuntimeTarget}), so
 * the code runs the installed, pinned chant. A subpath it serves only as
 * TypeScript is bundled. `external` collects the specifiers left external.
 */
export function chantPlugin(external = new Set()) {
  return {
    name: "chant",
    setup(b) {
      b.onResolve({ filter: CHANT }, (args) => {
        if (!chantRuntimeTarget(args.path)) return undefined;
        external.add(args.path);
        return { path: args.path, external: true };
      });
    },
  };
}
