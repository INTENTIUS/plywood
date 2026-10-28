/**
 * `stacks` and `waves`: each stack as `project/stack` with its directory,
 * extra paths, gate and backend, and the waves they update in. The stacks
 * become chant's Pulumi members; the waves go to chant's product pipeline.
 * Runs before the engine group, which fills each member's engine.
 *
 * `waves` is a list of waves, or a mapping (plywood#18):
 *
 *   canary  the stacks that update first, in a wave of their own
 *   after   stack to the stacks it updates after, for an order the stacks'
 *           StackReferences do not show (src/stack-order.ts adds those)
 *
 * With the mapping, the rest of the stacks wave by environment as when
 * `waves` is absent, and a wave whose stacks read each other is cut so the
 * stack read updates first.
 *
 * A stack's `actions` (plywood#39) are its day-2 actions: each a name, the
 * URN of a `command:` resource in the stack, and a description. `plywood
 * action <stack> <name>` replaces that resource under a gated request
 * (src/actions.ts). The check here is plywood's own and works on any chant.
 */
import { GATES } from "./approval";
import { BACKEND_SCHEMA, error, isObject, mapping, oneOf, onlyKeys, stringList, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";
import type { ChantGatePolicy } from "../chant-config";

export const STACK_KEYS = ["dir", "paths", "gate", "backend", "actions"] as const;
export const ACTION_KEYS = ["name", "urn", "description"] as const;
export const WAVES_KEYS = ["canary", "after"] as const;
const STACK_NAME = /^[^/\s]+\/[^/\s]+$/;

export interface StackSettings {
  dir?: string;
  paths?: string[];
  gate?: ChantGatePolicy;
  backend?: string;
  actions?: StackAction[];
}

/** One of a stack's day-2 actions: the `command:` resource whose replacement runs it. */
export interface StackAction {
  name: string;
  urn: string;
  description?: string;
}

/** An action's name, as chant's request subject takes it (`action:<stack>:<name>`). */
export const ACTION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;

/** The resource types an action may name: the command provider's. */
export const ACTION_TYPE_PREFIX = "command:";

/** The stack and the resource type a Pulumi URN names, or undefined when it is not one. */
export function parseUrn(urn: string): { stack: string; project: string; type: string } | undefined {
  if (!urn.startsWith("urn:pulumi:")) return undefined;
  const parts = urn.slice("urn:pulumi:".length).split("::");
  if (parts.length < 4 || parts.slice(0, 4).some((p) => p === "")) return undefined;
  return { stack: parts[0]!, project: parts[1]!, type: parts[2]!.split("$").at(-1)! };
}

/** What is wrong with `urn` as an action of `stackKey` (`project/stack`), or undefined. */
export function actionUrnProblem(stackKey: string, urn: string): string | undefined {
  const parsed = parseUrn(urn);
  if (!parsed) return `is not a resource URN (urn:pulumi:<stack>::<project>::<type>::<name>)`;
  const stack = stackKey.split("/").at(-1);
  if (parsed.stack !== stack) return `names stack ${parsed.stack}, and the action is under ${stackKey}`;
  if (!parsed.type.startsWith(ACTION_TYPE_PREFIX)) {
    return `is a ${parsed.type}, and an action is a command resource (command:local:Command or command:remote:Command), whose replacement runs it`;
  }
  return undefined;
}

/** The actions plywood.yml declares for the stack `key`. */
export function actionsOf(doc: RawConfig, key: string): StackAction[] {
  const a = stacksOf(doc)[key]?.actions;
  return Array.isArray(a) ? a : [];
}

/** Whether any stack declares an action. */
export function hasActions(doc: RawConfig): boolean {
  return Object.keys(stacksOf(doc)).some((k) => actionsOf(doc, k).length > 0);
}

/** `waves` as a mapping: the canary stacks and the hand-written order. */
export interface WavesMapping {
  canary?: string[];
  after?: Record<string, string[]>;
}

/** The mapping form of `waves`, or an empty one for the list form or none. */
export function wavesMappingOf(doc: RawConfig): WavesMapping {
  return isObject(doc.waves) ? (doc.waves as WavesMapping) : {};
}

/** The stacks plywood.yml lists, by name. */
export function stacksOf(doc: RawConfig): Record<string, StackSettings> {
  return isObject(doc.stacks) ? (doc.stacks as Record<string, StackSettings>) : {};
}

export const stacks: ConfigGroup = {
  name: "stacks",
  keys: ["stacks", "waves"],
  schema: {
    stacks: {
      type: "object",
      description: "Each stack as project/stack. plywood init finds them when the key is absent.",
      propertyNames: { pattern: STACK_NAME.source },
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          dir: { type: "string", description: "The directory holding the stack's Pulumi.yaml." },
          paths: { type: "array", items: { type: "string" }, description: "Paths whose change previews the stack, beside its directory." },
          gate: { type: "string", enum: ["always", "on-destructive", "never"], description: "The stack's gate, in place of the top-level gate." },
          backend: BACKEND_SCHEMA,
          actions: {
            type: "array",
            description: "The stack's day-2 actions, each run by plywood action <stack> <name> under a second person's approval.",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["name", "urn"],
              properties: {
                name: { type: "string", pattern: ACTION_NAME.source, description: "The action's name, unique in the stack." },
                urn: { type: "string", pattern: "^urn:pulumi:", description: "The URN of a command:local:Command or command:remote:Command resource in the stack, replaced to run the action." },
                description: { type: "string", description: "What the action does, for people and agents." },
              },
            },
          },
        },
      },
    },
    waves: {
      description: "Lists of stacks, updated in order, the first wave the canary; or canary and after. One wave per environment when absent.",
      oneOf: [
        { type: "array", items: { type: "array", items: { type: "string" }, minItems: 1 } },
        {
          type: "object",
          additionalProperties: false,
          properties: {
            canary: { type: "array", items: { type: "string" }, minItems: 1, description: "The stacks that update first, in a wave of their own." },
            after: {
              type: "object",
              description: "Each stack to the stacks it updates after, beside the order its StackReferences give.",
              additionalProperties: { type: "array", items: { type: "string" } },
            },
          },
        },
      ],
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [...mapping(doc.stacks, "stacks")];
    const listed = stacksOf(doc);
    for (const [name, s] of Object.entries(listed)) {
      const key = `stacks.${name}`;
      if (!STACK_NAME.test(name)) out.push(error(key, "names a stack as project/stack"));
      if (s === null || s === undefined) continue;
      if (!isObject(s)) {
        out.push(error(key, "must be a mapping"));
        continue;
      }
      out.push(...onlyKeys(s, STACK_KEYS, key));
      if (s.dir !== undefined && typeof s.dir !== "string") out.push(error(`${key}.dir`, "must be a string"));
      if (s.backend !== undefined && typeof s.backend !== "string") out.push(error(`${key}.backend`, "must be a URL string"));
      out.push(...stringList(s.paths, `${key}.paths`), ...oneOf(s.gate, GATES, `${key}.gate`));
      if (s.actions !== undefined) out.push(...actionProblems(name, s.actions, `${key}.actions`));
    }
    if (isObject(doc.waves)) {
      out.push(...wavesMappingProblems(doc.waves, isObject(doc.stacks) ? listed : undefined));
    } else if (doc.waves !== undefined) {
      if (!Array.isArray(doc.waves) || doc.waves.some((w) => !Array.isArray(w) || w.length === 0 || w.some((s) => typeof s !== "string"))) {
        out.push(error("waves", "must be a list of waves, each a list of stack names"));
      } else {
        const seen = new Set<string>();
        doc.waves.forEach((w: string[], i) => {
          for (const s of w) {
            if (seen.has(s)) out.push(error(`waves[${i}]`, `${s} is in more than one wave`));
            seen.add(s);
            if (isObject(doc.stacks) && !(s in listed)) out.push(error(`waves[${i}]`, `${s} is not under stacks`));
          }
        });
      }
    }
    return out;
  },
  translate(doc, out) {
    for (const [name, s] of Object.entries(stacksOf(doc))) {
      const st = s ?? {};
      out.members.push({
        name,
        ...(st.dir !== undefined ? { dir: st.dir } : {}),
        ...(st.paths?.length ? { paths: [...st.paths] } : {}),
        ...(st.gate !== undefined ? { gate: st.gate } : {}),
        ...(st.backend !== undefined ? { backend: st.backend } : {}),
      });
    }
    if (Array.isArray(doc.waves)) out.pipeline.waves = (doc.waves as string[][]).map((w) => [...w]);
    const { canary, after } = wavesMappingOf(doc);
    if (canary?.length) out.pipeline.canary = [...canary];
    if (after && Object.keys(after).length) out.pipeline.after = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, [...v]]));
  },
};

