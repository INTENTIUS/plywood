/**
 * `branches`, `labels` and `forge`: which branch updates which stacks, which
 * label narrows a pull request's previews, and the forge the jobs talk to.
 *
 *   branches  branch to stack globs  ci.branches
 *   labels    label to stack globs   ci.labels (never a gate)
 *   forge     kind and url           the pipeline's forge
 */
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem } from "./types";

export const FORGES = ["github", "gitlab", "forgejo"] as const;

const GLOB_MAP = {
  type: "object",
  additionalProperties: { type: "array", items: { type: "string" } },
};

function globMapProblems(v: unknown, key: string): ConfigProblem[] {
  if (v === undefined) return [];
  if (!isObject(v)) return [error(key, "must map a name to a list of stack globs")];
  return Object.entries(v)
    .filter(([, globs]) => !Array.isArray(globs) || globs.some((g) => typeof g !== "string"))
    .map(([k]) => error(`${key}.${k}`, "must be a list of stack globs"));
}

const copy = (v: Record<string, string[]>): Record<string, string[]> => Object.fromEntries(Object.entries(v).map(([k, g]) => [k, [...g]]));

export const routing: ConfigGroup = {
  name: "routing",
  keys: ["branches", "labels", "forge"],
  schema: {
    branches: { ...GLOB_MAP, description: "Branch name to stack globs. A stack a glob matches updates from that branch alone." },
    labels: { ...GLOB_MAP, description: "Pull request label to stack globs. A labelled pull request previews only the stacks its labels match." },
    forge: {
      type: "object",
      additionalProperties: false,
      description: "The forge the jobs talk to. Read from the repository's remote when absent.",
      properties: {
        kind: { type: "string", enum: [...FORGES] },
        url: { type: "string", description: "The forge's base URL, for a self-hosted forge." },
      },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [...globMapProblems(doc.branches, "branches"), ...globMapProblems(doc.labels, "labels")];
    const f = doc.forge;
    if (f !== undefined) {
      if (!isObject(f)) out.push(error("forge", "must be a mapping of kind and url"));
      else {
        out.push(...onlyKeys(f, ["kind", "url"], "forge"), ...oneOf(f.kind, FORGES, "forge.kind"));
        if (f.url !== undefined && (typeof f.url !== "string" || !/^https?:\/\//.test(f.url))) out.push(error("forge.url", "must be an http or https URL"));
      }
    }
    return out;
  },
  translate(doc, out) {
    if (isObject(doc.branches)) out.ci.branches = copy(doc.branches as Record<string, string[]>);
    if (isObject(doc.labels)) out.ci.labels = copy(doc.labels as Record<string, string[]>);
    if (isObject(doc.forge)) {
      const f = doc.forge as { kind?: string; url?: string };
      out.pipeline.forge = { ...(f.kind ? { kind: f.kind } : {}), ...(f.url ? { url: f.url } : {}) };
    }
  },
};
