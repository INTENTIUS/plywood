/**
 * The check and preview stages, and the workflow that runs them, on chant's
 * product pipeline (chant#4550). Every stage is chant's, run in process with
 * plywood's words (`runChantInProcess`, ruling C), so the statuses read
 * `plywood/preview/<stack>`, the note reads in stacks and previews, and an
 * exit code is chant's (chant#4553), passed through unchanged.
 *
 *   plywood check     plywood.yml, then chant's check stage: the
 *                     `ci.hooks.check` hooks at the base commit (chant#4556)
 *   plywood preview   chant's `components pr-plan` over the stacks the change
 *                     reaches, through the pulumi-up capability (chant#4541);
 *                     with --forge it posts the note and the statuses
 *   plywood ci        the workflow: productPipelineJobs checks the words
 *                     against the jobs, and chant's generator writes the file
 *                     with plywood's bin in every line
 *   plywood components|ci <sub>|run|lock|unlock ...
 *                     chant's own verbs, for the lines the generated jobs run
 *
 * Nothing here runs pulumi, plunge or git: chant does.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chantProduct, hasChant4607, hasChant4620, needsChantMessage, type ChantProduct, type ForgeKind, type ProductPipelineJobs } from "./chant-product";
import { toChantSettings } from "./chant-config";
import { hasChantApprovalStatus, hasChantPullRequestApprovalStatus, hasChantPrLoopFlags, hasChantRespond } from "./chant-next";
import { approvalOf } from "./config/approval";
import { configCheck } from "./config-check";
import { APPLY_REQUIRES, applyRequiresOf, applyWhenOf } from "./config/apply";
import { checkConfig, findConfig, loadConfig, type RawConfig } from "./config/index";
import { locksOf } from "./config/locks";
import { FORGES } from "./config/routing";
import type { ExitTable } from "./exit-codes";
import { writeWorkflow } from "./init/workflow";
import { chantReviewStacks, REVIEW_STACKS_NEED_CHANT } from "./review-stacks";
import { unwrapWavesSpec, wavesEngine, writeWaveJobs } from "./waves-workflow";
import { writeDriftJobs } from "./drift";
import { writeReviewJobs } from "./agents";
import { writeAgentJobs } from "./agent-jobs";
import { OP_NAME, PR_GATE, PRODUCT, PRODUCT_WORDS, wordsForJobs, type ChantCommand, type ProductWordsInput } from "./words";

export interface StageIo {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * chant's verbs the generated jobs run through plywood's bin, `query` and
 * `ledger` for reading the ledger (plywood#20), and `audit-log` for chant's
 * audit-log reads (chant#4632: `audit-log unrecorded` lists the cloud writes
 * no recorded update made). `ci` is chant's only with a subcommand, such as
 * `ci check-job`, the apply-job guard (chant#4624).
 */
export const CHANT_PASSTHROUGH = ["components", "run", "lock", "unlock", "query", "ledger", "audit-log"] as const;

/** Flags whose next argument is a value, for splitting a command line. */
const VALUED = new Set(["--base", "--pr", "--forge", "--env", "--output", "-o", "--stack", "--file", "--head", "--gate", "--branch", "--report-url", "--target"]);

/** One flag's value, and the arguments without the flag. */
export function takeFlag(args: string[], flag: string): { value?: string; rest: string[]; missing: boolean } {
  const at = args.indexOf(flag);
  if (at < 0) return { rest: args, missing: false };
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) return { rest: args, missing: true };
  return { value, rest: [...args.slice(0, at), ...args.slice(at + 2)], missing: false };
}

/** Positional arguments: those that are neither a flag nor a flag's value. */
export function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      if (VALUED.has(a)) i++;
      continue;
    }
    out.push(a);
  }
  return out;
}

export async function withChant(what: string, table: ExitTable, io: StageIo, run: (chant: ChantProduct) => Promise<number>): Promise<number> {
  const chant = await chantProduct();
  if (!chant) {
    io.err(`${PRODUCT}: ${needsChantMessage(what)}`);
    return table.failed;
  }
  return run(chant);
}

/** A chant verb a generated job runs through the bin: passed to chant unchanged, with plywood's words. */
export function passthrough(argv: string[], table: ExitTable, io: StageIo): Promise<number> {
  return withChant(`${PRODUCT} ${argv[0]}`, table, io, (chant) => chant.runChantInProcess(argv, PRODUCT_WORDS));
}

