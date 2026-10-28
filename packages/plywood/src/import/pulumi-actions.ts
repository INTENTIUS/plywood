/**
 * `plywood init --from pulumi-actions`: GitHub Actions workflows that use
 * `pulumi/actions`. Each step's inputs, as the action names them:
 *
 *   stack-name      the stack, `org/stack` or `stack`; the project comes from
 *                   the Pulumi.yaml in work-dir, the org goes to pulumi_cloud.org
 *   work-dir        stacks.<key>.dir
 *   command         preview: the pull request's preview, as plywood does;
 *                   up on a push: branches.<branch>; up on a pull request:
 *                   apply.when pull-request
 *   comment-on-pr   plywood posts one note per pull request already
 *   policyPacks     policy.packs, relative to the repository root, with
 *                   policyPackConfigs paired in order
 *   cloud-url       stacks.<key>.backend, unless it is Pulumi Cloud's own
 *   pulumi-version  pulumi, when it is one release
 *
 * `refresh`, `target` and every other input are listed as not carried.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { isObject, type RawConfig } from "../config/types";
import type { Detected } from "../init/detect";
import { addBranch, mergeKeys, projectAt, readDoc, repoJoin, stackEntry, type Importer, type Unsupported } from "./types";

export const WORKFLOW_DIRS = [".github/workflows", ".forgejo/workflows", ".gitea/workflows"];
const CARRIED = ["stack-name", "work-dir", "command", "comment-on-pr", "policyPacks", "policyPackConfigs", "cloud-url", "pulumi-version", "github-token", "edit-pr-comment", "always-include-summary"];
const WHY: Readonly<Record<string, string>> = {
  refresh: "plywood previews against the stack's state as it is; run plywood drift on a schedule to catch changes made outside it",
  target: "plywood previews and updates whole stacks; narrow a pull request with labels",
  "target-dependents": "plywood previews and updates whole stacks",
  "config-map": "keep the config in Pulumi.<stack>.yaml, which plywood reads at the pull request's commit",
  upsert: "plywood updates stacks that exist; create a stack with pulumi stack init before plywood init",
  "expect-no-changes": "a drift check (drift.schedule) reports changes rather than failing a job",
  "secrets-provider": "set secretsprovider in Pulumi.<stack>.yaml",
  diff: "the note shows each change already",
  plan: "plywood's update applies the preview its approval names, through chant",
};

/** The pulumi/actions workflow files: those `--from` named, else every one in the forge workflow directories. */
export function pulumiActionsFiles(root: string, named: readonly string[]): string[] {
  if (named.length) return [...named];
  const out: string[] = [];
  for (const d of WORKFLOW_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(root, d)).sort();
    } catch {
      continue;
    }
    for (const n of names) if (/\.ya?ml$/.test(n)) out.push(`${d}/${n}`);
  }
  return out;
}

/** The workflow's triggers: `on` as written, or as a YAML 1.1 reader keys it. */
function triggers(doc: Record<string, unknown>): { pullRequest: boolean; pushBranches: string[] } {
  const on = doc.on ?? doc["true"];
  const names = typeof on === "string" ? [on] : Array.isArray(on) ? on.map(String) : isObject(on) ? Object.keys(on) : [];
  const push = isObject(on) && isObject(on.push) ? on.push : undefined;
  const branches = push && Array.isArray(push.branches) ? push.branches.map(String) : names.includes("push") ? ["main"] : [];
  return { pullRequest: names.includes("pull_request") || names.includes("pull_request_target"), pushBranches: branches };
}

/** A multi-line action input as its lines. */
function lines(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String).filter(Boolean);
  return typeof v === "string" ? v.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
}

const PULUMI_CLOUD = /^https:\/\/(?:app|api)\.pulumi\.com\/?$/;

