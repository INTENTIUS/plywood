/**
 * `plywood config identities [--file <plywood.yml>] [--env <env>]` and
 * `plywood forge check`.
 *
 * `config identities` reads plywood.yml as chant will: the `ci.identity`
 * block it renders (src/config/identity.ts), and for each stack plywood.yml
 * lists, the preview and up identity each cloud gives it, first match wins,
 * with chant's own target glob (`targetGlobMatch`, @intentius/chant/ci-identity).
 * It reads nothing from a forge or a cloud.
 *
 * `forge check` holds the identities next to the forge's environments,
 * protected branches, required statuses and each cloud's trust policy,
 * Pulumi Cloud's OIDC issuer among them. The read is chant's
 * (`@intentius/chant/forge-check`, chant#4608), shared with terragucci:
 * plywood renders `ci.identity` from plywood.yml, chant's
 * `resolveCloudIdentity` gives each workspace member's trades, and
 * `pipelineContract` turns them into the jobs plywood's pipeline runs, named
 * in plywood's words (`plywood/preview/<member>` is the required status).
 * Every request is a read. plywood keeps no copy of the check.
 *
 * The subpath is imported on first use. A chant without it (the 0.124.54
 * pin) gets the message the command printed before chant#4608 and chant's
 * `failed` code.
 */
import type { JobSettings } from "./config/jobs";
import { environmentFor } from "./jobs";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { targetGlobMatch } from "@intentius/chant/ci-identity";
import { toChantSettings } from "./chant-config";
import { chantIdentityOf, IDENTITY_CLOUDS, pulumiCloudOf, stackIdentities, type IdentityCloud } from "./config/identity";
import { checkConfig, ConfigError, findConfig, loadConfig, type PlywoodConfig } from "./config/index";
import { stacksOf } from "./config/stacks";
import type { ExitTable } from "./exit-codes";
import { takeFlag, usage, type StageIo } from "./stages";
import { CLOUD_NAMES, NO_IDENTITY, PRODUCT, PRODUCT_WORDS } from "./words";
import type { ChantRunner } from "./chant-config";

export interface StackIdentityRow {
  stack: string;
  cloud: IdentityCloud;
  preview: string;
  up: string;
  rule: string;
}

/** Each listed stack's identities for `env`, one row per cloud that names one. */
export function identityRows(config: PlywoodConfig, env: string): StackIdentityRow[] {
  const doc = config.doc;
  const out: StackIdentityRow[] = [];
  for (const stack of Object.keys(stacksOf(doc))) {
    const ids = stackIdentities(doc, stack, env, targetGlobMatch);
    for (const cloud of IDENTITY_CLOUDS) {
      const id = ids[cloud];
      if (id) out.push({ stack, cloud, preview: id.preview, up: id.up, rule: id.rule });
    }
  }
  return out;
}

/** The text lines for `rows`. */
export function identityLines(config: PlywoodConfig, env: string, rows: readonly StackIdentityRow[]): string[] {
  const doc = config.doc;
  const block = chantIdentityOf(doc);
  if (!block) return [`${config.file ?? "plywood.yml"}: no identity; every job runs as ${NO_IDENTITY}`];
  const lines = [`${config.file ?? "plywood.yml"}: identities in environment ${env}`];
  const clouds = Object.keys(block.cloud) as IdentityCloud[];
  lines.push(`  clouds  ${clouds.map((c) => CLOUD_NAMES[c]).join(", ")}`);
  if (clouds.includes("pulumi")) {
    const p = pulumiCloudOf(doc);
    lines.push(`  Pulumi Cloud  ${p.org}${p.apiUrl ? ` at ${p.apiUrl}` : ""}; ESC environments open with each job's own token`);
  }
  const stacks = Object.keys(stacksOf(doc));
  if (stacks.length === 0) lines.push("  plywood.yml lists no stacks; the rules apply to each stack plywood init finds");
  for (const stack of stacks) {
    lines.push(`  ${stack}`);
    for (const cloud of clouds) {
      const r = rows.find((x) => x.stack === stack && x.cloud === cloud);
      lines.push(r ? `    ${CLOUD_NAMES[cloud].padEnd(12)} preview ${r.preview}, up ${r.up} (${r.rule})` : `    ${CLOUD_NAMES[cloud].padEnd(12)} ${NO_IDENTITY}`);
    }
  }
  lines.push("  The preview job trades its OIDC token before checkout, and no later step holds a forge token.");
  return lines;
}