/**
 * `plywood check [--base <rev>] [<target>...] [--file <plywood.yml>] [--json]`.
 * plywood.yml first, then chant's check stage (`chant ci check`), which runs
 * the `ci.hooks.check` hooks the declaration at base names: the user's own
 * tools, such as a linter or pre-commit. A hook that fails exits with
 * chant's code. --base defaults to $BASE_SHA, as in a generated job.
 */
export async function check(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const file = takeFlag(args, "--file");
  if (file.missing) return usage("--file takes a path", table, io);
  const base = takeFlag(file.rest, "--base");
  if (base.missing) return usage("--base takes a commit", table, io);
  const r = configCheck(io.cwd, file.value);
  if (!r.ok) {
    for (const line of r.lines) io.err(line);
    return table.failed;
  }
  if (!json) for (const line of r.lines) io.err(line);
  const at = base.value ?? io.env.BASE_SHA;
  if (!at) return usage("check needs --base <rev>, the commit the change is measured from (or BASE_SHA); the hooks are read there, so a change cannot remove its own check", table, io);
  const targets = positionals(base.rest);
  const output = takeFlag(base.rest, "--output");
  const argv = ["ci", "check", "--base", at, ...targets, ...(output.value ? ["--output", output.value] : []), ...(json ? ["--json"] : [])];
  return withChant(`${PRODUCT} check's hooks`, table, io, (chant) => chant.runChantInProcess(argv, PRODUCT_WORDS));
}

/**
 * `plywood preview [<stack>] [--stack <stack>] [--base <rev>] [--pr <n>]
 * [--forge github|gitlab|forgejo] [--env <env>] [--no-status] [--json]`.
 * chant's `components pr-plan` with plywood's words: it previews the stacks
 * the change reaches and the ones that depend on them, writes the report
 * and the grouped note, and with --forge posts the note and one status per
 * stack (`plywood/preview/<stack>`). A stack narrows it to that workspace
 * member. --base and --pr default to $BASE_SHA and $PR_NUMBER.
 */
export async function preview(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  // --target <urn> goes to pr-plan as it is (chant#4620), repeatable; a chant before it refuses it below.
  const targeted = args.includes("--target");
  // --refresh and --target-dependents go to pr-plan as they are (chant#4627).
  if (args.includes("--target-dependents") && !targeted) return usage("--target-dependents widens a --target preview to the resources that depend on the targets; give a --target", table, io);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--target" && (args[i + 1] === undefined || args[i + 1]!.startsWith("-"))) return usage("--target takes a resource's URN", table, io);
  }
  const stackFlag = takeFlag(args, "--stack");
  if (stackFlag.missing) return usage("--stack takes a stack name", table, io);
  const base = takeFlag(stackFlag.rest, "--base");
  const pr = takeFlag(base.rest, "--pr");
  if (base.missing || pr.missing) return usage(`${base.missing ? "--base" : "--pr"} takes a value`, table, io);
  const named = positionals(pr.rest);
  if (named.length > 1 || (named.length === 1 && stackFlag.value)) return usage("preview takes one stack", table, io);
  const stack = stackFlag.value ?? named[0];
  const at = base.value ?? io.env.BASE_SHA;
  const number = pr.value ?? io.env.PR_NUMBER;
  if (!at) return usage("preview needs --base <rev>, the target branch's commit (or BASE_SHA)", table, io);
  if (!number) return usage("preview needs --pr <n>, the pull request its approval is recorded under (or PR_NUMBER)", table, io);
  // A --target value is an address, never the stack: keep it out of the positionals.
  const targetValues = new Set(pr.rest.filter((_, i) => pr.rest[i - 1] === "--target"));
  const rest = pr.rest.filter((a) => a !== stack || targetValues.has(a));
  const gate = rest.includes("--gate") ? [] : ["--gate", PR_GATE];
  const argv = ["components", "pr-plan", "--base", at, "--pr", number, ...gate, ...(stack ? ["--member", stack] : []), ...rest, ...(json ? ["--json"] : [])];
  return withChant(`${PRODUCT} preview`, table, io, async (chant) => {
    if (targeted && !hasChant4620(chant)) return usage(PREVIEW_TARGET_NEEDS_CHANT, table, io);
    return chant.runChantInProcess(argv, PRODUCT_WORDS);
  });
}

