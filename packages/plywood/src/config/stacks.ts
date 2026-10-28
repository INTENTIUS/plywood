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
 */
import { GATES } from "./approval";
import { BACKEND_SCHEMA, error, isObject, mapping, oneOf, onlyKeys, stringList, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";
import type { ChantGatePolicy } from "../chant-config";

export const STACK_KEYS = ["dir", "paths", "gate", "backend"] as const;
export const WAVES_KEYS = ["canary", "after"] as const;
const STACK_NAME = /^[^/\s]+\/[^/\s]+$/;

export interface StackSettings {
  dir?: string;
  paths?: string[];
  gate?: ChantGatePolicy;
  backend?: string;
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