/** The problems with a stack's `actions`: the keys, the names, and each URN's stack and type. */
function actionProblems(stackKey: string, actions: unknown, key: string): ConfigProblem[] {
  if (!Array.isArray(actions)) return [error(key, "must be a list of actions, each with a name and a urn")];
  const out: ConfigProblem[] = [];
  const seen = new Map<string, number>();
  actions.forEach((a: unknown, i) => {
    const at = `${key}[${i}]`;
    if (!isObject(a)) {
      out.push(error(at, "must be a mapping with a name and a urn"));
      return;
    }
    out.push(...onlyKeys(a, ACTION_KEYS, at));
    if (typeof a.name !== "string" || !ACTION_NAME.test(a.name)) out.push(error(`${at}.name`, "must be a name of letters, digits, _, . and -"));
    else if (seen.has(a.name)) out.push(error(`${at}.name`, `${a.name} is the name of actions[${seen.get(a.name)}] too; each action's name is unique in its stack`));
    else seen.set(a.name, i);
    if (typeof a.urn !== "string") out.push(error(`${at}.urn`, "must be the URN of a command resource in the stack"));
    else {
      const problem = actionUrnProblem(stackKey, a.urn);
      if (problem) out.push(error(`${at}.urn`, `${a.urn} ${problem}`));
    }
    if (a.description !== undefined && typeof a.description !== "string") out.push(error(`${at}.description`, "must be a string"));
  });
  return out;
}