/** What `plywood preview --target` says on a chant without chant#4620. */
export const PREVIEW_TARGET_NEEDS_CHANT = "--target needs a chant whose pr-plan passes it to the pulumi-up step (chant#4620), which this chant lacks";

/** Where `plywood ci` writes the workflow for each forge. */
export const WORKFLOW_FILE: Readonly<Record<ForgeKind, string>> = {
  github: ".github/workflows/plywood.yml",
  forgejo: ".forgejo/workflows/plywood.yml",
  gitlab: ".gitlab-ci.yml",
};

/** The waves spec the merge applies, `.chant/op-waves/pulumi-up.spec.json`, when the repository has one. */
export function readWavesSpec(cwd: string): unknown {
  const file = join(cwd, ".chant/op-waves", `${OP_NAME}.spec.json`);
  return existsSync(file) ? unwrapWavesSpec(JSON.parse(readFileSync(file, "utf8"))) : undefined;
}

/** What the pipeline has jobs for, from plywood.yml and the forge. */
export function pipelineShape(doc: RawConfig, forge: ForgeKind, waves: unknown): { jobs: ChantCommand[]; applyBeforeMerge: boolean; waves: boolean; locks?: "plan" } {
  const applyBeforeMerge = applyWhenOf(doc) === "pull-request";
  // chant's lock and unlock jobs are GitHub and Forgejo only.
  const locks = locksOf(doc).when === "preview" && forge !== "gitlab" ? ("plan" as const) : undefined;
  // An update before merge applies the pull request's preview in one job, so nothing applies on merge.
  const onMerge = !applyBeforeMerge && waves !== undefined;
  const jobs: ChantCommand[] = ["plan"];
  if (applyBeforeMerge || onMerge) jobs.push("apply");
  if (locks) jobs.push("lock", "unlock");
  return { jobs, applyBeforeMerge, waves: onMerge, ...(locks ? { locks } : {}) };
}

/**
 * `plywood ci [--forge github|gitlab|forgejo] [--env <env>] [--output <file>]
 * [--dry-run] [--json]`: the pull request workflow. productPipelineJobs
 * (chant#4550) checks plywood's words against the jobs the pipeline has
 * and names them; chant's generator (`build --components --generate
 * <forge> --pr-loop`) writes the file, run in process with the words, so
 * every line runs `npx --no-install plywood` and answers `/plywood`
 * comments. --dry-run prints the jobs and writes nothing.
 */
