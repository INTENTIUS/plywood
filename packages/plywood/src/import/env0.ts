/**
 * `plywood init --from env0`: env0's files in the repository.
 *
 *   env0.workflow.yml   a workflow's environments and their `needs`: each
 *                       environment whose name, or `templateName`, matches a
 *                       stack (its `project/stack`, stack or project name)
 *                       is that stack, and `needs` becomes waves.after
 *   env0.yml            custom flow hooks (`deploy.steps.<step>.before` and
 *                       `after`, the same under `destroy`): listed as not
 *                       carried, each by step
 *
 * Templates, environment variables and approval policies live in env0
 * itself, so they are not here to read.
 */
import { isObject, type RawConfig } from "../config/types";
import type { Detected } from "../init/detect";
import { firstPresent, readDoc, type Importer, type Unsupported } from "./types";

export const ENV0_WORKFLOW_FILES = ["env0.workflow.yml", "env0.workflow.yaml"];
export const ENV0_FLOW_FILES = ["env0.yml", "env0.yaml"];

/** The stack an env0 environment names, if exactly one matches. */
function stackFor(detected: Detected, names: readonly string[]): string | undefined {
  for (const n of names) {
    const hits = detected.stacks.filter((s) => s.key === n || s.stack === n || (detected.stacks.filter((x) => x.project === s.project).length === 1 && s.project === n));
    if (hits.length === 1) return hits[0]!.key;
  }
  return undefined;
}

export const importEnv0: Importer = (root, detected, named) => {
  const keys: RawConfig = {};
  const unsupported: Unsupported[] = [];
  const notes: string[] = [];
  const files: string[] = [];
  const pick = (choices: readonly string[]): string | undefined => named.find((f) => choices.some((c) => f.endsWith(c))) ?? (named.length ? undefined : firstPresent(root, choices));
  for (const f of named.filter((x) => ![...ENV0_WORKFLOW_FILES, ...ENV0_FLOW_FILES].some((c) => x.endsWith(c)))) {
    unsupported.push({ file: f, setting: "(file)", why: `is neither ${ENV0_WORKFLOW_FILES[0]} nor ${ENV0_FLOW_FILES[0]}` });
  }

  const workflow = pick(ENV0_WORKFLOW_FILES);
  if (workflow) {
    files.push(workflow);
    const doc = readDoc(root, workflow);
    const envs = isObject(doc) && isObject(doc.environments) ? doc.environments : {};
    const stackOf = new Map<string, string>();
    for (const [id, raw] of Object.entries(envs)) {
      const e = isObject(raw) ? raw : {};
      const names = [id, ...(typeof e.name === "string" ? [e.name] : []), ...(typeof e.templateName === "string" ? [e.templateName] : [])];
      const key = stackFor(detected, names);
      if (key) stackOf.set(id, key);
      else unsupported.push({ file: workflow, setting: `environments.${id}`, why: `names no stack of this repository (${names.join(", ")}); list it under stacks and waves.after by hand` });
      for (const k of Object.keys(e).filter((x) => !["name", "templateName", "needs"].includes(x))) {
        unsupported.push({ file: workflow, setting: `environments.${id}.${k}`, why: "plywood has no setting for it" });
      }
    }
    const after: Record<string, string[]> = {};
    for (const [id, raw] of Object.entries(envs)) {
      const reader = stackOf.get(id);
      const needs = isObject(raw) && Array.isArray(raw.needs) ? raw.needs.map(String) : [];
      if (!reader) continue;
      for (const n of needs) {
        const up = stackOf.get(n);
        if (up) (after[reader] ??= []).push(up);
        else unsupported.push({ file: workflow, setting: `environments.${id}.needs`, why: `${n} names no stack of this repository` });
      }
    }
    if (Object.keys(after).length) keys.waves = { after };
    for (const k of Object.keys(isObject(doc) ? doc : {}).filter((x) => x !== "environments")) {
      unsupported.push({ file: workflow, setting: k, why: "plywood has no setting for it" });
    }
  }

  const flow = pick(ENV0_FLOW_FILES);
  if (flow) {
    files.push(flow);
    const doc = readDoc(root, flow);
    for (const phase of ["deploy", "destroy"]) {
      const steps = isObject(doc) && isObject(doc[phase]) && isObject((doc[phase] as Record<string, unknown>).steps) ? ((doc[phase] as Record<string, unknown>).steps as Record<string, unknown>) : {};
      for (const [step, hooks] of Object.entries(steps)) {
        for (const when of Object.keys(isObject(hooks) ? hooks : {})) {
          unsupported.push({ file: flow, setting: `${phase}.steps.${step}.${when}`, why: "plywood runs no hook around chant's stages; put the commands in the job's image or the stack's program" });
        }
      }
    }
    for (const k of Object.keys(isObject(doc) ? doc : {}).filter((x) => !["version", "deploy", "destroy"].includes(x))) {
      unsupported.push({ file: flow, setting: k, why: "plywood has no setting for it" });
    }
  }
  if (!files.length) notes.push(`no ${ENV0_WORKFLOW_FILES[0]} or ${ENV0_FLOW_FILES[0]} in the repository`);
  else notes.push("templates, variables and approval policies are env0 settings outside the repository; set stacks, gate and approval_rules in plywood.yml");
  return { source: "env0", files, keys, unsupported, notes };
};
