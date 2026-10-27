/**
 * `plywood init`: sets plywood up from what the repository already has.
 *
 *   plywood init [--preset merge|before-merge|approve-all]
 *                [--gate always|on-destructive|never] [--engine pulumi|plunge]
 *                [--forge github|gitlab|forgejo] [--env <env>]
 *                [--no-bucket-check] [--dry-run] [--yes] [--json]
 *   plywood init --print-prompt
 *
 * It reads each Pulumi.yaml and its Pulumi.<stack>.yaml files, each
 * stack's backend (plywood.yml, PULUMI_BACKEND_URL, Pulumi.yaml's
 * backend.url), the forge from the origin remote and the default branch
 * (src/init/detect.ts). Then it writes, each only when its content changes:
 *
 *   plywood.yml           only what detection could not settle, and the
 *                         preset's keys; a plywood.yml already there is kept
 *   chant.workspace.json  a member of chant's pulumi kind per project (the
 *                         picture `chant workspace graph` and behold read),
 *                         the pulumi lexicon's pin, and plywood.yml's ci keys
 *   chant.config.ts       the chant project, with the pulumi lexicon
 *   plywood.component.ts  one component per stack, through pulumi-up
 *   .chant/op-waves/pulumi-up.spec.json
 *                         the waves a merge updates in (chant#4550)
 *   the workflow          chant's generator output with plywood's words,
 *                         keeping the team's own jobs (src/init/workflow.ts)
 *
 * A `.pre-commit-config.yaml` becomes a check hook (chant#4556). An S3, GCS
 * or Azure backend gets chant's bucket check (chant#4558), and each missing
 * setting's fix is printed. A workflow that runs pulumi/actions is named,
 * and left alone. Approval is always the pull request's preview (plywood's
 * `pull-request` preset of chant#4550 ruling B); a preset picks when updates
 * run and when a wave waits.
 *
 * Everything new in chant is reached through a feature-detect: on a chant
 * without the product pipeline, init writes the config files and says the
 * waves spec and the workflow need a newer chant.
 *
 * The steps are separate functions so `--engine plunge` (src/init/engine.ts)
 * and `--from <workflow>` add a step rather than change one.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { dependencies as PLYWOOD_DEPENDENCIES } from "../package.json";
import { BUILT_CHANT, chantProduct, needsChantMessage, type ChantProduct, type ForgeKind } from "./chant-product";
import { toChantSettings, type ChantSettings } from "./chant-config";
import { gateOf } from "./config/approval";
import { engineOf } from "./config/engine";
import { checkConfig, CONFIG_NAMES, loadConfig, parseConfig, type PlywoodConfig } from "./config/index";
import { FORGES } from "./config/routing";
import { stacksOf as configuredStacks } from "./config/stacks";
import { isObject, type RawConfig } from "./config/types";
import type { ExitTable } from "./exit-codes";
import { chantBuildFlags, chantPipelineOptions } from "./images";
import { backendOf, bucketLines, bucketTarget, chantBucketCheck, isPulumiCloud, needsBucketCheckMessage, type BucketReport } from "./init/backend";
import { detect, repoName, type Detected } from "./init/detect";
import { engineStep, INIT_ENGINES, type InitEngine } from "./init/engine";
import { DEFAULT_PRESET, gateFlag, PRESETS, PRESET_NAMES, preCommitHook, presetByName, type PresetName } from "./init/presets";
import {
  chantConfigTs,
  componentsFile,
  jsonText,
  plywoodYml,
  PULUMI_LEXICON,
  waveRunner,
  wavesOf,
  wavesSpec,
  workspaceDeclaration,
  type InitStack,
} from "./init/render";
import { writeWorkflow } from "./init/workflow";
import { takeFlag, WORKFLOW_FILE, workflowPlan, type StageIo } from "./stages";
import { template } from "./templates";
import { OP_NAME, PRODUCT, PRODUCT_WORDS } from "./words";

/** init's io: the stage io, and a question asked of the person running it (absent when nobody can answer). */
export interface InitIo extends StageIo {
  ask?: (question: string, choices: readonly string[], fallback: string) => Promise<string>;
}

