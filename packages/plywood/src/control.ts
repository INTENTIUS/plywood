/**
 * `plywood control`: the control repo (plywood#18), on chant's
 * `@intentius/chant/ci-control` (chant#4568). plywood holds the words, the
 * keys a control repo may set for a repository, their check, and the
 * generator reconcile runs; chant holds the dispatch, the entries on the
 * ledger and reconcile itself.
 *
 *   control init [--forge <kind>] [--dry-run]
 *       in the control repo: its own workflow, which runs a repository's
 *       dependents once that repository tells it a stack applied (the forge
 *       lexicon's generateControlPipeline, installed in the control repo)
 *   control put <host/owner/name>|defaults [--file <yml>] [--approver <glob>=<role>[:<quorum>]]...
 *       [--pin pulumi=<v>|plunge=<v>|image=<ref>]... [--estate <name>]... [--by <who>] [--dry-run]
 *       in the control repo: one entry's settings, laid over its current
 *       ones, as a new version on the ledger (putControlEntry)
 *   control import <yml> [--by <who>] [--dry-run]
 *       in the control repo: a reviewed file of `defaults` and `projects`
 *       as entries (importControlConfig), for a pipeline on the control
 *       repo's default branch, so each change is a merged pull request
 *   control list | control retire <host/owner/name>
 *   control reconcile [--apply] [--project <host/owner/name>]
 *       each repository's plywood.yml and files from its entry, through
 *       plywood init; --apply opens a pull request on each one that changes
 *   control dispatch [--sha <sha>]
 *       in a repository: tell plywood.yml's control repo that this commit
 *       applied (dispatchControl), for a job of the repository's own
 *
 * With a chant that has chant#4617, `plywood ci` puts plywood.yml's
 * `control` into the waves spec ({@link wavesControl}), and chant's op-wave
 * generator adds the job that tells the control repo how the waves ended,
 * so the repository needs no dispatch job of its own.
 *
 * An entry's settings are plywood.yml keys, only those in CONTROLLED_KEYS:
 * the gate, the approvers (approval, approval_rules) and the pins (pulumi,
 * plunge, image). Entries are records on the control repo's ledger; nothing
 * here writes git, and nothing pushes: the commands say what to push.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { emitYAMLEntry, parseYAML } from "@intentius/chant/yaml";
import type { ChantControlSettings } from "./chant-config";
import { checkConfig, CONFIG_NAMES, findConfig, loadConfig, parseConfig, type RawConfig } from "./config/index";
import { controlOf } from "./config/control";
import { FORGES } from "./config/routing";
import { isObject } from "./config/types";
import type { ExitTable } from "./exit-codes";
import { repoName } from "./init/detect";
import { positionals, takeFlag, usage, type StageIo } from "./stages";
import { PRODUCT, PRODUCT_WORDS } from "./words";
import type { ForgeKind } from "./chant-product";

/** The plywood.yml keys a control repo sets for a repository. */
export const CONTROLLED_KEYS = ["gate", "approval", "approval_rules", "pulumi", "plunge", "image"] as const;

/** The message when the installed chant has no control repo. */
export const CONTROL_NEEDS_CHANT =
  "the control repo needs chant >= the release after 0.124.54, which carries @intentius/chant/ci-control (chant#4568)";

type Settings = Record<string, unknown>;
interface Entry {
  id: string;
  entry: "project" | "defaults";
  project?: string;
  settings: Settings;
  estates: string[];
  digest: string;
  at: string;
  by?: string;
}
interface Port {
  read(): Promise<string | null>;
  append(line: string, message: string): Promise<string>;
}
type Validator = (entry: "project" | "defaults", project: string | undefined, settings: Settings) => string[];
interface WriteOptions {
  product: string;
  by?: string;
  validate?: Validator;
  expect?: string;
  dryRun?: boolean;
}
interface PutResult {
  id: string;
  status: "created" | "updated" | "unchanged" | "retired";
  commit?: string;
}
interface FileChange {
  path: string;
  status: "created" | "updated" | "unchanged" | "removed";
}
interface ReconcileTarget {
  key: string;
  name: string;
  forge: ForgeKind;
  settings: Settings;
  dryRun: boolean;
}
interface Outcome {
  key: string;
  status: "unchanged" | "would-change" | "pull-request" | "failed";
  changes: FileChange[];
  pullRequest?: string;
  error?: string;
}
interface Target {
  repo: string;
  forge: ForgeKind;
  member: string;
  op: string;
  tokenSecret: string;
}