/** `plywood config identities [--file <path>] [--env <env>]`. */
export function configIdentities(args: string[], json: boolean, table: ExitTable, io: StageIo): number {
  const file = takeFlag(args, "--file");
  const env = takeFlag(file.rest, "--env");
  if (file.missing || env.missing) return usage(`${file.missing ? "--file" : "--env"} takes a value`, table, io);
  if (env.rest.length) return usage(`config identities does not take ${env.rest.join(" ")}`, table, io);
  const path = file.value ?? findConfig(io.cwd);
  if (!path) return usage(`no plywood.yml in ${io.cwd} or above it; run '${PRODUCT} init', or pass --file`, table, io);
  let config: PlywoodConfig;
  try {
    config = loadConfig(path);
  } catch (e) {
    return usage(e instanceof ConfigError ? e.message : `${path}: ${(e as Error).message}`, table, io);
  }
  const errors = checkConfig(config).filter((p) => p.severity === "error");
  if (errors.length) {
    for (const p of errors) io.err(`${path}: ${p.key} ${p.message}`);
    if (json) io.out(JSON.stringify({ command: "config identities", ok: false, exitCode: table.failed, file: path, problems: errors }));
    return table.failed;
  }
  const environment = env.value ?? "production";
  const rows = identityRows(config, environment);
  if (json) io.out(JSON.stringify({ command: "config identities", ok: true, exitCode: table.done, file: path, env: environment, identity: toChantSettings(config).ci.identity ?? null, stacks: rows }));
  else for (const line of identityLines(config, environment, rows)) io.out(line);
  return table.done;
}

/** The message `plywood forge check` prints when the installed chant has no forge check. */
export const FORGE_CHECK_MESSAGE =
  `${PRODUCT} forge check holds the identities next to the forge's environments, protected branches and each cloud's trust policy. ` +
  `The read is chant's (@intentius/chant/forge-check, chant#4608), and the installed chant lacks it; it comes with the chant release after 0.124.54. Run '${PRODUCT} config identities' for what the jobs will hold.`;

/** The forge plywood's jobs run on. */
type Forge = "github" | "gitlab" | "forgejo";
const FORGES: readonly Forge[] = ["github", "gitlab", "forgejo"];

/** The part of chant's `ForgeTarget` plywood reads. */
export interface ChantForgeTarget {
  kind: Forge;
  host: string;
  repo: string;
}

/** What the forge read adds to the contract (chant `LiveRepository`). */
export interface ChantLiveRepository {
  defaultBranch?: string;
  path?: string;
  ownerId?: string;
  repoId?: string;
}

/** The part of chant's `ForgeCheckResult` plywood reads. */
export interface ChantForgeCheckResult {
  ok: boolean;
  rows: Array<{ status: string; where?: string }>;
}

/** One pipeline of chant's `pipelineContract` (`ContractPipeline`). */
export interface ChantContractPipeline {
  name: string;
  identity: unknown;
  member?: string;
  applyRunner?: { labels: string[]; group?: string };
  /** The forge environment the up jobs run in (plywood.yml `environments`, plywood#29). */
  forgeEnvironment?: string;
}

/** What plywood calls from `@intentius/chant/forge-check` and `resolveCloudIdentity` from ci-identity. */
export interface ChantForgeCheck {
  forgeCheck(
    input: { target: ChantForgeTarget; contract: (live: ChantLiveRepository) => unknown; words?: unknown; file?: string; requireClouds?: boolean },
    deps: { fetch: typeof fetch; env: NodeJS.ProcessEnv },
  ): Promise<ChantForgeCheckResult>;
  forgeCheckExit(r: ChantForgeCheckResult): number;
  describeForgeCheck(r: ChantForgeCheckResult): string;
  forgeCheckTarget(env: Record<string, string | undefined>, opts?: { kind?: Forge; repo?: string; tokenEnv?: string }): ChantForgeTarget;
  pipelineContract(input: {
    forge: Forge;
    repository: { host: string; path: string; defaultBranch: string; ownerId?: string; repoId?: string };
    pipelines: ChantContractPipeline[];
    words?: unknown;
  }): unknown;
  resolveCloudIdentity(decl: unknown, env: string, member?: string): unknown;
}

