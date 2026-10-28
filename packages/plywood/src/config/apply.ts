/**
 * `apply`: when a change updates its stacks. `when: merge` (the default)
 * updates after the merge; `when: pull-request` updates an open pull request
 * on `/plywood up`, and `requires` lists what it needs first (all four by
 * default). Values follow terragucci's `apply` key.
 *
 *   apply.when merge         ci.workflow trunk-curated+apply-on-merge
 *   apply.when pull-request  ci.workflow apply-before-merge
 *
 * `merge: auto` merges the pull request once its update before merge
 * applied and its record is on the ledger, with the head checked again
 * first (chant#4636 `applyMerge`). The merge uses the token in the variable
 * `merge_token_env` names, never the job's: a secret of that name on GitHub
 * and Forgejo, a protected variable on GitLab. `merge_method` is merge,
 * squash or rebase (the forge's default when absent). A refused merge
 * leaves the update recorded and says why on the pull request.
 */
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";
import type { ChantCiWorkflow } from "../chant-config";

export const APPLY_WHEN = ["merge", "pull-request"] as const;
export type ApplyWhen = (typeof APPLY_WHEN)[number];
export const DEFAULT_APPLY_WHEN: ApplyWhen = "merge";

/** What an open pull request needs before `/plywood up`: an approval of its head, a forge that says it can merge, a head containing the default branch, and every check passed. */
export const APPLY_REQUIRES = ["approved", "mergeable", "undiverged", "checks"] as const;

export const APPLY_MERGE = ["manual", "auto"] as const;
export const MERGE_METHODS = ["merge", "squash", "rebase"] as const;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `apply.merge: auto` as chant's `applyMerge`, or undefined. */
export function applyMergeOf(doc: RawConfig): { tokenEnv: string; method?: (typeof MERGE_METHODS)[number] } | undefined {
  const a = isObject(doc.apply) ? doc.apply : {};
  if (a.merge !== "auto" || typeof a.merge_token_env !== "string") return undefined;
  const method = (MERGE_METHODS as readonly unknown[]).includes(a.merge_method) ? (a.merge_method as (typeof MERGE_METHODS)[number]) : undefined;
  return { tokenEnv: a.merge_token_env, ...(method ? { method } : {}) };
}

export const WORKFLOW_OF: Readonly<Record<ApplyWhen, ChantCiWorkflow>> = {
  merge: "trunk-curated+apply-on-merge",
  "pull-request": "apply-before-merge",
};

export function applyWhenOf(doc: RawConfig): ApplyWhen {
  const a = isObject(doc.apply) ? doc.apply : {};
  return a.when === "pull-request" ? "pull-request" : DEFAULT_APPLY_WHEN;
}

/** The checks apply.requires lists, in plywood.yml's order; all four when it lists none. */
export function applyRequiresOf(doc: RawConfig): string[] {
  const a = isObject(doc.apply) ? doc.apply : {};
  return Array.isArray(a.requires) ? (a.requires as unknown[]).filter((r): r is string => typeof r === "string") : [...APPLY_REQUIRES];
}

export const apply: ConfigGroup = {
  name: "apply",
  keys: ["apply"],
  schema: {
    apply: {
      type: "object",
      additionalProperties: false,
      properties: {
        when: { type: "string", enum: [...APPLY_WHEN], default: DEFAULT_APPLY_WHEN, description: "merge, or pull-request for /plywood up before merge." },
        requires: {
          type: "array",
          items: { type: "string", enum: [...APPLY_REQUIRES] },
          uniqueItems: true,
          description: "What an open pull request needs before /plywood up updates it. All four when absent. Only with when: pull-request.",
        },
        merge: { type: "string", enum: [...APPLY_MERGE], default: "manual", description: "auto merges the pull request once its update before merge applied. Only with when: pull-request." },
        merge_token_env: { type: "string", description: "The variable holding the token the merge uses: a secret on GitHub and Forgejo, a protected variable on GitLab. Needed with merge: auto." },
        merge_method: { type: "string", enum: [...MERGE_METHODS], description: "merge, squash or rebase. The forge's default when absent." },
      },
    },
  },
  check(doc) {
    if (doc.apply === undefined) return [];
    if (!isObject(doc.apply)) return [error("apply", "must be a mapping")];
    const a = doc.apply;
    const out: ConfigProblem[] = [
      ...onlyKeys(a, ["when", "requires", "merge", "merge_token_env", "merge_method"], "apply"),
      ...oneOf(a.when, APPLY_WHEN, "apply.when"),
      ...oneOf(a.merge, APPLY_MERGE, "apply.merge"),
      ...oneOf(a.merge_method, MERGE_METHODS, "apply.merge_method"),
    ];
    if (a.merge === "auto") {
      if (a.when !== "pull-request") out.push(error("apply.merge", "auto merges after an update before merge; set apply.when: pull-request, or drop it"));
      if (typeof a.merge_token_env !== "string" || !VARIABLE.test(a.merge_token_env)) out.push(error("apply.merge_token_env", "names the variable holding the merge's token, such as PLYWOOD_MERGE_TOKEN; merge: auto never merges with the job's token"));
    } else if (a.merge_token_env !== undefined || a.merge_method !== undefined) {
      out.push(error(a.merge_token_env !== undefined ? "apply.merge_token_env" : "apply.merge_method", "goes with apply.merge: auto"));
    }
    if (a.requires !== undefined) {
      if (!Array.isArray(a.requires)) out.push(error("apply.requires", `must be a list of ${APPLY_REQUIRES.join(", ")}`));
      else {
        for (const r of a.requires) out.push(...oneOf(r, APPLY_REQUIRES, "apply.requires"));
        if (a.when !== "pull-request") out.push(error("apply.requires", "applies only to an update before merge; set apply.when: pull-request, or drop it"));
      }
    }
    return out;
  },
  translate(doc, out) {
    const when = applyWhenOf(doc);
    out.ci.workflow = WORKFLOW_OF[when];
    if (when === "pull-request") {
      const a = doc.apply as Record<string, unknown>;
      out.pipeline.applyRequires = Array.isArray(a.requires) ? [...(a.requires as string[])] : [...APPLY_REQUIRES];
      const merge = applyMergeOf(doc);
      if (merge) out.pipeline.applyMerge = merge;
    }
  },
};
