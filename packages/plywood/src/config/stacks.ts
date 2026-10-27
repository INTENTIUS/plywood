/**
 * `stacks` and `waves`: each stack as `project/stack` with its directory,
 * extra paths, gate and backend, and the waves they update in. The stacks
 * become chant's Pulumi members; the waves go to chant's product pipeline.
 * Runs before the engine group, which fills each member's engine.
 */
import { GATES } from "./approval";
import { BACKEND_SCHEMA, error, isObject, mapping, oneOf, onlyKeys, stringList, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";
import type { ChantGatePolicy } from "../chant-config";

export const STACK_KEYS = ["dir", "paths", "gate", "backend"] as const;
const STACK_NAME = /^[^/\s]+\/[^/\s]+$/;

export interface StackSettings {
  dir?: string;
  paths?: string[];
  gate?: ChantGatePolicy;
  backend?: string;
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
      type: "array",
      description: "Lists of stacks, updated in order; the first wave is the canary. One wave per environment when absent.",
      items: { type: "array", items: { type: "string" }, minItems: 1 },
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
    if (doc.waves !== undefined) {
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
  },
};