export async function ci(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const forgeFlag = takeFlag(args, "--forge");
  const envFlag = takeFlag(forgeFlag.rest, "--env");
  const outFlag = takeFlag(envFlag.rest, "--output");
  if (forgeFlag.missing || envFlag.missing || outFlag.missing) return usage("--forge, --env and --output each take a value", table, io);
  const extra = outFlag.rest.filter((a) => a !== "--dry-run");
  if (extra.length) return usage(`ci does not take ${extra.join(" ")}`, table, io);
  const dryRun = outFlag.rest.includes("--dry-run");

  const path = findConfig(io.cwd);
  if (!path) return usage(`no plywood.yml in ${io.cwd} or above it; run '${PRODUCT} init' first`, table, io);
  const config = loadConfig(path);
  const errors = checkConfig(config).filter((p) => p.severity === "error");
  if (errors.length) {
    for (const p of errors) io.err(`${path}: ${p.key} ${p.message}`);
    return table.failed;
  }
  const configured = (config.doc.forge as { kind?: string } | undefined)?.kind;
  const forge = (forgeFlag.value ?? configured ?? "github") as ForgeKind;
  if (!(FORGES as readonly string[]).includes(forge)) return usage(`--forge ${forge} is not one of ${FORGES.join(", ")}`, table, io);
  const env = envFlag.value ?? "production";
  const output = outFlag.value ?? WORKFLOW_FILE[forge];

  return withChant(`${PRODUCT} ci`, table, io, async (chant) => {
    const reviewStacks = await chantReviewStacks();
    if (config.doc.review_stacks !== undefined && !reviewStacks) io.err(`${PRODUCT}: ${REVIEW_STACKS_NEED_CHANT}`);
    if (applyWhenOf(config.doc) === "pull-request") {
      const note = requiresNotHonoured(chant, config.doc);
      if (note) io.err(`${PRODUCT}: ${note}`);
    }
    let waves: unknown;
    try {
      waves = readWavesSpec(io.cwd);
    } catch (e) {
      return usage(`.chant/op-waves/${OP_NAME}.spec.json: ${(e as Error).message}`, table, io);
    }
    // plywood#29: env, pass, parallelism and environments on the waves, and on the pull request jobs with chant#4625.
    const pipeline = toChantSettings(config).pipeline;
    const { prJobsFor, hasChant4625, withJobSettings } = await import("./jobs");
    const prJobs = await prJobsFor(pipeline);
    for (const note of prJobs.notes) io.err(`${PRODUCT}: ${note}`);
    if (waves !== undefined && pipeline.jobs) {
      try {
        waves = withJobSettings(waves as Record<string, unknown>, pipeline.jobs, forge, { parallelism: await hasChant4625() });
      } catch (e) {
        io.err(`${PRODUCT}: ${(e as Error).message}`);
        return table.failed;
      }
    }
    // plywood#28: with a control repo, the note job reads its records for the cross-stack edges (chant#4619).
    const { noteControlTarget } = await import("./control");
    const noteControl = await noteControlTarget(config.doc, io.cwd);
    let plan: WorkflowPlan;
    try {
      plan = workflowPlan(chant, config.doc, forge, env, waves, [], { reviewStacks, prJobs, ...(noteControl ? { control: noteControl } : {}) });
    } catch (e) {
      io.err(`${PRODUCT}: ${(e as Error).message}`);
      return table.failed;
    }
    const { jobs } = plan;
    for (const note of plan.notes) io.err(`${PRODUCT}: ${note}`);
    // The control repo (plywood#18): with chant#4617 the waves spec takes plywood.yml's control, and chant's
    // generator adds the job that tells the control repo how the waves ended. Before it, a job of your own does.
    const { wavesControl } = await import("./control");
    const control = jobs.waves ? await wavesControl(io.cwd) : ({ none: true } as const);
    if ("error" in control) {
      io.err(`${PRODUCT}: control: ${control.error}`);
      return table.failed;
    }
    const waveJobs = jobs.waves && "control" in control ? { ...jobs.waves, spec: { ...(jobs.waves.spec as Record<string, unknown>), control: control.control } } : jobs.waves;
    const summary = {
      forge,
      env,
      output,
      plan: jobs.plan.command,
      post: jobs.post.command,
      ...(jobs.record ? { record: jobs.record.command } : {}),
      ...(jobs.applyBeforeMerge ? { applyBeforeMerge: jobs.applyBeforeMerge.command } : {}),
      comments: jobs.comments,
      ...(jobs.waves ? { waves: { specFile: jobs.waves.specFile, jobs: jobs.waves.jobs.map((j) => j.command.join(" ")) } } : {}),
      ...("control" in control ? { control: control.repo } : {}),
    };
    if (json && dryRun) io.out(JSON.stringify({ command: "ci", ok: true, exitCode: table.done, dryRun, ...summary }));
    else if (!json) {
      io.err(`${PRODUCT} ci: ${forge} workflow at ${output}, env ${env}`);
      io.err(`  preview   ${summary.plan}`);
      io.err(`  note      ${summary.post}`);
      if (summary.record) io.err(`  record    ${summary.record}`);
      if (summary.applyBeforeMerge) io.err(`  up        ${summary.applyBeforeMerge}`);
      if (plan.jobs.post.control) io.err(`  note      reads the control repo's records first, for the cross-stack edges`);
      for (const [command, line] of Object.entries(jobs.comments)) io.err(`  comment   ${line} (${command})`);
      for (const job of summary.waves?.jobs ?? []) io.err(`  wave      ${job}`);
      if (jobs.stale) io.err(`  stale     ${jobs.stale.command} (on each push to the target branch)`);
    }
    if (!json && "control" in control) io.err(`  control   after the last wave, tells ${control.repo} how the waves ended`);
    else if (!json && "missing" in control) io.err(`  control   the waves workflow sends no dispatch: ${control.missing}; a job of your own after the last wave runs '${PRODUCT} control dispatch'`);
    if (dryRun) return table.done;
    // The pull request workflow answers /plywood up only when it updates before merge; the waves run on merge in their own workflow.
    const written = await writeWorkflow(chant, { root: io.cwd, forge, output, argv: plan.argv, words: plan.prWords, noteControl: plan.jobs.post.control });
    if (!json && written.kept.length) io.err(`  kept your own jobs: ${written.kept.join(", ")}`);
    if (written.code === table.done) for (const note of writtenNotes(plan, written.file)) io.err(`${PRODUCT}: ${note}`);
    if (json) io.out(JSON.stringify({ command: "ci", ok: written.code === 0, exitCode: written.code, dryRun, ...summary, status: written.status, kept: written.kept }));
    if (written.code !== table.done) {
      if (!json) io.err(`${PRODUCT} ci: chant's generator exited ${written.code} and wrote no ${output}; any file there before is back as it was`);
      return written.code;
    }
    const wavesCode = waveJobs ? await writeWaveJobs(chant, forge, waveJobs, plan.words, table, io, wavesEngine(toChantSettings(config).pipeline)) : table.done;
    if (wavesCode !== table.done) return wavesCode;
    // The scheduled drift jobs, when plywood.yml sets drift.schedule (plywood#8).
    const driftCode = await writeDriftJobs(chant, forge, config.doc, plan.words, table, io, env);
    if (driftCode !== table.done) return driftCode;
    // The review agent's jobs, when plywood.yml sets review (plywood#19).
    const reviewCode = await writeReviewJobs(chant, forge, config.doc, plan.words, table, io);
    if (reviewCode !== table.done) return reviewCode;
    // The agent's jobs, when plywood.yml sets agent.comment (plywood#19, chant#4616).
    return writeAgentJobs(chant, forge, env, config.doc, plan.words, table, io);
  });
}