/** What plywood calls from `@intentius/chant/ci-control`. */
export interface ChantControl {
  controlSettingsProblems(input: unknown, where?: string): string[];
  resolveControlTarget(input: ChantControlSettings, fallbackMember: string): Target;
  dispatchControl(target: Target, d: { member: string; op: string; sha: string }, opts?: { env?: Record<string, string | undefined>; words?: unknown }): Promise<{ status: number }>;
  controlPipelinePath(forge: ForgeKind, words?: unknown): string;
  gitControlLedger(opts?: { cwd?: string }): Port;
  readControlEntries(port: Port, opts?: { validate?: Validator; lenient?: boolean }): Promise<Entry[]>;
  putControlEntry(port: Port, want: { entry: "project" | "defaults"; project?: string; settings: Settings; estates?: string[] }, opts: WriteOptions): Promise<PutResult>;
  retireControlEntry(port: Port, project: string, opts: WriteOptions): Promise<PutResult>;
  importControlConfig(port: Port, config: { defaults?: Settings; projects: Record<string, Settings>; estates?: Record<string, string[]> }, opts: WriteOptions): Promise<Array<PutResult & { entry: string }>>;
  controlConfig(entries: readonly Entry[]): { defaults?: Settings; projects: Record<string, Settings> };
  reconcileProjects(
    projects: ReadonlyArray<{ key: string; settings: Settings }>,
    options: { mode: "dry-run" | "apply"; project?: string; words?: unknown; generate: (dir: string, target: ReconcileTarget) => Promise<FileChange[]>; env?: Record<string, string | undefined> },
  ): Promise<Outcome[]>;
  describeReconcile(outcomes: readonly Outcome[], mode: "dry-run" | "apply"): string;
  /** Present when the op-waves spec takes `control` and its dispatch carries the outcome (chant#4617). */
  recordControlAppliedFromEnv?: (...args: unknown[]) => unknown;
  CONTROL_APPLIED_FLOOR?: string;
}

/**
 * Whether the installed chant's op waves take `control` (chant#4617). It
 * landed with the control repo's apply records on `ci-control`, so
 * `recordControlAppliedFromEnv` there is the check, and plywood needs no
 * import of chant's op-waves module.
 */
export function hasWavesControl(chant: ChantControl): boolean {
  return typeof chant.recordControlAppliedFromEnv === "function";
}

/** The `ControlSettingsInput` keys an op waves spec's `control` carries, with `member`. */
const WAVES_CONTROL_KEYS = ["repo", "op", "forge", "member", "tokenSecret", "readTokenSecret", "ref", "apiBase"] as const;

/**
 * plywood.yml's `control` as the waves spec's `control` (chant#4617): its
 * settings with `member` resolved, since a spec has no repository name to
 * default it to. `none` when plywood.yml has no control key, `missing` when
 * the installed chant's op waves take no `control`.
 */
export async function wavesControl(cwd: string): Promise<{ control: Record<string, unknown>; repo: string } | { none: true } | { missing: string } | { error: string }> {
  const file = findConfig(cwd);
  if (!file || controlOf(loadConfig(file).doc) === undefined) return { none: true };
  const chant = await chantControl();
  if (!chant) return { missing: CONTROL_NEEDS_CHANT };
  if (!hasWavesControl(chant)) return { missing: "the waves workflow tells the control repo with a chant that has chant#4617" };
  const target = await controlTarget(chant, cwd);
  if ("error" in target) return target;
  const settings: Record<string, unknown> = { ...(controlOf(loadConfig(file).doc) as unknown as Record<string, unknown>), member: target.member };
  const control: Record<string, unknown> = {};
  for (const key of WAVES_CONTROL_KEYS) if (settings[key] !== undefined) control[key] = settings[key];
  return { control, repo: target.repo };
}

/**
 * The control repo the note job reads (plywood#28, chant#4619): plywood.yml's
 * `control` resolved to chant's target, or undefined when plywood.yml has
 * none, the installed chant has no control repo, or the settings do not
 * check. `plywood ci` and `plywood init` pass it to productPipelineJobs,
 * which hands back the note job's read step as `post.control`.
 */
