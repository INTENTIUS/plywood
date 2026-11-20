/**
 * Hooks before and after a preview and an update (plywood#36), on chant's
 * stage hooks: `ci.hooks` in chant.workspace.json, the block that already
 * holds the check hooks. plywood runs no hook itself.
 *
 *   preview, /plywood preview   chant's `components pr-plan` reads `ci.hooks`
 *                               at the base commit and runs before.observe,
 *                               before.plan and after.plan (chant#4288)
 *   update before merge         chant's `components pr-apply` runs every moment
 *   update on merge             chant's wave job runs the waves spec's
 *                               `hooks`, read at the merge's first parent
 *                               (chant#3762); `plywood ci` and `plywood init`
 *                               copy `ci.hooks` into the spec here
 *
 * The copy is the hooks chant's pull request jobs run at the repository's
 * root (`prLoopHooksOf`: the top level's, then those of the member at `.`),
 * so a wave runs the same hooks a preview did. A pull request job matches a
 * hook's `targets` against component names (`shop-dev`), and a wave against
 * its runs' targets, the stack keys (`shop/dev`): the copy keeps a hook's
 * patterns as they select components and names the matching stacks in their
 * place, and leaves out a hook that matches none of the waves' stacks.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OpWaveHook, OpWaveHookMoment, OpWaveHooks } from "@intentius/chant/op";
import { opWaveHookRuns } from "@intentius/chant/op";
import { prLoopHooksOf } from "@intentius/chant/components/pr-hooks";
import { parseDeclaration } from "@intentius/chant/workspace/declaration";
import { memberAtCwd } from "@intentius/chant/workspace/security";
import { componentName } from "./init/render";

/** The workspace declaration plywood reads `ci.hooks` from, in the order chant looks. */
export const DECLARATION_FILES = ["chant.workspace.json", "chant.workspace.jsonc"] as const;

/** Each pull request moment and where it goes in a waves spec's `hooks`. */
const SPEC_PLACE: Readonly<Record<OpWaveHookMoment, readonly ["before" | "after", string]>> = {
  "before-observe": ["before", "observe"],
  "before-plan": ["before", "plan"],
  "after-plan": ["after", "plan"],
  "after-gate": ["after", "gate"],
  "before-apply": ["before", "apply"],
  "after-apply": ["after", "apply"],
};

/** A declaration's text and file name. */
export interface DeclarationText {
  text: string;
  file: string;
}

/** The declaration under `root`, or undefined when there is none. */
export function readDeclarationText(root: string): DeclarationText | undefined {
  for (const file of DECLARATION_FILES) {
    const path = join(root, file);
    if (existsSync(path)) return { text: readFileSync(path, "utf8"), file };
  }
  return undefined;
}

/**
 * The hooks chant's pull request jobs run at `root` from `declaration`, by
 * moment: `ci.hooks` at the top level, then the hooks of the member whose
 * directory is the root. Throws chant's message when the declaration is
 * not one chant reads.
 */
export function rootHooksOf(declaration: DeclarationText, root: string): Partial<Record<OpWaveHookMoment, OpWaveHook[]>> {
  const parsed = parseDeclaration(declaration.text, declaration.file);
  return prLoopHooksOf(parsed, memberAtCwd({ declaration: parsed, rootOnDisk: root }, root));
}

interface SpecLike {
  hooks?: OpWaveHooks;
  waves?: Array<{ runs?: Array<{ target?: unknown }> }>;
}

/**
 * One hook as a waves spec takes it: with `targets`, the stacks whose
 * component the patterns match. Undefined when they match none.
 */
function waveHook(hook: OpWaveHook, stacks: readonly string[]): OpWaveHook | undefined {
  if (!hook.targets) return structuredClone(hook);
  const matched = opWaveHookRuns(hook, stacks.map((stack) => ({ target: componentName({ key: stack }), stack }))).map((r) => r.stack);
  return matched.length > 0 ? { ...structuredClone(hook), targets: matched } : undefined;
}

/**
 * The waves spec's `hooks` for `hooks`, the pull request jobs' hooks by
 * moment, over the stacks `spec`'s waves update. Undefined when none is left.
 */
export function specHooksOf(hooks: Partial<Record<OpWaveHookMoment, OpWaveHook[]>>, spec: SpecLike): OpWaveHooks | undefined {
  const stacks = (spec.waves ?? []).flatMap((w) => (w.runs ?? []).map((r) => r.target)).filter((t): t is string => typeof t === "string");
  const out: { before?: Record<string, OpWaveHook[]>; after?: Record<string, OpWaveHook[]> } = {};
  for (const [moment, [side, stage]] of Object.entries(SPEC_PLACE) as Array<[OpWaveHookMoment, readonly ["before" | "after", string]]>) {
    const list = (hooks[moment] ?? []).map((h) => waveHook(h, stacks)).filter((h): h is OpWaveHook => h !== undefined);
    if (list.length === 0) continue;
    (out[side] ??= {})[stage] = list;
  }
  return Object.keys(out).length > 0 ? (out as OpWaveHooks) : undefined;
}

/**
 * `spec` with its top-level `hooks` set from `declaration`'s `ci.hooks`
 * (the check hooks aside), as chant's pull request jobs at `root` read them.
 * The spec's `hooks.apply.runBy` and each wave's own hooks stay as they are.
 * Without a declaration, the spec comes back unchanged.
 */
export function withDeclarationHooks<T>(spec: T, declaration: DeclarationText | undefined, root: string): T {
  if (!declaration || !spec || typeof spec !== "object") return spec;
  const s = spec as T & SpecLike;
  const hooks = specHooksOf(rootHooksOf(declaration, root), s);
  const runBy = (s.hooks as { apply?: { runBy?: unknown } } | undefined)?.apply;
  const next: OpWaveHooks | undefined = hooks || runBy ? { ...(hooks ?? {}), ...(runBy ? { apply: structuredClone(runBy) as OpWaveHooks["apply"] } : {}) } : undefined;
  const { hooks: _old, ...rest } = s as SpecLike & Record<string, unknown>;
  // `hooks` goes before `waves`, where a person reading the file looks for it.
  if (!next) return rest as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rest)) {
    if (k === "waves") out.hooks = next;
    out[k] = v;
  }
  if (!("hooks" in out)) out.hooks = next;
  return out as T;
}
