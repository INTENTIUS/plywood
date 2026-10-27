/**
 * What `plywood init` reads from the repository before it writes anything:
 * each Pulumi project (a `Pulumi.yaml`), its stacks (the
 * `Pulumi.<stack>.yaml` files beside it, or under its `stackConfigDir`),
 * each stack's backend, the forge the `origin` remote names, the default
 * branch, and the files a team already has that plywood should know about
 * (a pulumi/actions workflow, a pre-commit config).
 *
 * Everything here reads files. Nothing runs pulumi, plunge or git: the
 * remote and the branch come from `.git/config` and `.git/refs`, as git
 * itself writes them.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import type { ForgeKind } from "../chant-product";

/** One Pulumi project: the directory holding its `Pulumi.yaml`. */
export interface DetectedProject {
  /** `name` in Pulumi.yaml. */
  name: string;
  /** The directory, relative to the repository root, `"."` for the root. */
  dir: string;
  /** `runtime` in Pulumi.yaml, as written (a string, or `{ name }`). */
  runtime?: string;
  /** `backend.url` in Pulumi.yaml. */
  backendUrl?: string;
  /** The stack names, from the `Pulumi.<stack>.yaml` files. */
  stacks: string[];
}

/** One stack, keyed as plywood.yml keys it: `project/stack`. */
export interface DetectedStack {
  key: string;
  project: string;
  stack: string;
  dir: string;
}

/** Where a backend URL came from, first that answers. */
export type BackendSource = "plywood.yml" | "PULUMI_BACKEND_URL" | "Pulumi.yaml" | "none";

export interface DetectedForge {
  kind: ForgeKind;
  /** How the kind was found. */
  because: string;
  /** A self-hosted forge's base URL (GitLab or Forgejo not on their public hosts). */
  url?: string;
}

export interface Detected {
  root: string;
  projects: DetectedProject[];
  stacks: DetectedStack[];
  forge?: DetectedForge;
  defaultBranch: string;
  /** Workflow files that run pulumi/actions, relative to the root. */
  pulumiActions: string[];
  /** `.pre-commit-config.yaml` (or `.yml`) at the root. */
  preCommit?: string;
}

/** Directories the search never enters. */
const SKIP = new Set(["node_modules", ".git", "dist", "build", "vendor", "venv", ".venv", "__pycache__", "target", "bin", "obj"]);
const MAX_DEPTH = 8;

/** The repository root: the nearest directory at or above `dir` holding `.git`, else `dir`. */
export function repoRoot(dir: string): string {
  let cur = dir;
  for (let i = 0; i < 64; i++) {
    if (existsSync(join(cur, ".git"))) return cur;
    const parent = dirname(cur);
    if (parent === cur) return dir;
    cur = parent;
  }
  return dir;
}

/** Path with forward slashes, `"."` for the root itself. */
export function posixRel(root: string, path: string): string {
  const rel = relative(root, path);
  return rel === "" ? "." : rel.split(sep).join("/");
}