const FORGE_CHECK_FUNCTIONS = ["forgeCheck", "forgeCheckExit", "describeForgeCheck", "forgeCheckTarget", "pipelineContract"] as const;

let forgeCheckModule: Promise<ChantForgeCheck | undefined> | undefined;

/** chant's forge check, or undefined when the installed chant lacks it. */
export function chantForgeCheck(): Promise<ChantForgeCheck | undefined> {
  forgeCheckModule ??= (async () => {
    try {
      // @ts-ignore: the subpath is missing from chant 0.124.54 (chant#4608).
      const fc: Record<string, unknown> = await import("@intentius/chant/forge-check");
      const id: Record<string, unknown> = await import("@intentius/chant/ci-identity");
      if (!FORGE_CHECK_FUNCTIONS.every((f) => typeof fc[f] === "function") || typeof id.resolveCloudIdentity !== "function") return undefined;
      return { ...fc, resolveCloudIdentity: id.resolveCloudIdentity } as unknown as ChantForgeCheck;
    } catch {
      return undefined;
    }
  })();
  return forgeCheckModule;
}

/** Tests stand in a fake chant forge check (or none, for the fallback). `reset` goes back to the real import. */
export function setChantForgeCheckForTests(fake: ChantForgeCheck | undefined | "reset"): void {
  forgeCheckModule = fake === "reset" ? undefined : Promise.resolve(fake);
}

/** The workspace members `plywood init` wrote to chant.workspace.json beside plywood.yml, in order. */
export function workspaceMembers(root: string): string[] {
  const file = join(root, "chant.workspace.json");
  if (!existsSync(file)) return [];
  try {
    const doc = JSON.parse(readFileSync(file, "utf8")) as { members?: Array<{ name?: unknown }> };
    return (doc.members ?? []).map((m) => m.name).filter((n): n is string => typeof n === "string");
  } catch {
    return [];
  }
}

/** The up jobs' runner as chant's contract names it, from plywood.yml's `runner`. */
export function upRunner(runner: ChantRunner | undefined): { labels: string[]; group?: string } | undefined {
  if (runner === undefined) return undefined;
  const staged = typeof runner === "object" && !Array.isArray(runner) && !("group" in runner);
  const spec = staged ? ((runner as Record<string, unknown>).up ?? (runner as Record<string, unknown>).default) : runner;
  if (spec === undefined) return undefined;
  if (typeof spec === "string") return { labels: [spec] };
  if (Array.isArray(spec)) return { labels: spec.filter((l): l is string => typeof l === "string") };
  const g = spec as { group?: unknown; labels?: unknown };
  return typeof g.group === "string" ? { labels: Array.isArray(g.labels) ? (g.labels as string[]) : [], group: g.group } : undefined;
}

/** One pipeline per workspace member that some rule covers in `env`, as chant's generated pipelines name them. */
export function contractPipelines(
  fc: Pick<ChantForgeCheck, "resolveCloudIdentity">,
  cloud: unknown,
  env: string,
  members: readonly string[],
  runner?: ChantRunner,
  jobs?: Pick<JobSettings, "environments">,
): ChantContractPipeline[] {
  const applyRunner = upRunner(runner);
  const list: (string | undefined)[] = members.length ? [...members] : [undefined];
  return list.flatMap((member) => {
    const identity = fc.resolveCloudIdentity(cloud, env, member);
    const name = member ? `${member}/${env}` : env;
    // plywood#29: the up job's forge environment, from plywood.yml's environments, matched on <member>/<env>.
    const forgeEnvironment = jobs ? environmentFor(name, jobs)?.name : undefined;
    return identity ? [{ name, identity, ...(member ? { member } : {}), ...(applyRunner ? { applyRunner } : {}), ...(forgeEnvironment ? { forgeEnvironment } : {}) }] : [];
  });
}