export interface InitOptions {
  preset?: PresetName;
  gate?: "always" | "on-destructive" | "never";
  engine?: InitEngine;
  forge?: ForgeKind;
  env: string;
  bucketCheck: boolean;
  dryRun: boolean;
  yes: boolean;
}

/** One file init looked at. */
export interface InitFile {
  file: string;
  status: "written" | "unchanged" | "kept" | "skipped" | "failed";
  note?: string;
}

export interface InitResult {
  ok: boolean;
  exitCode: number;
  files: InitFile[];
  stacks: string[];
  waves: Array<{ name: string; stacks: string[] }>;
  forge: { kind: ForgeKind; because: string };
  /** What the person still has to do: secrets, settings, installs. */
  todo: string[];
  notes: string[];
  buckets: BucketReport[];
}

/** The workspace declaration file, the chant project and the component file init writes. */
export const DECLARATION_FILE = "chant.workspace.json";
export const CHANT_CONFIG_FILE = "chant.config.ts";
export const COMPONENTS_FILE = "plywood.component.ts";
export const WAVES_SPEC_FILE = `.chant/op-waves/${OP_NAME}.spec.json`;

/** The chant pin plywood ships with: the pulumi lexicon is pinned to the same release. */
export const CHANT_PIN: string = (PLYWOOD_DEPENDENCIES as Record<string, string>)["@intentius/chant"] ?? "0.124.54";

/** Parses init's flags. A bad flag is a message. */
export function parseInitArgs(args: string[]): InitOptions | { error: string } | { printPrompt: true } {
  if (args.includes("--print-prompt")) return { printPrompt: true };
  if (args.includes("--from")) {
    return { error: "--from, reading an existing pulumi/actions workflow, is not built yet; run init without it and the workflow stays as it is" };
  }
  let rest = args;
  const take = (flag: string): { value?: string; error?: string } => {
    const t = takeFlag(rest, flag);
    if (t.missing) return { error: `${flag} takes a value` };
    rest = t.rest;
    return t.value !== undefined ? { value: t.value } : {};
  };
  const preset = take("--preset");
  const gate = take("--gate");
  const engine = take("--engine");
  const forge = take("--forge");
  const env = take("--env");
  const bad = [preset, gate, engine, forge, env].find((t) => t.error);
  if (bad) return { error: bad.error! };
  const flags = new Set(["--no-bucket-check", "--dry-run", "--yes", "-y"]);
  const extra = rest.filter((a) => !flags.has(a));
  if (extra.length) return { error: `init does not take ${extra.join(" ")}` };
  if (preset.value !== undefined && !presetByName(preset.value)) return { error: `--preset ${preset.value} is not one of ${PRESET_NAMES.join(", ")}` };
  const g = gate.value !== undefined ? gateFlag(gate.value) : undefined;
  if (gate.value !== undefined && !g) return { error: `--gate ${gate.value} is not one of always, on-destructive (or destroy), never` };
  if (engine.value !== undefined && !(INIT_ENGINES as readonly string[]).includes(engine.value)) return { error: `--engine ${engine.value} is not one of ${INIT_ENGINES.join(", ")}` };
  if (forge.value !== undefined && !(FORGES as readonly string[]).includes(forge.value)) return { error: `--forge ${forge.value} is not one of ${FORGES.join(", ")}` };
  return {
    ...(preset.value ? { preset: preset.value as PresetName } : {}),
    ...(g ? { gate: g } : {}),
    ...(engine.value ? { engine: engine.value as InitEngine } : {}),
    ...(forge.value ? { forge: forge.value as ForgeKind } : {}),
    env: env.value ?? "production",
    bucketCheck: !rest.includes("--no-bucket-check"),
    dryRun: rest.includes("--dry-run"),
    yes: rest.includes("--yes") || rest.includes("-y"),
  };
}