function readYamlFile(file: string): Record<string, unknown> | undefined {
  try {
    const doc: unknown = parseYAML(readFileSync(file, "utf8"));
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Every `Pulumi.yaml` (or `Pulumi.yml`) under `root`, skipping dependency and build directories. */
export function findPulumiProjects(root: string): DetectedProject[] {
  const out: DetectedProject[] = [];
  const walk = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    const file = ["Pulumi.yaml", "Pulumi.yml"].find((n) => entries.includes(n));
    if (file) {
      const project = readProject(root, dir, join(dir, file));
      if (project) out.push(project);
    }
    if (depth >= MAX_DEPTH) return;
    for (const name of entries) {
      if (SKIP.has(name) || name.startsWith(".")) continue;
      const path = join(dir, name);
      try {
        if (statSync(path).isDirectory()) walk(path, depth + 1);
      } catch {
        // unreadable: skipped
      }
    }
  };
  walk(root, 0);
  return out;
}

function readProject(root: string, dir: string, file: string): DetectedProject | undefined {
  const doc = readYamlFile(file);
  if (!doc || typeof doc.name !== "string" || doc.name === "") return undefined;
  const runtime = typeof doc.runtime === "string" ? doc.runtime : (doc.runtime as { name?: unknown } | undefined)?.name;
  const backend = doc.backend as { url?: unknown } | undefined;
  const configDir = typeof doc.stackConfigDir === "string" ? join(dir, doc.stackConfigDir) : dir;
  return {
    name: doc.name,
    dir: posixRel(root, dir),
    ...(typeof runtime === "string" ? { runtime } : {}),
    ...(backend && typeof backend.url === "string" ? { backendUrl: backend.url } : {}),
    stacks: stackNames(configDir),
  };
}

/** The stacks of a project: `Pulumi.<stack>.yaml` beside Pulumi.yaml (or in its stackConfigDir). */
export function stackNames(configDir: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(configDir);
  } catch {
    return [];
  }
  const names = entries
    .map((n) => /^Pulumi\.(.+)\.ya?ml$/.exec(n)?.[1])
    .filter((s): s is string => s !== undefined && s !== "");
  return [...new Set(names)].sort(byEnvironment);
}

/** Environments in the order a change usually goes through them; others sort between staging and prod. */
const ENV_ORDER = ["local", "dev", "development", "sandbox", "test", "testing", "qa", "ci", "stage", "staging", "preprod", "uat", "prod", "production"];
const PROD_RANK = ENV_ORDER.indexOf("prod");

/** The environment a stack name is for: its last segment before a region suffix, such as `prod` of `prod-east`. */
export function environmentOf(stack: string): string {
  const last = stack.split("/").pop()!.toLowerCase();
  const head = last.split(/[-_.]/)[0]!;
  return ENV_ORDER.includes(head) ? head : last;
}

function rank(stack: string): number {
  const env = environmentOf(stack);
  const at = ENV_ORDER.indexOf(env);
  return at >= 0 ? at : PROD_RANK - 0.5;
}

/** Orders stack names dev before staging before prod, then by name. */
export function byEnvironment(a: string, b: string): number {
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Every stack of every project, keyed `project/stack`. Two projects of one name get the directory in the key's project part. */
export function stacksOf(projects: readonly DetectedProject[]): DetectedStack[] {
  const names = new Map<string, number>();
  for (const p of projects) names.set(p.name, (names.get(p.name) ?? 0) + 1);
  const out: DetectedStack[] = [];
  for (const p of projects) {
    const project = (names.get(p.name) ?? 0) > 1 ? `${p.name}-${slug(p.dir)}` : p.name;
    for (const stack of p.stacks) out.push({ key: `${project}/${stack}`, project: p.name, stack, dir: p.dir });
  }
  return out.sort((x, y) => byEnvironment(x.stack, y.stack) || x.key.localeCompare(y.key));
}

/** Lowercase letters, digits and `-`, as chant's names take them. */
export function slug(s: string): string {
  const out = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out === "" ? "root" : out;
}

/** The `[remote "origin"]` url in `.git/config`, or undefined. */
export function originUrl(root: string): string | undefined {
  const config = gitFile(root, "config");
  if (!config) return undefined;
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const m = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (m) return m[1]!.trim();
  }
  return undefined;
}