/** What a workflow is generated from: the jobs chant names for the words, and the build argv (without --output). */
export interface WorkflowPlan {
  jobs: ProductPipelineJobs;
  /** The words for every job, the waves' included. */
  words: ProductWordsInput;
  /** The words of the pull request workflow: without `/plywood up` unless it updates before merge. */
  prWords: ProductWordsInput;
  argv: string[];
  /** What plywood.yml asks that this chant does not give the jobs, one line each. */
  notes: string[];
  /** The merge after an update before merge plywood asked chant's generator for (chant#4636). */
  applyMerge?: { tokenEnv: string; method?: string };
}

/**
 * Lines about the file chant's generator wrote: the merge after an update
 * before merge when `apply.merge: auto` asked for it and the file carries
 * none, since chant's `build --pr-loop` maps no merge flags before it does.
 */
export function writtenNotes(plan: Pick<WorkflowPlan, "applyMerge">, file: string): string[] {
  if (!plan.applyMerge || !existsSync(file) || readFileSync(file, "utf8").includes("--merge-token-env")) return [];
  return [`apply.merge is auto, and chant's generator wrote the update before merge without the merge, so a person still merges after /${PRODUCT} up in CI; '${PRODUCT} up --pr <n>' run by hand merges`];
}

/**
 * The jobs and chant's build argv for plywood.yml on `forge`, shared by
 * `plywood ci` and `plywood init`. productPipelineJobs checks the words
 * against the jobs and throws when they disagree. `extra` goes on the build
 * line (`--image`, `--before-script`, from src/images.ts).
 */
