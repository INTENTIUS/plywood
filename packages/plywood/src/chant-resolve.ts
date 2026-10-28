/**
 * The Op files plywood writes (ops/pulumi-up.op.ts, ops/plywood-drift.op.ts,
 * ops/plywood-review.op.ts, plywood.adopt.op.ts) import `@intentius/chant/op`
 * and `@intentius/chant-lexicon-pulumi`. chant imports them from the
 * repository when it discovers Ops, so Node resolves those imports from the
 * repository's own node_modules. A repository that runs plywood from a global
 * install, as plywood's images do, has no chant there, and discovery failed
 * with `Cannot find package '@intentius/chant'` (plywood#22).
 *
 * {@link installChantResolution} adds one fallback to Node's resolver: an
 * `@intentius/chant` or `@intentius/chant-lexicon-*` import that the
 * importing file's own node_modules cannot satisfy resolves from plywood's
 * install instead, which carries chant and its lexicons at the pin as runtime
 * dependencies. A repository with its own chant keeps it. Any other import,
 * and any other failure, is left as Node reports it.
 *
 * It needs `module.registerHooks` (Node 22.15 and later). On an older Node it
 * installs nothing and the repository needs chant in its own node_modules,
 * as before.
 */
import * as nodeModule from "node:module";

/** The specifiers the fallback covers: chant and its lexicons, with any subpath. */
export const CHANT_SPECIFIER = /^@intentius\/chant(?:-lexicon-[a-z0-9-]+)?(?:\/|$)/;

interface ResolveResult {
  url: string;
  format?: string | null;
  shortCircuit?: boolean;
}
type NextResolve = (specifier: string, context?: Record<string, unknown>) => ResolveResult;
type RegisterHooks = (hooks: { resolve: (specifier: string, context: Record<string, unknown>, next: NextResolve) => ResolveResult }) => unknown;

/** The resolve hook: `next` as it is, then from `from` for a chant import the importer could not find. */
export function chantResolveHook(from: string) {
  return (specifier: string, context: Record<string, unknown>, next: NextResolve): ResolveResult => {
    try {
      return next(specifier, context);
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (!CHANT_SPECIFIER.test(specifier) || (code !== "ERR_MODULE_NOT_FOUND" && code !== "MODULE_NOT_FOUND")) throw err;
      if (context.parentURL === from) throw err;
      return next(specifier, { ...context, parentURL: from });
    }
  };
}

let installed = false;

/** Install the fallback once. Returns whether it is installed. */
export function installChantResolution(from: string = import.meta.url): boolean {
  if (installed) return true;
  const register = (nodeModule as unknown as { registerHooks?: RegisterHooks }).registerHooks;
  if (typeof register !== "function") return false;
  register({ resolve: chantResolveHook(from) });
  installed = true;
  return true;
}
