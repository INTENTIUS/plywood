/**
 * `locks`: when a pull request takes its locks and what one lock covers.
 *
 *   locks.when preview (default)  ci.locks plan    from the first preview (plywood#2 ruling)
 *   locks.when up                 ci.locks apply   from an update before merge or a /plywood lock comment
 *   locks.grain resource           ci.lockGrain resource  one lock per resource URN
 *   locks.grain stack              ci.lockGrain target    one lock per stack
 *   locks.grain absent (default)   no ci.lockGrain        each stack's engine decides:
 *                                                         resource on plunge, stack on
 *                                                         stock Pulumi (plywood#17)
 *
 * `ci.lockGrain` is chant#4552's key (ruling A). Under the resource grain a
 * pull request's target locks are its URN rows too (ruling D), so
 * `locks.when` and `locks.grain` together say what a pull request holds.
 * chant's `repo` grain has no plywood value.
 *
 * The default is per engine, and chant's pulumi lexicon holds it
 * (`pulumiDefaultLockGrain`): plunge keeps a record per resource, so two
 * updates to different resources of one stack run side by side, while stock
 * Pulumi's backend locks the whole stack and chant refuses the resource
 * grain on it by name. plywood therefore writes `ci.lockGrain` only when
 * plywood.yml sets `locks.grain`, and refuses `resource` on a stack it knows
 * runs stock Pulumi.
 */
import { engineOf, type Engine } from "./engine";
import { stacksOf } from "./stacks";
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";
import type { ChantCiLocks, ChantLockGrain } from "../chant-config";

export const LOCKS_WHEN = ["preview", "up"] as const;
export type LocksWhen = (typeof LOCKS_WHEN)[number];
export const DEFAULT_LOCKS_WHEN: LocksWhen = "preview";

export const LOCK_GRAINS = ["resource", "stack"] as const;
export type LockGrain = (typeof LOCK_GRAINS)[number];
/** The grain each engine takes when plywood.yml sets none, as chant's pulumi lexicon defaults it. */
export const DEFAULT_LOCK_GRAIN: Readonly<Record<Engine, LockGrain>> = { plunge: "resource", pulumi: "stack" };

/** The grain a stack on `engine` takes; `undefined` engine is chant's to detect, so the grain follows it. */
export function lockGrainFor(doc: RawConfig, engine: Engine | undefined): LockGrain | "per-engine" {
  const set = locksOf(doc).grain;
  if (set) return set;
  return engine ? DEFAULT_LOCK_GRAIN[engine] : "per-engine";
}

export const CI_LOCKS_OF: Readonly<Record<LocksWhen, ChantCiLocks>> = { preview: "plan", up: "apply" };
export const LOCK_GRAIN_OF: Readonly<Record<LockGrain, ChantLockGrain>> = { resource: "resource", stack: "target" };

/** `locks` as read; `grain` is undefined when plywood.yml leaves it to each stack's engine. */
export function locksOf(doc: RawConfig): { when: LocksWhen; grain?: LockGrain } {
  const l = isObject(doc.locks) ? doc.locks : {};
  return {
    when: l.when === "up" ? "up" : DEFAULT_LOCKS_WHEN,
    ...(l.grain === "stack" || l.grain === "resource" ? { grain: l.grain } : {}),
  };
}

/** The stacks plywood.yml puts on stock Pulumi: `engine: pulumi`, with no plunge backend of their own. */
function stockStacks(doc: RawConfig): string[] {
  if (doc.engine !== "pulumi") return [];
  const named = Object.keys(stacksOf(doc)).filter((n) => engineOf(doc, stacksOf(doc)[n]?.backend)?.engine === "pulumi");
  return named.length ? named : ["every stack"];
}

export const locks: ConfigGroup = {
  name: "locks",
  keys: ["locks"],
  schema: {
    locks: {
      type: "object",
      additionalProperties: false,
      properties: {
        when: { type: "string", enum: [...LOCKS_WHEN], default: DEFAULT_LOCKS_WHEN, description: "preview, from the first preview, or up, from an update before merge or a /plywood lock comment." },
        grain: { type: "string", enum: [...LOCK_GRAINS], description: "resource, one lock per resource, or stack, one lock per stack. Absent, resource on plunge and stack on stock Pulumi." },
      },
    },
  },
  check(doc) {
    if (doc.locks === undefined) return [];
    if (!isObject(doc.locks)) return [error("locks", "must be a mapping")];
    const out: ConfigProblem[] = [...onlyKeys(doc.locks, ["when", "grain"], "locks"), ...oneOf(doc.locks.when, LOCKS_WHEN, "locks.when"), ...oneOf(doc.locks.grain, LOCK_GRAINS, "locks.grain")];
    if (doc.locks.grain === "resource") {
      const stock = stockStacks(doc);
      if (stock.length) {
        out.push(error("locks.grain", `is resource and engine is pulumi (${stock.join(", ")}): stock Pulumi's backend locks the whole stack, so chant locks it per stack. Leave locks.grain out, or set engine: plunge`));
      }
    }
    return out;
  },
  translate(doc, out) {
    const { when, grain } = locksOf(doc);
    out.ci.locks = CI_LOCKS_OF[when];
    if (grain) out.ci.lockGrain = LOCK_GRAIN_OF[grain];
  },
};