export async function noteControlTarget(doc: RawConfig, root: string): Promise<Target | undefined> {
  const settings = controlOf(doc);
  if (!settings) return undefined;
  const chant = await chantControl();
  if (!chant || chant.controlSettingsProblems(settings).length > 0) return undefined;
  try {
    return chant.resolveControlTarget(settings, repoName(root));
  } catch {
    return undefined;
  }
}

/** chant#4568's presence check: these three present means the rest is too. */
const REQUIRED = ["controlDispatchRequest", "putControlEntry", "reconcileProjects"] as const;

let cached: Promise<ChantControl | undefined> | undefined;

/** chant's control repo, or undefined when the installed chant lacks it. */
export function chantControl(): Promise<ChantControl | undefined> {
  cached ??= (async () => {
    try {
      // @ts-ignore: the subpath is missing from chant 0.124.54 (chant#4568).
      const m: Record<string, unknown> = await import("@intentius/chant/ci-control");
      return REQUIRED.every((n) => typeof m[n] === "function") ? (m as unknown as ChantControl) : undefined;
    } catch {
      return undefined;
    }
  })();
  return cached;
}

/** Tests stand in a fake chant (or none). `reset` goes back to the real import. */
export function setChantControlForTests(fake: ChantControl | undefined | "reset"): void {
  cached = fake === "reset" ? undefined : Promise.resolve(fake);
}

/** The problems with an entry's settings, as plywood.yml's checks see those keys. */
export const validateControlSettings: Validator = (_entry, _project, settings) => {
  const out: string[] = [];
  for (const key of Object.keys(settings)) {
    if (!(CONTROLLED_KEYS as readonly string[]).includes(key)) out.push(`${key} is not a key a control repo sets; it sets ${CONTROLLED_KEYS.join(", ")}`);
  }
  for (const p of checkConfig({ doc: settings })) if (p.severity === "error") out.push(`${p.key} ${p.message}`);
  return out;
};

/** The settings for a repository: the defaults, with its own entry laid over. */
export function projectSettings(defaults: Settings | undefined, own: Settings): Settings {
  return { ...(defaults ?? {}), ...own };
}

/** `--approver <glob>=<role>[:<quorum>]` and `--pin <tool>=<version>` laid over `base`. */
export function settingsFromFlags(base: Settings, approvers: readonly string[], pins: readonly string[]): { settings: Settings } | { error: string } {
  const out: Settings = structuredClone(base);
  for (const a of approvers) {
    const m = /^([^=]+)=([^:=]+)(?::(\d+))?$/.exec(a);
    if (!m) return { error: `--approver takes <stack glob>=<role>[:<quorum>], such as 'shop/prod-*=sre:2', not '${a}'` };
    const rules = isObject(out.approval_rules) ? { ...(out.approval_rules as Settings) } : {};
    rules[m[1]!] = { role: m[2]!, ...(m[3] ? { quorum: Number(m[3]) } : {}) };
    out.approval_rules = rules;
  }
  for (const p of pins) {
    const m = /^(pulumi|plunge|image)=(.+)$/.exec(p);
    if (!m) return { error: `--pin takes pulumi=<version>, plunge=<version> or image=<ref>, not '${p}'` };
    out[m[1]!] = m[2]!;
  }
  return { settings: out };
}

/** Every value of a repeated flag, and the arguments without them. */
function takeAll(args: string[], flag: string): { values: string[]; rest: string[]; missing: boolean } {
  const values: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== flag) {
      rest.push(args[i]!);
      continue;
    }
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) return { values, rest: args, missing: true };
    values.push(v);
    i++;
  }
  return { values, rest, missing: false };
}

function readYamlFile(cwd: string, file: string): Settings {
  const doc = parseYAML(readFileSync(join(cwd, file), "utf8"));
  if (!isObject(doc)) throw new Error(`${file} must be a mapping`);
  return doc;
}