/** A file under the git directory, which is `.git` itself or the directory a `.git` file names (a worktree). */
function gitFile(root: string, name: string): string | undefined {
  const dotGit = join(root, ".git");
  let gitDir = dotGit;
  try {
    if (statSync(dotGit).isFile()) {
      const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"));
      if (!m) return undefined;
      gitDir = join(root, m[1]!.trim());
      // A worktree keeps config and refs/remotes in the common directory.
      const common = join(gitDir, "commondir");
      if (existsSync(common) && !existsSync(join(gitDir, name))) gitDir = join(gitDir, readFileSync(common, "utf8").trim());
    }
    const path = join(gitDir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  } catch {
    return undefined;
  }
}

/** The host of a remote URL: `https://host/...`, `ssh://git@host:22/...` or `git@host:owner/repo`. */
export function remoteHost(url: string): string | undefined {
  const scp = /^[^@/\s]+@([^:/\s]+):/.exec(url);
  if (scp) return scp[1]!.toLowerCase();
  try {
    return new URL(url).hostname.toLowerCase() || undefined;
  } catch {
    return undefined;
  }
}

/** The forge a remote URL names, from its host. */
export function forgeOfRemote(url: string): DetectedForge | undefined {
  const host = remoteHost(url);
  if (!host) return undefined;
  if (host === "github.com" || host.endsWith(".github.com") || host.startsWith("github.")) return { kind: "github", because: `origin is on ${host}` };
  if (host === "gitlab.com") return { kind: "gitlab", because: `origin is on ${host}` };
  if (host === "codeberg.org") return { kind: "forgejo", because: `origin is on ${host}` };
  if (/(^|[.-])gitlab([.-]|$)/.test(host)) return { kind: "gitlab", because: `origin is on ${host}`, url: `https://${host}` };
  if (/(^|[.-])(forgejo|gitea)([.-]|$)/.test(host)) return { kind: "forgejo", because: `origin is on ${host}`, url: `https://${host}` };
  return undefined;
}

/** The forge: from the origin remote's host, else from the CI files the repository has. */
export function detectForge(root: string): DetectedForge | undefined {
  const url = originUrl(root);
  const byRemote = url ? forgeOfRemote(url) : undefined;
  if (byRemote) return byRemote;
  if (existsSync(join(root, ".forgejo"))) return { kind: "forgejo", because: "the repository has .forgejo/" };
  if (existsSync(join(root, ".gitlab-ci.yml"))) return { kind: "gitlab", because: "the repository has .gitlab-ci.yml" };
  if (existsSync(join(root, ".github", "workflows"))) return { kind: "github", because: "the repository has .github/workflows/" };
  return undefined;
}

/** The branch `origin/HEAD` points at, else the checked-out branch, else `main`. */
export function defaultBranch(root: string): string {
  const head = gitFile(root, "refs/remotes/origin/HEAD");
  const remote = head && /ref:\s*refs\/remotes\/origin\/(.+)/.exec(head)?.[1];
  if (remote) return remote.trim();
  const local = gitFile(root, "HEAD");
  const branch = local && /ref:\s*refs\/heads\/(.+)/.exec(local)?.[1];
  return branch ? branch.trim() : "main";
}

/** The workflow directories a forge reads. */
const WORKFLOW_DIRS = [".github/workflows", ".forgejo/workflows", ".gitea/workflows"];

/** Workflow files that use pulumi/actions, relative to the root. */
export function findPulumiActions(root: string): string[] {
  const out: string[] = [];
  for (const d of WORKFLOW_DIRS) {
    let names: string[];
    try {
      names = readdirSync(join(root, d)).sort();
    } catch {
      continue;
    }
    for (const n of names) {
      if (!/\.ya?ml$/.test(n)) continue;
      try {
        if (/uses:\s*["']?pulumi\/actions@/.test(readFileSync(join(root, d, n), "utf8"))) out.push(`${d}/${n}`);
      } catch {
        // unreadable: skipped
      }
    }
  }
  return out;
}

/** Everything init reads, from `cwd`'s repository. */
export function detect(cwd: string): Detected {
  const root = repoRoot(cwd);
  const projects = findPulumiProjects(root);
  const forge = detectForge(root);
  const preCommit = [".pre-commit-config.yaml", ".pre-commit-config.yml"].find((n) => existsSync(join(root, n)));
  return {
    root,
    projects,
    stacks: stacksOf(projects),
    ...(forge ? { forge } : {}),
    defaultBranch: defaultBranch(root),
    pulumiActions: findPulumiActions(root),
    ...(preCommit ? { preCommit } : {}),
  };
}

/** The repository's name, for the workspace declaration: the root directory's name. */
export function repoName(root: string): string {
  return slug(basename(root)).slice(0, 40).replace(/-+$/, "") || "plywood";
}