export function workflowPlan(
  chant: ChantProduct,
  doc: RawConfig,
  forge: ForgeKind,
  env: string,
  waves: unknown,
  extra: string[] = [],
  opts: { reviewStacks?: boolean; control?: unknown; prJobs?: { options: Record<string, unknown>; flags: string[] } } = {},
): WorkflowPlan {
  const shape = pipelineShape(doc, forge, waves);
  const notes: string[] = [];
  const pipeline = toChantSettings({ doc }).pipeline;
  // chant#4629: the responses to a refused wave, a failed update and the description.
  const respond = respondOptions(chant, pipeline, shape.applyBeforeMerge, notes);
  // chant#4636: apply.merge: auto merges after the update before merge.
  const applyMerge = shape.applyBeforeMerge ? pipeline.applyMerge : undefined;
  // chant#4630: a chant that posts plywood/approval only for pr-review waves gets the note, since plywood's waves approve
  // through the pull request (ruling B). From APPROVAL_STATUS_PULL_REQUEST_FLOOR chant posts it for those waves too.
  if (approvalOf(doc) === "pr-review" && shape.waves && hasChantApprovalStatus(chant) && !hasChantPullRequestApprovalStatus(chant)) notes.push(APPROVAL_STATUS_NOTE);
  const words = wordsForJobs(shape.jobs);
  // chant#4607: apply.requires reaches pr-apply --before-merge as --requires; before it, all four checks are asked.
  const requires = shape.applyBeforeMerge ? requiresArgv(chant, doc) : [];
  // chant#4620: `/plywood preview` previews the pull request again, once the installed chant has the job.
  const previewComment = hasChant4620(chant);
  const jobs = chant.productPipelineJobs(forge, env, {
    words,
    ...(shape.applyBeforeMerge ? { applyBeforeMerge: true } : {}),
    ...(shape.locks ? { locks: shape.locks } : {}),
    ...(shape.waves ? { waves } : {}),
    ...(requires.length ? { applyRequires: requires[1]!.split(",") } : {}),
    ...(previewComment ? { previewComment: true } : {}),
    // chant#4619: the note job's read of the control repo comes back as post.control.
    ...(opts.control !== undefined ? { control: { target: opts.control } } : {}),
    // plywood#29: runners, env, pass and parallelism on the pull request jobs, with chant#4625 (src/jobs.ts).
    ...(opts.prJobs?.options ?? {}),
    // chant#4628: the note names the target commit it was previewed against, and a push marks older notes stale.
    staleNotes: true,
    ...respond.options,
    ...(applyMerge ? { applyMerge } : {}),
  });
  const prWords = shape.applyBeforeMerge ? words : wordsForJobs(shape.jobs.filter((j) => j !== "apply"));
  const argv = [
    "build", ".", "--components", "--generate", forge, "--pr-loop", "--env", env, "--gate", jobs.words.prGate,
    ...(shape.applyBeforeMerge ? ["--apply-before-merge", ...requires] : []),
    ...(applyMerge ? applyMergeArgv(applyMerge) : []),
    ...respond.argv,
    ...(previewComment ? ["--preview-comment"] : []),
    "--stale-notes",
    // Review stacks (plywood#15): chant's pr-env jobs, only once the pulumi lexicon can remove what they create.
    ...(doc.review_stacks !== undefined && opts.reviewStacks ? ["--pr-env"] : []),
    ...(opts.prJobs?.flags ?? []),
    ...extra,
  ];
  return { jobs, words, prWords, argv, notes, ...(applyMerge ? { applyMerge } : {}) };
}

/** What plywood ci says under approval: pr-review on a chant with chant#4630 and without its pull-request floor. */
export const APPROVAL_STATUS_NOTE =
  `approval is pr-review, and chant posts its approval status only for waves that wait on pr-review; plywood's waves wait on the pull request's own approval, so no ${PRODUCT}/approval status is posted before merge`;

/** `pr-apply --merge auto` and its token variable and method (chant#4636). */
export function applyMergeArgv(m: { tokenEnv: string; method?: string }): string[] {
  return ["--merge", "auto", "--merge-token-env", m.tokenEnv, ...(m.method ? ["--merge-method", m.method] : [])];
}

/** chant's responses at their defaults (`CI_RESPOND_DEFAULTS`), in chant's event order; `--respond` lists only the others. */
export const CHANT_RESPOND_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({ "wave-refused": "diff", "apply-failed": "triage", description: "off" });

/** What plywood ci says when the decide service is set and respond.description is not check. */
export const DECIDE_LEFT_OFF = "decide is set and respond.description is not check, so plywood leaves the decide service off the pull request jobs";

/**
 * chant's `respond` and `decide` for plywood.yml's respond keys (chant#4629),
 * on a chant that has them, and the `build --pr-loop` flags that carry them
 * into the pull request jobs. chant puts the waves' part on the waves spec,
 * which plywood writes. With `PR_LOOP_BUILD_FLAGS_FLOOR` the build takes
 * `--respond <list>` and, only with `description=check`, `--decide-backend`
 * and `--decide-model`; chant refuses the decide flags without the check, so
 * plywood leaves them off then and says so, as its config check warns.
 * Before the floor the pull request jobs keep chant's defaults, and `notes`
 * says which keys that leaves out.
 */