/** `plywood control <sub> ...`. */
export async function control(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const [sub, ...rest] = args;
  const subs = ["init", "put", "import", "list", "retire", "reconcile", "dispatch"];
  if (!sub || !subs.includes(sub)) return usage(`control takes one of ${subs.join(", ")}`, table, io);
  const chant = await chantControl();
  if (!chant) return usage(`${CONTROL_NEEDS_CHANT}. Upgrade plywood once that chant is out, or build against a local chant with 'just chant-local'.`, table, io);
  const emit = (envelope: Record<string, unknown>, lines: string[]): void => {
    if (json) io.out(JSON.stringify({ command: `control ${sub}`, ...envelope }));
    else for (const l of lines) io.out(l);
  };
  try {
    switch (sub) {
      case "init":
        return await controlInit(chant, rest, emit, table, io);
      case "dispatch":
        return await controlDispatch(chant, rest, emit, table, io);
      case "reconcile":
        return await controlReconcile(chant, rest, emit, table, io);
      default:
        return await controlEntries(chant, sub, rest, emit, table, io);
    }
  } catch (e) {
    io.err(`${PRODUCT} control ${sub}: ${(e as Error).message}`);
    return table.failed;
  }
}

type Emit = (envelope: Record<string, unknown>, lines: string[]) => void;

/** The forge lexicon's generateControlPipeline, from the control repo's own install. */
async function forgeControlPipeline(cwd: string, forge: ForgeKind): Promise<((options: { words: unknown }) => { path: string; content: string; notes: string[] }) | undefined> {
  const name = `@intentius/chant-lexicon-${forge}/components/control-pipeline`;
  try {
    const require = createRequire(join(cwd, "package.json"));
    const m: Record<string, unknown> = await import(pathToFileURL(require.resolve(name)).href);
    return typeof m.generateControlPipeline === "function" ? (m.generateControlPipeline as never) : undefined;
  } catch {
    return undefined;
  }
}

async function controlInit(chant: ChantControl, args: string[], emit: Emit, table: ExitTable, io: StageIo): Promise<number> {
  const forgeFlag = takeFlag(args, "--forge");
  if (forgeFlag.missing) return usage("--forge takes github, gitlab or forgejo", table, io);
  const extra = forgeFlag.rest.filter((a) => a !== "--dry-run");
  if (extra.length) return usage(`control init does not take ${extra.join(" ")}`, table, io);
  const dryRun = forgeFlag.rest.includes("--dry-run");
  const forge = (forgeFlag.value ?? "github") as ForgeKind;
  if (!(FORGES as readonly string[]).includes(forge)) return usage(`--forge ${forge} is not one of ${FORGES.join(", ")}`, table, io);
  const generate = await forgeControlPipeline(io.cwd, forge);
  if (!generate) {
    return usage(`control init writes the control repo's workflow with @intentius/chant-lexicon-${forge}'s generateControlPipeline (chant#4568); install it in the control repo at the chant release that has it`, table, io);
  }
  const file = generate({ words: PRODUCT_WORDS });
  const path = join(io.cwd, file.path);
  const before = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  const status = before === file.content ? "unchanged" : "written";
  if (!dryRun && status === "written") {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.content);
  }
  emit({ ok: true, exitCode: table.done, forge, file: file.path, status, dryRun, notes: file.notes }, [
    `${PRODUCT} control init: ${file.path} ${dryRun && status === "written" ? "would be written" : status}`,
    ...file.notes.map((n) => `  to do: ${n}`),
  ]);
  return table.done;
}

async function controlDispatch(chant: ChantControl, args: string[], emit: Emit, table: ExitTable, io: StageIo): Promise<number> {
  const shaFlag = takeFlag(args, "--sha");
  if (shaFlag.missing || shaFlag.rest.length) return usage("control dispatch takes only --sha <commit>", table, io);
  const sha = shaFlag.value ?? io.env.GITHUB_SHA ?? io.env.CI_COMMIT_SHA;
  if (!sha) return usage("control dispatch needs --sha, or GITHUB_SHA or CI_COMMIT_SHA set", table, io);
  const target = await controlTarget(chant, io.cwd);
  if ("error" in target) return usage(target.error, table, io);
  const r = await chant.dispatchControl(target, { member: target.member, op: target.op, sha }, { env: io.env, words: PRODUCT_WORDS });
  emit({ ok: true, exitCode: table.done, repo: target.repo, member: target.member, op: target.op, sha, status: r.status }, [
    `${PRODUCT} control dispatch: told ${target.repo} that ${target.member} applied ${sha.slice(0, 8)} (HTTP ${r.status})`,
  ]);
  return table.done;
}