/**
 * `plywood forge check [--file <path>] [--env <env>] [--forge <kind>]
 * [--repo <owner/name>] [--branch <default>] [--require-clouds]`: chant's
 * forge check over plywood.yml's identities. Exits chant's `failed` on a
 * mismatch (or, with --require-clouds, on a cloud left unchecked), `done`
 * otherwise.
 */
export async function forgeCheck(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  if (args[0] !== "check") return usage(`unknown forge command '${args[0] ?? ""}'. Run '${PRODUCT} forge check'.`, table, io);
  const fc = await chantForgeCheck();
  if (!fc) {
    if (json) io.out(JSON.stringify({ command: "forge check", ok: false, exitCode: table.failed, error: FORGE_CHECK_MESSAGE }));
    else io.err(`${PRODUCT}: ${FORGE_CHECK_MESSAGE}`);
    return table.failed;
  }
  const requireClouds = args.includes("--require-clouds");
  let rest = args.slice(1).filter((a) => a !== "--require-clouds");
  const flags: Record<string, string | undefined> = {};
  for (const flag of ["--file", "--env", "--forge", "--repo", "--branch"]) {
    const f = takeFlag(rest, flag);
    if (f.missing) return usage(`${flag} takes a value`, table, io);
    flags[flag] = f.value;
    rest = f.rest;
  }
  if (rest.length) return usage(`forge check does not take ${rest.join(" ")}`, table, io);
  const forgeFlag = flags["--forge"];
  if (forgeFlag !== undefined && !(FORGES as readonly string[]).includes(forgeFlag)) return usage(`--forge is ${forgeFlag}; give github, gitlab or forgejo`, table, io);
  const path = flags["--file"] ?? findConfig(io.cwd);
  if (!path) return usage(`no plywood.yml in ${io.cwd} or above it; run '${PRODUCT} init', or pass --file`, table, io);
  let config: PlywoodConfig;
  try {
    config = loadConfig(path);
  } catch (e) {
    return usage(e instanceof ConfigError ? e.message : `${path}: ${(e as Error).message}`, table, io);
  }
  const errors = checkConfig(config).filter((p) => p.severity === "error");
  if (errors.length) {
    for (const p of errors) io.err(`${path}: ${p.key} ${p.message}`);
    if (json) io.out(JSON.stringify({ command: "forge check", ok: false, exitCode: table.failed, file: path, problems: errors }));
    return table.failed;
  }
  const settings = toChantSettings(config);
  const kind = (forgeFlag ?? settings.pipeline.forge?.kind) as Forge | undefined;
  let target: ChantForgeTarget;
  try {
    target = fc.forgeCheckTarget(io.env, { ...(kind && (FORGES as readonly string[]).includes(kind) ? { kind } : {}), ...(flags["--repo"] ? { repo: flags["--repo"] } : {}) });
  } catch (e) {
    return usage((e as Error).message, table, io);
  }
  const env = flags["--env"] ?? "production";
  const cloud = settings.ci.identity?.cloud;
  const pipelines = contractPipelines(fc, cloud, env, workspaceMembers(dirname(path)), settings.pipeline.runner, settings.pipeline.jobs);
  const result = await fc.forgeCheck(
    {
      target,
      words: PRODUCT_WORDS,
      file: path,
      ...(requireClouds ? { requireClouds: true } : {}),
      contract: (live) =>
        fc.pipelineContract({
          forge: target.kind,
          repository: {
            host: target.host,
            path: live.path ?? target.repo,
            defaultBranch: flags["--branch"] ?? live.defaultBranch ?? "main",
            ...(live.ownerId ? { ownerId: live.ownerId } : {}),
            ...(live.repoId ? { repoId: live.repoId } : {}),
          },
          pipelines,
          words: PRODUCT_WORDS,
        }),
    },
    { fetch: globalThis.fetch, env: io.env },
  );
  if (json) io.out(JSON.stringify(result));
  else io.out(fc.describeForgeCheck(result));
  if (!cloud) io.err(`${PRODUCT} forge check: ${path} sets no identity, so no trust was checked`);
  else if (pipelines.length === 0) io.err(`${PRODUCT} forge check: no identity rule covers environment ${env}, so no trust was checked`);
  return fc.forgeCheckExit(result);
}
