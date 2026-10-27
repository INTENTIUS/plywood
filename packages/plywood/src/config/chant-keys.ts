/**
 * chant keys in plywood.yml are refused. plywood turns its own keys into
 * chant's settings (src/chant-config.ts), so a `ci:` block, or a dotted
 * `ci.<key>` written as one key, is refused with the plywood key that sets
 * the same thing.
 */
import { error, isObject, type ConfigGroup, type ConfigProblem } from "./types";

/** chant's `ci.<key>` to the plywood key that sets it; null where plywood sets it itself. */
export const PLYWOOD_KEY_FOR: Readonly<Record<string, string | null>> = {
  workflow: "apply.when",
  locks: "locks.when",
  lockGrain: "locks.grain",
  prEnvironment: "review_stacks",
  branches: "branches",
  labels: "labels",
  policy: "policy",
  identity: "identity",
  reportUrl: "reports",
  hooks: null,
  green: null,
};

/** Why `ci.<sub>` is refused, naming the plywood key that sets it. */
export function chantKeyMessage(sub: string | undefined): string {
  if (sub === undefined) return "is chant's block, and plywood.yml holds no chant key; set plywood's keys (apply, locks, review_stacks, branches, labels) and plywood sets chant's";
  const plywood = PLYWOOD_KEY_FOR[sub];
  if (plywood) return `is chant's key; set ${plywood} in plywood.yml, and plywood sets ci.${sub} from it`;
  if (plywood === null) return `is chant's key, and plywood sets ci.${sub} itself`;
  return `is chant's key, and plywood.yml has no key for ci.${sub}`;
}

export const chantKeys: ConfigGroup = {
  name: "chant keys",
  keys: [],
  schema: {},
  check(doc) {
    const out: ConfigProblem[] = [];
    for (const [key, v] of Object.entries(doc)) {
      if (key === "ci") {
        if (isObject(v) && Object.keys(v).length) for (const sub of Object.keys(v)) out.push(error(`ci.${sub}`, chantKeyMessage(sub)));
        else out.push(error("ci", chantKeyMessage(undefined)));
      } else if (key.startsWith("ci.")) {
        const sub = key.slice(3).split(".")[0];
        out.push(error(key, chantKeyMessage(sub)));
      }
    }
    return out;
  },
  translate() {},
};
