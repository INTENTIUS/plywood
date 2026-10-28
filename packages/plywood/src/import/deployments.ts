/**
 * `plywood init --from deployments`: Pulumi Deployments settings the user
 * exported, read from the repository. No API call is made. The file is
 * `Pulumi.<stack>.deploy.yaml` beside the project's Pulumi.yaml (as
 * `pulumi deployment settings pull` writes it, under `settings:`), or the
 * same name with `.json` for the REST API's response body; `--from
 * deployments=<file>` names one.
 *
 *   sourceContext.git.repoDir        stacks.<key>.dir
 *   sourceContext.git.branch         branches.<branch>
 *   gitHub.paths                     stacks.<key>.paths
 *   gitHub.previewPullRequests       plywood previews every pull request
 *   gitHub.deployCommits             plywood updates on merge
 *   gitHub.pullRequestTemplate       review_stacks.template
 *   operationContext.oidc            listed with the identity it names, for
 *                                    identity.stacks.<key>.up: plywood needs a
 *                                    preview identity beside it
 *   executorContext.executorImage    image
 *
 * Pre-run commands, environment variables, options, cache and agent pool
 * settings are listed as not carried, each by name.
 */
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isObject, type RawConfig } from "../config/types";
import { posixRel, type Detected } from "../init/detect";
import { addBranch, branchOf, mergeKeys, projectAt, readDoc, repoJoin, stackEntry, unknownSettings, type Importer, type Unsupported } from "./types";

const SETTINGS_FILE = /^Pulumi\.([^.]+)\.deploy\.(?:ya?ml|json)$/;

/** The settings files: those named, else each `Pulumi.<stack>.deploy.*` in a project's directory. */
export function deploymentFiles(root: string, detected: Detected, named: readonly string[]): string[] {
  if (named.length) return [...named];
  const out: string[] = [];
  for (const p of detected.projects) {
    let names: string[];
    try {
      names = readdirSync(join(root, p.dir)).sort();
    } catch {
      continue;
    }
    for (const n of names) if (SETTINGS_FILE.test(n)) out.push(repoJoin(p.dir, n));
  }
  return out;
}

const NOT_CARRIED: Readonly<Record<string, string>> = {
  "operationContext.preRunCommands": "put each command in the stack's program or the job's image",
  "operationContext.environmentVariables": "set each one as a forge variable or secret",
  "operationContext.options": "plywood runs the stack's program as Pulumi does, through chant",
  cacheOptions: "the jobs install with the image's tools; cache with your forge's cache",
  agentPoolID: "set runners in plywood.yml for self-hosted runners",
  "sourceContext.git.gitAuth": "the jobs check out the repository with the forge's own token",
  "sourceContext.git.commit": "plywood previews each pull request's commit",
  "gitHub.deployPullRequest": "set apply.when: pull-request and update with /plywood up",
  "gitHub.repository": "plywood runs in the repository it is set up in",
};