/** The problems with `waves` as a mapping. `listed` is set when plywood.yml lists its stacks, so each name can be checked. */
function wavesMappingProblems(w: Record<string, unknown>, listed: Record<string, StackSettings> | undefined): ConfigProblem[] {
  const out: ConfigProblem[] = [...onlyKeys(w, WAVES_KEYS, "waves")];
  const known = (s: string, key: string): void => {
    if (!STACK_NAME.test(s)) out.push(error(key, `${s} is not a stack name (project/stack)`));
    else if (listed && !(s in listed)) out.push(error(key, `${s} is not under stacks`));
  };
  if (w.canary !== undefined) {
    if (!Array.isArray(w.canary) || w.canary.length === 0 || w.canary.some((s) => typeof s !== "string")) out.push(error("waves.canary", "must be a list of stack names"));
    else for (const s of w.canary as string[]) known(s, "waves.canary");
  }
  if (w.after !== undefined) {
    if (!isObject(w.after)) out.push(error("waves.after", "must map a stack to the stacks it updates after"));
    else {
      for (const [stack, ups] of Object.entries(w.after)) {
        const key = `waves.after.${stack}`;
        known(stack, key);
        if (!Array.isArray(ups) || ups.some((u) => typeof u !== "string")) {
          out.push(error(key, "must be a list of stack names"));
          continue;
        }
        for (const u of ups as string[]) {
          if (u === stack) out.push(error(key, `${stack} cannot update after itself`));
          else known(u, key);
        }
      }
      const cycle = afterCycle(w.after as Record<string, string[]>);
      if (cycle) out.push(error("waves.after", `goes round in a circle: ${cycle.join(" after ")}`));
    }
  }
  return out;
}

/** A circle in the hand-written order, as the stacks on it, or undefined. */
export function afterCycle(after: Readonly<Record<string, readonly string[]>>): string[] | undefined {
  const state = new Map<string, "open" | "done">();
  const path: string[] = [];
  const visit = (s: string): string[] | undefined => {
    if (state.get(s) === "done") return undefined;
    if (state.get(s) === "open") return [...path.slice(path.indexOf(s)), s];
    state.set(s, "open");
    path.push(s);
    for (const u of Array.isArray(after[s]) ? after[s]! : []) {
      const found = visit(u);
      if (found) return found;
    }
    path.pop();
    state.set(s, "done");
    return undefined;
  };
  for (const s of Object.keys(after)) {
    const found = visit(s);
    if (found) return found;
  }
  return undefined;
}
