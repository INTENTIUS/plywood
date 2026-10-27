/**
 * `locks`: when a pull request takes its locks and what one lock covers.
 *
 *   locks.when preview (default)  ci.locks plan    from the first preview (plywood#2 ruling)
 *   locks.when up                 ci.locks apply   from an update before merge or a /plywood lock comment
 *   locks.grain resource (default) ci.lockGrain resource  one lock per resource URN
 *   locks.grain stack              ci.lockGrain target    one lock per stack
 *
 * `ci.lockGrain` is chant#4552's key (ruling A). Under the resource grain a
 * pull request's target locks are its URN rows too (ruling D), so
 * `locks.when` and `locks.grain` together say what a pull request holds.
 * chant's `repo` grain has no plywood value.
 */
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type RawConfig } from "./types";
import type { ChantCiLocks, ChantLockGrain } from "../chant-config";

export const LOCKS_WHEN = ["preview", "up"] as const;
export type LocksWhen = (typeof LOCKS_WHEN)[number];
export const DEFAULT_LOCKS_WHEN: LocksWhen = "preview";

export const LOCK_GRAINS = ["resource", "stack"] as const;
export type LockGrain = (typeof LOCK_GRAINS)[number];
export const DEFAULT_LOCK_GRAIN: LockGrain = "resource";

export const CI_LOCKS_OF: Readonly<Record<LocksWhen, ChantCiLocks>> = { preview: "plan", up: "apply" };
export const LOCK_GRAIN_OF: Readonly<Record<LockGrain, ChantLockGrain>> = { resource: "resource", stack: "target" };

export function locksOf(doc: RawConfig): { when: LocksWhen; grain: LockGrain } {
  const l = isObject(doc.locks) ? doc.locks : {};
  return {
    when: l.when === "up" ? "up" : DEFAULT_LOCKS_WHEN,
    grain: l.grain === "stack" ? "stack" : DEFAULT_LOCK_GRAIN,
  };
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
        grain: { type: "string", enum: [...LOCK_GRAINS], default: DEFAULT_LOCK_GRAIN, description: "resource, one lock per resource, or stack, one lock per stack." },
      },
    },
  },
  check(doc) {
    if (doc.locks === undefined) return [];
    if (!isObject(doc.locks)) return [error("locks", "must be a mapping")];
    return [...onlyKeys(doc.locks, ["when", "grain"], "locks"), ...oneOf(doc.locks.when, LOCKS_WHEN, "locks.when"), ...oneOf(doc.locks.grain, LOCK_GRAINS, "locks.grain")];
  },
  translate(doc, out) {
    const { when, grain } = locksOf(doc);
    out.ci.locks = CI_LOCKS_OF[when];
    out.ci.lockGrain = LOCK_GRAIN_OF[grain];
  },
};