export function respondOptions(
  chant: ChantProduct,
  pipeline: { respond?: Record<string, string>; decide?: { backend: string; model: string } },
  applyBeforeMerge: boolean,
  notes: string[],
): { options: { respond?: Record<string, string>; decide?: { backend: string; model: string } }; argv: string[] } {
  const r = pipeline.respond;
  if (pipeline.decide && r?.description !== "check") notes.push(DECIDE_LEFT_OFF);
  if (!r || Object.keys(r).length === 0) return { options: {}, argv: [] };
  const keys = Object.keys(r).map((e) => e.replace("-", "_"));
  if (!hasChantRespond(chant)) {
    notes.push(`respond.${keys.join(", respond.")} ${keys.length === 1 ? "needs" : "need"} chant's responses to pipeline events (chant#4629), which this chant lacks; chant's defaults hold`);
    return { options: {}, argv: [] };
  }
  const responses = { ...r };
  const check = responses.description === "check";
  const decide = check ? pipeline.decide : undefined;
  if (check && !decide) {
    // chant refuses description=check without its service; plywood's config check makes this an error first.
    delete responses.description;
    notes.push("respond.description is check and decide names no backend and model, so the description check is left off");
  }
  const options = { respond: responses, ...(decide ? { decide: { ...decide } } : {}) };
  if (hasChantPrLoopFlags(chant)) return { options, argv: respondArgv(responses, decide) };
  const prSide = [
    ...(responses.description === "check" ? ["respond.description"] : []),
    ...(applyBeforeMerge && responses["apply-failed"] === "off" ? ["respond.apply_failed"] : []),
    ...(applyBeforeMerge && responses["wave-refused"] === "off" ? ["respond.wave_refused"] : []),
  ];
  if (prSide.length) notes.push(`${prSide.join(", ")} ${prSide.length === 1 ? "reaches" : "reach"} no pull request job yet: chant's build --pr-loop writes no responses into them, so the note and the update before merge keep chant's defaults; the waves workflow takes wave_refused and apply_failed`);
  return { options, argv: [] };
}

/**
 * `--respond <list>` for the responses away from chant's defaults, and the
 * decide flags with `description=check` only (chant's `prLoopFlagsProblem`
 * refuses them otherwise).
 */
export function respondArgv(responses: Readonly<Record<string, string>>, decide: { backend: string; model: string } | undefined): string[] {
  const list = Object.keys(CHANT_RESPOND_DEFAULTS)
    .filter((e) => responses[e] !== undefined && responses[e] !== CHANT_RESPOND_DEFAULTS[e])
    .map((e) => `${e}=${responses[e]}`)
    .join(",");
  const check = responses.description === "check" && decide !== undefined;
  return [...(list ? ["--respond", list] : []), ...(check ? ["--decide-backend", decide.backend, "--decide-model", decide.model] : [])];
}

/**
 * `--requires <list>` for `pr-apply --before-merge` and the build that writes
 * its job (chant#4607), when plywood.yml's apply.requires names fewer than
 * the four checks and the installed chant takes the flag. Empty otherwise:
 * all four are chant's default, and a chant before chant#4607 asks all four
 * whatever plywood.yml lists ({@link requiresNotHonoured} says so).
 */
export function requiresArgv(chant: ChantProduct, doc: RawConfig): string[] {
  const listed = applyRequiresOf(doc);
  if (listed.length === APPLY_REQUIRES.length || !hasChant4607(chant)) return [];
  const parsed = chant.parseRequiresList!(listed);
  return "checks" in parsed ? ["--requires", parsed.checks.join(",")] : [];
}

/** The line a chant without `--requires` gets when plywood.yml lists fewer checks, or undefined. */
export function requiresNotHonoured(chant: ChantProduct, doc: RawConfig): string | undefined {
  const listed = applyRequiresOf(doc);
  if (listed.length === APPLY_REQUIRES.length || hasChant4607(chant)) return undefined;
  return `apply.requires lists ${listed.join(", ")}, and the installed chant has no pr-apply --requires (chant#4607), so the update before merge asks all four checks: ${APPLY_REQUIRES.join(", ")}`;
}

export function usage(message: string, table: ExitTable, io: StageIo): number {
  // A usage error is chant's `failed`, 1 (chant#4553 ruling C).
  io.err(`${PRODUCT}: ${message}`);
  return table.failed;
}