/** Writes `text` to `root/rel` when it differs, creating directories; with dryRun, writes nothing. */
function put(root: string, rel: string, text: string, dryRun: boolean, note?: string): InitFile {
  const file = join(root, rel);
  const before = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  if (before === text) return { file: rel, status: "unchanged", ...(note ? { note } : {}) };
  if (!dryRun) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return { file: rel, status: "written", ...(note ? { note } : {}) };
}

/** The plywood.yml there already, if any. */
function existingConfig(root: string): string | undefined {
  return CONFIG_NAMES.find((n) => existsSync(join(root, n)));
}

/**
 * The keys of a new plywood.yml: the preset's, the gate and engine flags,
 * the forge when the remote does not settle it (or names a self-hosted one),
 * and a backend the jobs cannot read from the repository.
 */
export async function newConfigKeys(detected: Detected, opts: InitOptions, io: InitIo): Promise<{ keys: RawConfig; notes: string[]; forge: { kind: ForgeKind; because: string } }> {
  const notes: string[] = [];
  let presetName = opts.preset;
  if (!presetName && io.ask && !opts.yes) {
    for (const p of PRESETS) io.err(`  ${p.name.padEnd(13)} ${p.summary}`);
    presetName = (await io.ask("Preset", PRESET_NAMES, DEFAULT_PRESET)) as PresetName;
  }
  const preset = presetByName(presetName ?? DEFAULT_PRESET)!;
  const keys: RawConfig = structuredClone(preset.keys);
  if (opts.gate) keys.gate = opts.gate;
  const engine = engineStep({ engine: opts.engine, detected, env: io.env });
  Object.assign(keys, engine.keys);
  notes.push(...engine.notes);

  let forge: { kind: ForgeKind; because: string };
  if (opts.forge) {
    forge = { kind: opts.forge, because: "--forge" };
    if (detected.forge?.kind !== opts.forge) keys.forge = { kind: opts.forge };
    else if (detected.forge.url) keys.forge = { kind: opts.forge, url: detected.forge.url };
  } else if (detected.forge) {
    forge = { kind: detected.forge.kind, because: detected.forge.because };
    if (detected.forge.url) keys.forge = { kind: detected.forge.kind, url: detected.forge.url };
  } else {
    const kind = (io.ask && !opts.yes ? await io.ask("Forge", FORGES, "github") : "github") as ForgeKind;
    forge = { kind, because: io.ask && !opts.yes ? "you chose it" : "origin names no forge init knows, so github; change forge.kind in plywood.yml" };
    keys.forge = { kind };
  }

  // A backend only init's environment names: the jobs do not see that environment.
  const fromEnv = io.env.PULUMI_BACKEND_URL?.trim();
  if (fromEnv && detected.projects.some((p) => !p.backendUrl)) {
    keys.backend = fromEnv;
    notes.push(`backend ${fromEnv} came from PULUMI_BACKEND_URL; it is in plywood.yml so the jobs use it too`);
  }
  return { keys, notes, forge };
}

/** The stacks init settles: each one found, with plywood.yml's settings for it laid over, then any plywood.yml lists that init did not find. */
export function initStacks(detected: Detected, doc: RawConfig): InitStack[] {
  const listed = configuredStacks(doc);
  const out: InitStack[] = [];
  const seen = new Set<string>();
  const add = (key: string, project: string, stack: string, dir: string): void => {
    const own = listed[key] ?? {};
    const backend = own.backend ?? (typeof doc.backend === "string" ? doc.backend : undefined);
    const engine = engineOf(doc, backend)?.engine;
    out.push({
      key,
      project,
      stack,
      dir: own.dir ?? dir,
      ...(engine ? { engine } : {}),
      ...(own.gate ? { gate: own.gate } : {}),
    });
    seen.add(key);
  };
  for (const s of detected.stacks) add(s.key, s.project, s.stack, s.dir);
  for (const [key, own] of Object.entries(listed)) {
    if (seen.has(key)) continue;
    const [project, stack] = key.split("/") as [string, string];
    add(key, project, stack, own?.dir ?? ".");
  }
  return out;
}