export const importDeployments: Importer = (root, detected, named) => {
  let keys: RawConfig = {};
  const unsupported: Unsupported[] = [];
  const notes: string[] = [];
  const files: string[] = [];
  const not = (file: string, setting: string, why?: string): void => {
    unsupported.push({ file, setting, why: why ?? NOT_CARRIED[setting] ?? "plywood has no setting for it" });
  };
  for (const file of deploymentFiles(root, detected, named)) {
    const m = SETTINGS_FILE.exec(basename(file));
    if (!m) {
      not(file, "(file)", "names no stack: call it Pulumi.<stack>.deploy.yaml (or .json) beside the project's Pulumi.yaml");
      continue;
    }
    let doc: unknown;
    try {
      doc = readDoc(root, file);
    } catch (e) {
      not(file, "(file)", `does not read: ${(e as Error).message}`);
      continue;
    }
    const settings = isObject(doc) && isObject(doc.settings) ? doc.settings : isObject(doc) ? doc : undefined;
    if (!settings) continue;
    files.push(file);
    const fileDir = repoJoin(posixRel(root, dirname(join(root, file))));
    const source = isObject(settings.sourceContext) && isObject(settings.sourceContext.git) ? settings.sourceContext.git : {};
    const dir = typeof source.repoDir === "string" ? repoJoin(source.repoDir) : fileDir;
    const project = projectAt(detected, dir)?.name ?? projectAt(detected, fileDir)?.name;
    if (!project) {
      not(file, "sourceContext.git.repoDir", `${dir} holds no Pulumi.yaml`);
      continue;
    }
    const key = `${project}/${m[1]}`;
    const entry = stackEntry(keys, key);
    if (dir !== ".") entry.dir = dir;
    if (typeof source.branch === "string") addBranch(keys, branchOf(source.branch), key);
    for (const k of Object.keys(source).filter((x) => !["repoDir", "branch", "repoURL", "repoUrl"].includes(x))) not(file, `sourceContext.git.${k}`);

    const gh = isObject(settings.gitHub) ? settings.gitHub : {};
    const included = Array.isArray(gh.paths) ? gh.paths.map(String).filter((p) => !p.startsWith("!")) : [];
    if (included.length) entry.paths = included;
    if (Array.isArray(gh.paths) && gh.paths.some((p) => String(p).startsWith("!"))) not(file, "gitHub.paths", "an exclusion (!path) has no plywood form; list only the paths that preview the stack");
    if (gh.previewPullRequests === false) not(file, "gitHub.previewPullRequests", "plywood previews every pull request that touches the stack; leave the stack out of plywood.yml to skip it");
    if (gh.deployCommits === false) not(file, "gitHub.deployCommits", "plywood updates the stack on merge; set gate: always to hold each update for an approval");
    if (gh.pullRequestTemplate === true) keys = mergeKeys(keys, { review_stacks: { template: key } });
    for (const k of Object.keys(gh).filter((x) => !["paths", "previewPullRequests", "deployCommits", "pullRequestTemplate"].includes(x))) not(file, `gitHub.${k}`);

    const op = isObject(settings.operationContext) ? settings.operationContext : {};
    if (Array.isArray(op.preRunCommands) && op.preRunCommands.length) not(file, "operationContext.preRunCommands");
    if (isObject(op.environmentVariables) && Object.keys(op.environmentVariables).length) {
      not(file, "operationContext.environmentVariables", `${NOT_CARRIED["operationContext.environmentVariables"]}: ${Object.keys(op.environmentVariables).sort().join(", ")}`);
    }
    if (isObject(op.options) && Object.keys(op.options).length) for (const k of Object.keys(op.options)) not(file, `operationContext.options.${k}`, NOT_CARRIED["operationContext.options"]);
    if (isObject(op.oidc)) {
      // Deployments runs with one identity; plywood needs a preview identity beside it, so the key is left for a person to finish.
      const ids: Array<[string, string, unknown]> = [
        ["aws", "roleArn", isObject(op.oidc.aws) ? op.oidc.aws.roleArn : undefined],
        ["gcp", "serviceAccount", isObject(op.oidc.gcp) ? op.oidc.gcp.serviceAccount : undefined],
        ["azure", "clientId", isObject(op.oidc.azure) ? op.oidc.azure.clientId : undefined],
      ];
      for (const [cloud, field, id] of ids) {
        if (!isObject(op.oidc[cloud])) continue;
        not(
          file,
          `operationContext.oidc.${cloud}`,
          typeof id === "string"
            ? `Deployments runs both stages as ${id}; set identity.stacks.${key}.up.${cloud}: ${id} beside a preview identity of its own, and identity.${cloud}'s settings`
            : `has no ${field}; set identity.stacks.${key} by hand`,
        );
      }
      for (const cloud of Object.keys(op.oidc).filter((c) => !["aws", "gcp", "azure"].includes(c))) not(file, `operationContext.oidc.${cloud}`);
    }
    for (const k of Object.keys(op).filter((x) => !["preRunCommands", "environmentVariables", "options", "oidc"].includes(x))) not(file, `operationContext.${k}`);

    const exec = isObject(settings.executorContext) ? settings.executorContext : {};
    if (typeof exec.executorImage === "string") keys.image = exec.executorImage;
    else if (isObject(exec.executorImage) && typeof exec.executorImage.reference === "string") keys.image = exec.executorImage.reference;
    unsupported.push(...unknownSettings(settings, ["sourceContext", "gitHub", "operationContext", "executorContext", "cacheOptions", "agentPoolID", "version", "source"], file, "", "plywood has no setting for it"));
    if (isObject(settings.cacheOptions) && settings.cacheOptions.enable === true) not(file, "cacheOptions");
    if (typeof settings.agentPoolID === "string" && settings.agentPoolID) not(file, "agentPoolID");
  }
  if (files.length) notes.push("turn off each stack's Deployments triggers once plywood runs it, so a push starts one update");
  return { source: "deployments", files, keys, unsupported, notes };
};