/** plywood.yml's control repo, resolved and checked by chant. */
export async function controlTarget(chant: ChantControl, cwd: string): Promise<Target | { error: string }> {
  const file = findConfig(cwd);
  if (!file) return { error: `no plywood.yml in ${cwd} or above it` };
  const settings = controlOf(loadConfig(file).doc);
  if (!settings) return { error: `${file} has no control key` };
  const problems = chant.controlSettingsProblems(settings);
  if (problems.length) return { error: problems.join("; ") };
  return chant.resolveControlTarget(settings, repoName(dirname(file)));
}

async function controlEntries(chant: ChantControl, sub: string, args: string[], emit: Emit, table: ExitTable, io: StageIo): Promise<number> {
  const port = chant.gitControlLedger({ cwd: io.cwd });
  const byFlag = takeFlag(args, "--by");
  if (byFlag.missing) return usage("--by takes a name", table, io);
  const dryRun = byFlag.rest.includes("--dry-run");
  const opts: WriteOptions = { product: PRODUCT, validate: validateControlSettings, ...(byFlag.value ? { by: byFlag.value } : {}), ...(dryRun ? { dryRun } : {}) };
  const pushLine = dryRun ? [] : [`  push it: git push origin chant/lifecycle (the control repo's ledger)`];
  let rest = byFlag.rest.filter((a) => a !== "--dry-run");

  if (sub === "list") {
    if (rest.length) return usage(`control list does not take ${rest.join(" ")}`, table, io);
    const entries = await chant.readControlEntries(port, { validate: validateControlSettings });
    emit({ ok: true, exitCode: table.done, entries }, entries.length ? entries.map((e) => `${e.id}  ${e.project ?? "defaults"}  ${JSON.stringify(e.settings)}${e.estates.length ? `  estates ${e.estates.join(", ")}` : ""}`) : ["the control repo has no entries"]);
    return table.done;
  }
  if (sub === "retire") {
    if (rest.length !== 1) return usage("control retire takes one host/owner/name", table, io);
    const r = await chant.retireControlEntry(port, rest[0]!, opts);
    emit({ ok: true, exitCode: table.done, ...r, dryRun }, [`${PRODUCT} control retire: ${rest[0]} ${r.status} (${r.id})`, ...pushLine]);
    return table.done;
  }
  if (sub === "import") {
    if (rest.length !== 1) return usage("control import takes one file of defaults and projects", table, io);
    const doc = readYamlFile(io.cwd, rest[0]!);
    const projects = isObject(doc.projects) ? (doc.projects as Record<string, Settings>) : {};
    const estates = isObject(doc.estates) ? (doc.estates as Record<string, string[]>) : undefined;
    const results = await chant.importControlConfig(port, { ...(isObject(doc.defaults) ? { defaults: doc.defaults } : {}), projects, ...(estates ? { estates } : {}) }, opts);
    emit({ ok: true, exitCode: table.done, results, dryRun }, [...results.map((r) => `${PRODUCT} control import: ${r.entry} ${r.status} (${r.id})`), ...pushLine]);
    return table.done;
  }
  // put
  const file = takeFlag(rest, "--file");
  const approvers = takeAll(file.rest, "--approver");
  const pins = takeAll(approvers.rest, "--pin");
  const estates = takeAll(pins.rest, "--estate");
  if (file.missing || approvers.missing || pins.missing || estates.missing) return usage("--file, --approver, --pin and --estate each take a value", table, io);
  rest = positionals(estates.rest);
  if (rest.length !== 1 || estates.rest.length !== 1) return usage("control put takes one host/owner/name, or defaults, and its flags", table, io);
  const which = rest[0]!;
  const entry = which === "defaults" ? ("defaults" as const) : ("project" as const);
  const current = (await chant.readControlEntries(port, { lenient: true })).find((e) => (entry === "defaults" ? e.entry === "defaults" : e.project === which));
  const fromFile = file.value ? readYamlFile(io.cwd, file.value) : {};
  const made = settingsFromFlags({ ...(current?.settings ?? {}), ...fromFile }, approvers.values, pins.values);
  if ("error" in made) return usage(made.error, table, io);
  const { settings } = made;
  const r = await chant.putControlEntry(
    port,
    { entry, ...(entry === "project" ? { project: which } : {}), settings, ...(estates.values.length ? { estates: estates.values } : {}) },
    { ...opts, expect: current?.digest ?? "" },
  );
  emit({ ok: true, exitCode: table.done, ...r, settings, dryRun }, [`${PRODUCT} control put: ${which} ${r.status} (${r.id})`, ...(r.status === "unchanged" ? [] : pushLine)]);
  return table.done;
}