/** The forge for a kept plywood.yml: its forge.kind, the flag, or detection. */
function forgeFor(doc: RawConfig, detected: Detected, opts: InitOptions): { kind: ForgeKind; because: string } {
  if (opts.forge) return { kind: opts.forge, because: "--forge" };
  const kind = isObject(doc.forge) ? (doc.forge.kind as ForgeKind | undefined) : undefined;
  if (kind) return { kind, because: "plywood.yml says forge.kind" };
  if (detected.forge) return { kind: detected.forge.kind, because: detected.forge.because };
  return { kind: "github", because: "origin names no forge init knows, so github" };
}

/** chant's `writeCiHook` (chant#4556), reached through a feature-detect. */
async function chantWriteCiHook(): Promise<((root: string, moment: "check", hook: { name: string; command: string[] }) => { file: string; replaced: boolean }) | undefined> {
  try {
    // @ts-ignore: the subpath's writeCiHook is missing from chant 0.124.54 (chant#4556).
    const m: Record<string, unknown> = await import("@intentius/chant/components/check-hooks");
    return typeof m.writeCiHook === "function" ? (m.writeCiHook as never) : undefined;
  } catch {
    return undefined;
  }
}

/** Runs init. Writes nothing when the config has an error; with dryRun, writes nothing at all. */
export async function runInit(opts: InitOptions, table: ExitTable, io: InitIo): Promise<InitResult> {
  const detected = detect(io.cwd);
  const { root } = detected;
  const files: InitFile[] = [];
  const notes: string[] = [];
  const todo: string[] = [];
  const buckets: BucketReport[] = [];
  const fail = (message: string, forge = { kind: "github" as ForgeKind, because: "" }): InitResult => ({
    ok: false, exitCode: table.failed, files, stacks: [], waves: [], forge, todo, notes: [...notes, message], buckets,
  });

  if (detected.projects.length === 0) return fail(`no Pulumi.yaml under ${root}; plywood init sets up a repository that has a Pulumi program`);
  if (detected.stacks.length === 0) notes.push("no Pulumi.<stack>.yaml beside any Pulumi.yaml, so no stack is set up; run pulumi stack init, then plywood init again");

  // plywood.yml: kept when there, else written with only what detection could not settle.
  let config: PlywoodConfig;
  let forge: { kind: ForgeKind; because: string };
  const kept = existingConfig(root);
  if (kept) {
    try {
      config = loadConfig(join(root, kept));
    } catch (e) {
      return fail((e as Error).message);
    }
    files.push({ file: kept, status: "kept" });
    const ignored = [opts.preset && "--preset", opts.gate && "--gate", opts.engine && "--engine"].filter(Boolean);
    if (ignored.length) notes.push(`${kept} is kept as it is, so ${ignored.join(", ")} changed nothing; set the keys there`);
    forge = forgeFor(config.doc, detected, opts);
  } else {
    const made = await newConfigKeys(detected, opts, io);
    notes.push(...made.notes);
    forge = made.forge;
    const text = plywoodYml(made.keys);
    config = parseConfig(text, "plywood.yml");
    const problems = checkConfig(config).filter((p) => p.severity === "error");
    if (problems.length) return fail(problems.map((p) => `plywood.yml: ${p.key} ${p.message}`).join("\n"), forge);
    files.push(put(root, "plywood.yml", text, opts.dryRun));
  }
  const problems = checkConfig(config).filter((p) => p.severity === "error");
  if (problems.length) return fail(problems.map((p) => `${kept}: ${p.key} ${p.message}`).join("\n"), forge);
  const doc = config.doc;
  const settings: ChantSettings = toChantSettings(config);
  const stacks = initStacks(detected, doc);
  const waves = wavesOf(stacks, settings.pipeline.waves);

  // The member picture and the chant project.
  files.push(declarationStep(root, detected, settings, opts.dryRun));
  if (existsSync(join(root, CHANT_CONFIG_FILE))) {
    const text = readFileSync(join(root, CHANT_CONFIG_FILE), "utf8");
    if (!/["']pulumi["']/.test(text)) {
      files.push({ file: CHANT_CONFIG_FILE, status: "kept", note: 'add "pulumi" to its lexicons so chant previews and updates the stacks' });
    } else files.push({ file: CHANT_CONFIG_FILE, status: "kept" });
  } else files.push(put(root, CHANT_CONFIG_FILE, chantConfigTs(), opts.dryRun));
  files.push(put(root, COMPONENTS_FILE, componentsFile(stacks), opts.dryRun));

  // What the repository already runs.
  if (detected.preCommit) files.push(await preCommitStep(root, detected.preCommit, opts.dryRun));
  for (const wf of detected.pulumiActions) {
    notes.push(`${wf} runs pulumi/actions. init leaves it as it is; once plywood's previews and updates replace it, remove it, or keep it for the stacks plywood does not run`);
  }

  // The waves spec and the workflow come from chant's product pipeline.
  const chant = await chantProduct();
  if (!chant) {
    const message = needsChantMessage("Writing the waves spec and the workflow");
    files.push({ file: WAVES_SPEC_FILE, status: "skipped", note: message }, { file: WORKFLOW_FILE[forge.kind], status: "skipped", note: "needs the same chant" });
  } else {
    const spec = wavesSpecStep(chant, stacks, doc, settings, detected.defaultBranch);
    if (stacks.length > 0) files.push(put(root, WAVES_SPEC_FILE, jsonText(spec), opts.dryRun));
    files.push(await workflowStep(chant, root, doc, settings, forge.kind, opts, stacks.length > 0 ? spec : undefined));
  }

  // The bucket each self-managed stack keeps its state in.
  if (opts.bucketCheck) notes.push(...(await bucketStep(detected, doc, io.env, buckets)));

  todo.push(...todoLines(detected, doc, forge.kind, io.env));
  const failed = files.find((f) => f.status === "failed");
  return {
    ok: !failed,
    exitCode: failed ? table.failed : table.done,
    files,
    stacks: stacks.map((s) => s.key),
    waves: waves.map((w) => ({ name: w.name, stacks: w.stacks.map((s) => s.key) })),
    forge,
    todo,
    notes,
    buckets,
  };
}

/** chant.workspace.json: written when absent, merged when there, left alone as .jsonc (it is the person's). */
function declarationStep(root: string, detected: Detected, settings: ChantSettings, dryRun: boolean): InitFile {
  if (existsSync(join(root, "chant.workspace.jsonc"))) {
    return { file: "chant.workspace.jsonc", status: "kept", note: `add a member of kind pulumi for each of ${detected.projects.map((p) => p.dir).join(", ")}, and pin ${PULUMI_LEXICON}@${CHANT_PIN}` };
  }
  let existing: Record<string, unknown> | undefined;
  const file = join(root, DECLARATION_FILE);
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isObject(parsed)) throw new Error("not an object");
      existing = parsed;
    } catch (e) {
      return { file: DECLARATION_FILE, status: "failed", note: `is not JSON init can merge into (${(e as Error).message})` };
    }
  }
  const doc = workspaceDeclaration(existing, { name: repoName(root), projects: detected.projects, ci: settings.ci, lexiconVersion: CHANT_PIN });
  if (existing && JSON.stringify(existing) === JSON.stringify(doc)) return { file: DECLARATION_FILE, status: "unchanged" };
  return put(root, DECLARATION_FILE, jsonText(doc), dryRun);
}