export const importPulumiActions: Importer = (root, detected: Detected, named) => {
  let keys: RawConfig = {};
  const unsupported: Unsupported[] = [];
  const notes: string[] = [];
  const files: string[] = [];
  const secrets = new Set<string>();
  for (const file of pulumiActionsFiles(root, named)) {
    let doc: unknown;
    try {
      doc = readDoc(root, file);
    } catch (e) {
      unsupported.push({ file, setting: "(file)", why: `does not read as YAML: ${(e as Error).message}` });
      continue;
    }
    if (!isObject(doc) || !isObject(doc.jobs)) continue;
    const on = triggers(doc);
    let used = false;
    for (const [jobName, job] of Object.entries(doc.jobs)) {
      if (!isObject(job) || !Array.isArray(job.steps)) continue;
      // A job's `if` on the event narrows the workflow's triggers to its own.
      const cond = typeof job.if === "string" ? job.if : "";
      const jobOn = /event_name\s*==\s*'push'|"push"/.test(cond)
        ? { pullRequest: false, pushBranches: on.pushBranches }
        : /event_name\s*==\s*'pull_request/.test(cond)
          ? { pullRequest: on.pullRequest, pushBranches: [] }
          : on;
      job.steps.forEach((step, i) => {
        if (!isObject(step) || typeof step.uses !== "string" || !/^pulumi\/actions@/.test(step.uses)) return;
        used = true;
        const where = `jobs.${jobName}.steps[${i}]`;
        const w = isObject(step.with) ? step.with : {};
        for (const m of JSON.stringify(step.env ?? {}).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) secrets.add(m[1]!);
        for (const m of JSON.stringify(job.env ?? {}).matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) secrets.add(m[1]!);
        const stackName = typeof w["stack-name"] === "string" ? w["stack-name"] : undefined;
        if (!stackName) {
          unsupported.push({ file, setting: `${where}.with.stack-name`, why: "is missing or an expression; list the stack under stacks in plywood.yml" });
          return;
        }
        const dir = repoJoin(typeof w["work-dir"] === "string" ? w["work-dir"] : ".");
        const parts = stackName.split("/");
        const stack = parts[parts.length - 1]!;
        const project = projectAt(detected, dir)?.name ?? (parts.length === 3 ? parts[1]! : undefined);
        if (!project) {
          unsupported.push({ file, setting: `${where}.with.stack-name`, why: `${dir} holds no Pulumi.yaml, so ${stackName} names no project` });
          return;
        }
        const key = `${project}/${stack}`;
        const entry = stackEntry(keys, key);
        if (dir !== ".") entry.dir = dir;
        // pulumi/actions reads org/stack and org/project/stack.
        if (parts.length === 2 || parts.length === 3) keys = mergeKeys(keys, { pulumi_cloud: { org: parts[0] } });

        const command = typeof w.command === "string" ? w.command : "";
        if (command === "up" || command === "update") {
          if (jobOn.pullRequest) keys = mergeKeys(keys, { apply: { when: "pull-request" } });
          for (const b of jobOn.pushBranches) addBranch(keys, b, key);
          if (!jobOn.pullRequest && jobOn.pushBranches.length === 0) unsupported.push({ file, setting: `${where}.with.command`, why: "up runs on a trigger other than a push or a pull request; plywood updates on merge" });
        } else if (command !== "preview") {
          unsupported.push({ file, setting: `${where}.with.command`, why: `${command || "(none)"} is not preview or up; plywood runs those two, and plywood drift for refresh` });
        }

        const packs = lines(w.policyPacks);
        const configs = lines(w.policyPackConfigs);
        if (packs.length) {
          const listed = packs.map((p, n) => (configs[n] ? { dir: repoJoin(dir, p), config: repoJoin(dir, configs[n]!) } : repoJoin(dir, p)));
          const have = (isObject(keys.policy) && Array.isArray(keys.policy.packs) ? keys.policy.packs : []) as unknown[];
          keys = mergeKeys(keys, { policy: { packs: [...have, ...listed.filter((p) => !have.some((h) => JSON.stringify(h) === JSON.stringify(p)))] } });
        }
        const cloud = typeof w["cloud-url"] === "string" ? w["cloud-url"] : undefined;
        if (cloud && !PULUMI_CLOUD.test(cloud)) {
          if (/^https:\/\//.test(cloud)) keys = mergeKeys(keys, { pulumi_cloud: { api_url: cloud } });
          else entry.backend = cloud;
        }
        const version = typeof w["pulumi-version"] === "string" ? w["pulumi-version"].replace(/^v/, "") : undefined;
        if (version) {
          if (/^\d+\.\d+\.\d+$/.test(version)) keys.pulumi = version;
          else unsupported.push({ file, setting: `${where}.with.pulumi-version`, why: `${version} is a range; plywood pins one release, so set pulumi: <x.y.z>` });
        }
        for (const input of Object.keys(w).filter((k) => !CARRIED.includes(k))) {
          unsupported.push({ file, setting: `${where}.with.${input}`, why: WHY[input] ?? "plywood has no setting for it" });
        }
      });
    }
    if (used) files.push(file);
  }
  if (files.length && secrets.size) notes.push(`the workflow reads the secrets ${[...secrets].sort().join(", ")}; plywood's jobs read them under the same names`);
  if (files.length) notes.push("comment-on-pr carries over: plywood posts one note per pull request");
  return { source: "pulumi-actions", files, keys, unsupported, notes };
};