/**
 * plywood.yml in `dir` with the control repo's keys laid over, as text, or
 * undefined when it already holds them. A plywood.yml with no other key is
 * written from those keys alone, so init fills the rest.
 */
export function controlledConfigText(existing: string | undefined, settings: Settings): string | undefined {
  const doc: RawConfig = existing ? parseConfig(existing).doc : {};
  const changed = CONTROLLED_KEYS.some((k) => k in settings && JSON.stringify(doc[k]) !== JSON.stringify(settings[k]));
  if (!changed && existing !== undefined) return undefined;
  const next: RawConfig = { ...doc };
  for (const k of CONTROLLED_KEYS) if (k in settings) next[k] = settings[k];
  return (
    Object.entries(next)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => emitYAMLEntry(k, v as never))
      .join("\n") + "\n"
  );
}

/** reconcile's generator: the repository's plywood.yml from its entry, then plywood init over it. */
export function controlGenerator(table: ExitTable, env: NodeJS.ProcessEnv): (dir: string, target: ReconcileTarget) => Promise<FileChange[]> {
  return async (dir, target) => {
    const name = CONFIG_NAMES.find((n) => existsSync(join(dir, n))) ?? "plywood.yml";
    const path = join(dir, name);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : undefined;
    const text = controlledConfigText(existing, target.settings);
    const changes: FileChange[] = [];
    if (text !== undefined) {
      changes.push({ path: name, status: existing === undefined ? "created" : "updated" });
      if (!target.dryRun) writeFileSync(path, text);
    }
    if (target.dryRun && text !== undefined) return changes;
    // init over the new plywood.yml: the waves spec, the workflow and the rest follow it.
    const { runInit } = await import("./init");
    const r = await runInit({ env: "production", bucketCheck: false, dryRun: target.dryRun, yes: true }, table, { out: () => {}, err: () => {}, cwd: dir, env });
    for (const f of r.files) {
      if (f.status === "written" && !changes.some((c) => c.path === f.file)) changes.push({ path: f.file, status: existsSync(join(dir, f.file)) ? "updated" : "created" });
      if (f.status === "failed") throw new Error(`plywood init in ${target.key}: ${f.file} ${f.note ?? "failed"}`);
    }
    if (!r.ok) throw new Error(`plywood init in ${target.key}: ${r.notes.at(-1) ?? "failed"}`);
    return changes;
  };
}

async function controlReconcile(chant: ChantControl, args: string[], emit: Emit, table: ExitTable, io: StageIo): Promise<number> {
  const projectFlag = takeFlag(args, "--project");
  if (projectFlag.missing) return usage("--project takes host/owner/name", table, io);
  const extra = projectFlag.rest.filter((a) => a !== "--apply");
  if (extra.length) return usage(`control reconcile does not take ${extra.join(" ")}`, table, io);
  const mode = projectFlag.rest.includes("--apply") ? ("apply" as const) : ("dry-run" as const);
  const entries = await chant.readControlEntries(chant.gitControlLedger({ cwd: io.cwd }), { validate: validateControlSettings });
  const { defaults, projects } = chant.controlConfig(entries);
  const list = Object.entries(projects).map(([key, own]) => ({ key, settings: projectSettings(defaults, own) }));
  const outcomes = await chant.reconcileProjects(list, {
    mode,
    words: PRODUCT_WORDS,
    generate: controlGenerator(table, io.env),
    env: io.env,
    ...(projectFlag.value ? { project: projectFlag.value } : {}),
  });
  const failed = outcomes.some((o) => o.status === "failed");
  const code = failed ? table.failed : table.done;
  emit({ ok: !failed, exitCode: code, mode, outcomes }, chant.describeReconcile(outcomes, mode).split("\n"));
  return code;
}