/** `.pre-commit-config.yaml` as a check hook, so plywood check runs the team's hooks at the base commit. */
async function preCommitStep(root: string, config: string, dryRun: boolean): Promise<InitFile> {
  const write = await chantWriteCiHook();
  if (!write) {
    return { file: DECLARATION_FILE, status: "skipped", note: `${config} found; running it as a check hook needs chant >= the release after 0.124.54 (chant#4556's writeCiHook). This plywood was built with chant ${BUILT_CHANT}` };
  }
  if (dryRun || !existsSync(join(root, DECLARATION_FILE))) return { file: DECLARATION_FILE, status: "skipped", note: `${config} would run as the check hook pre-commit` };
  const before = readFileSync(join(root, DECLARATION_FILE), "utf8");
  try {
    write(root, "check", preCommitHook());
  } catch (e) {
    return { file: DECLARATION_FILE, status: "failed", note: `the pre-commit check hook: ${(e as Error).message}` };
  }
  const after = readFileSync(join(root, DECLARATION_FILE), "utf8");
  return { file: DECLARATION_FILE, status: after === before ? "unchanged" : "written", note: `${config} runs as the check hook pre-commit; the check job's image needs pre-commit` };
}

/** The waves spec with chant's names filled (chant `productWavesSpec`), else as plywood builds it. */
function wavesSpecStep(chant: ChantProduct, stacks: readonly InitStack[], doc: RawConfig, settings: ChantSettings, branch: string): Record<string, unknown> {
  const runner = waveRunner(chantPipelineOptions(settings.pipeline, false).runner);
  const base = wavesSpec({
    stacks,
    ...(settings.pipeline.waves ? { waves: settings.pipeline.waves } : {}),
    gate: gateOf(doc),
    branch,
    ...(runner !== undefined ? { runner } : {}),
    ...(settings.pipeline.quorum?.length ? { quorum: settings.pipeline.quorum } : {}),
  });
  return chant.productWavesSpec ? chant.productWavesSpec(base, PRODUCT_WORDS) : base;
}

/** The workflow, through chant's generator with plywood's words and the image and install lines (src/images.ts). */
async function workflowStep(
  chant: ChantProduct,
  root: string,
  doc: RawConfig,
  settings: ChantSettings,
  forge: ForgeKind,
  opts: InitOptions,
  spec: unknown,
): Promise<InitFile> {
  const output = WORKFLOW_FILE[forge];
  let plan;
  try {
    // The build takes no product engine lines over argv, so they go to --before-script.
    plan = workflowPlan(chant, doc, forge, opts.env, spec, chantBuildFlags(chantPipelineOptions(settings.pipeline, false)));
  } catch (e) {
    return { file: output, status: "failed", note: (e as Error).message };
  }
  if (opts.dryRun) return { file: output, status: "skipped", note: "--dry-run: chant's generator was not run" };
  const argv = plan.argv.map((a, i) => (i === 1 && a === "." ? root : a));
  const written = await writeWorkflow(chant, { root, forge, output, argv, words: plan.words });
  if (written.status === "failed") return { file: output, status: "failed", note: `chant's generator exited ${written.code}; the old file is back as it was` };
  return { file: output, status: written.status, ...(written.kept.length ? { note: `kept your own jobs: ${written.kept.join(", ")}` } : {}) };
}

/** The bucket check for each distinct self-managed backend; the lines to print. */
async function bucketStep(detected: Detected, doc: RawConfig, env: NodeJS.ProcessEnv, reports: BucketReport[]): Promise<string[]> {
  const listed = configuredStacks(doc);
  const urls = new Set<string>();
  for (const s of detected.stacks) {
    const project = detected.projects.find((p) => p.dir === s.dir && p.name === s.project) ?? { backendUrl: undefined };
    const b = backendOf(project, { ...(listed[s.key]?.backend ? { stack: listed[s.key]!.backend } : {}), ...(typeof doc.backend === "string" ? { all: doc.backend } : {}) }, env);
    if (b.url && !isPulumiCloud(b.url)) urls.add(b.url);
  }
  const targets = [...urls].map((u) => bucketTarget(u, env)).filter((t) => t !== undefined);
  if (targets.length === 0) return [];
  const check = await chantBucketCheck();
  if (!check) return [needsBucketCheckMessage(BUILT_CHANT)];
  const lines: string[] = ["State buckets:"];
  for (const t of targets) {
    if (!t.ok) {
      lines.push(`  ${t.label}: not checked; ${t.reason}`);
      continue;
    }
    try {
      const report = await check.checkBucket(t.target, { namespaces: t.namespaces });
      reports.push(report);
      lines.push(...bucketLines(report));
    } catch (e) {
      lines.push(`  ${t.label}: not checked; ${(e as Error).message}`);
    }
  }
  return lines;
}

/** The secrets and settings left for the person. */
function todoLines(detected: Detected, doc: RawConfig, forge: ForgeKind, env: NodeJS.ProcessEnv): string[] {
  const out: string[] = [];
  const pkg = join(detected.root, "package.json");
  const pkgText = existsSync(pkg) ? readFileSync(pkg, "utf8") : "";
  if (!pkgText.includes(`"${PULUMI_LEXICON}"`)) out.push(`npm i -D ${PULUMI_LEXICON}@${CHANT_PIN}, the chant lexicon that previews and updates Pulumi stacks`);
  const all = typeof doc.backend === "string" ? doc.backend : undefined;
  const cloud = detected.projects.some((p) => isPulumiCloud(backendOf(p, all ? { all } : {}, env).url));
  const where = forge === "gitlab" ? "CI/CD variables" : "repository secrets";
  if (cloud) out.push(`Add PULUMI_ACCESS_TOKEN_PREVIEW and PULUMI_ACCESS_TOKEN_UP to the ${where}: the preview job's token and the update job's token`);
  else out.push("Give the preview job and the update job their cloud access, each its own role through OIDC; the backend bucket's read and write go with them");
  out.push(`Make ${PRODUCT}/preview a required status on ${detected.defaultBranch}`);
  return out;
}

/** The text init prints for a result. */
export function initLines(r: InitResult): string[] {
  const out: string[] = [];
  out.push(`${PRODUCT} init: ${r.stacks.length} stack${r.stacks.length === 1 ? "" : "s"} on ${r.forge.kind} (${r.forge.because})`);
  for (const w of r.waves) out.push(`  wave ${w.name}: ${w.stacks.join(", ")}`);
  if (r.waves.length > 1) out.push(`  the first wave, ${r.waves[0]!.name}, is the canary`);
  out.push("Files:");
  for (const f of r.files) out.push(`  ${f.status.padEnd(9)} ${f.file}${f.note ? `: ${f.note}` : ""}`);
  if (r.notes.length) out.push(...r.notes.map((n) => (n.startsWith("  ") || n.endsWith(":") ? n : `- ${n}`)));
  if (r.todo.length) out.push("Left for you:", ...r.todo.map((t) => `  - ${t}`));
  return out;
}

/** `plywood init`, from the CLI. */
export async function init(args: string[], json: boolean, table: ExitTable, io: InitIo): Promise<number> {
  const parsed = parseInitArgs(args);
  if ("printPrompt" in parsed) {
    const prompt = template("agent-prompt.md").trimEnd();
    io.out(json ? JSON.stringify({ command: "init", ok: true, exitCode: table.done, prompt }) : prompt);
    return table.done;
  }
  if ("error" in parsed) {
    io.err(`${PRODUCT}: ${parsed.error}`);
    if (json) io.out(JSON.stringify({ command: "init", ok: false, exitCode: table.failed, error: parsed.error }));
    return table.failed;
  }
  const r = await runInit(parsed, table, json ? { ...io, ask: undefined } : io);
  if (json) io.out(JSON.stringify({ command: "init", ...r }));
  else for (const line of initLines(r)) (r.ok ? io.out : io.err)(line);
  return r.exitCode;
}
