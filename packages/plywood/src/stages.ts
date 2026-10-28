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
import { chantProduct, needsChantMessage, type ChantProduct, type ForgeKind, type ProductPipelineJobs } from "./chant-product";
import { configCheck } from "./config-check";
import { applyWhenOf } from "./config/apply";
import { checkConfig, findConfig, loadConfig, type RawConfig } from "./config/index";
import { locksOf } from "./config/locks";
import { FORGES } from "./config/routing";
import type { ExitTable } from "./exit-codes";
import { writeWorkflow } from "./init/workflow";
import { chantReviewStacks, REVIEW_STACKS_NEED_CHANT } from "./review-stacks";
import { writeWaveJobs } from "./waves-workflow";
import { writeDriftJobs } from "./drift";
import { OP_NAME, PR_GATE, PRODUCT, PRODUCT_WORDS, wordsForJobs, type ChantCommand, type ProductWordsInput } from "./words";

export interface StageIo {
  out: (s: string) => void;
  err: (s: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/** chant's verbs the generated jobs run through plywood's bin, and `query` and `ledger` for reading the ledger (plywood#20). `ci` is chant's only with a subcommand. */
export const CHANT_PASSTHROUGH = ["components", "run", "lock", "unlock", "query", "ledger"] as const;

/** Flags whose next argument is a value, for splitting a command line. */
const VALUED = new Set(["--base", "--pr", "--forge", "--env", "--output", "-o", "--stack", "--file", "--head", "--gate", "--branch", "--report-url"]);

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
  for (const flag of ["--target", "--refresh"]) {
    if (args.includes(flag)) {
      return usage(`${flag} needs chant's pr-plan to pass it to the pulumi-up step, which no chant release has yet`, table, io);
    }
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
  const rest = pr.rest.filter((a) => a !== stack);
  const gate = rest.includes("--gate") ? [] : ["--gate", PR_GATE];
  const argv = ["components", "pr-plan", "--base", at, "--pr", number, ...gate, ...(stack ? ["--member", stack] : []), ...rest, ...(json ? ["--json"] : [])];
  return withChant(`${PRODUCT} preview`, table, io, (chant) => chant.runChantInProcess(argv, PRODUCT_WORDS));
}

/** Where `plywood ci` writes the workflow for each forge. */
export const WORKFLOW_FILE: Readonly<Record<ForgeKind, string>> = {
  github: ".github/workflows/plywood.yml",
  forgejo: ".forgejo/workflows/plywood.yml",
  gitlab: ".gitlab-ci.yml",
};

/** The waves spec the merge applies, `.chant/op-waves/pulumi-up.spec.json`, when the repository has one. */
export function readWavesSpec(cwd: string): unknown {
  const file = join(cwd, ".chant/op-waves", `${OP_NAME}.spec.json`);
  return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
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
    let waves: unknown;
    try {
      waves = readWavesSpec(io.cwd);
    } catch (e) {
      return usage(`.chant/op-waves/${OP_NAME}.spec.json: ${(e as Error).message}`, table, io);
    }
    let plan: WorkflowPlan;
    try {
      plan = workflowPlan(chant, config.doc, forge, env, waves, [], { reviewStacks });
    } catch (e) {
      io.err(`${PRODUCT}: ${(e as Error).message}`);
      return table.failed;
    }
    const { jobs } = plan;
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
    };
    if (json && dryRun) io.out(JSON.stringify({ command: "ci", ok: true, exitCode: table.done, dryRun, ...summary }));
    else if (!json) {
      io.err(`${PRODUCT} ci: ${forge} workflow at ${output}, env ${env}`);
      io.err(`  preview   ${summary.plan}`);
      io.err(`  note      ${summary.post}`);
      if (summary.record) io.err(`  record    ${summary.record}`);
      if (summary.applyBeforeMerge) io.err(`  up        ${summary.applyBeforeMerge}`);
      for (const [command, line] of Object.entries(jobs.comments)) io.err(`  comment   ${line} (${command})`);
      for (const job of summary.waves?.jobs ?? []) io.err(`  wave      ${job}`);
    }
    // The control repo (plywood#18): chant's op waves take no control option yet, so the waves workflow sends no dispatch.
    if (config.doc.control !== undefined && !json) io.err(`  control   the waves workflow sends no dispatch yet; a job of your own after the last wave runs '${PRODUCT} control dispatch'`);
    if (dryRun) return table.done;
    // The pull request workflow answers /plywood up only when it updates before merge; the waves run on merge in their own workflow.
    const written = await writeWorkflow(chant, { root: io.cwd, forge, output, argv: plan.argv, words: plan.prWords });
    if (!json && written.kept.length) io.err(`  kept your own jobs: ${written.kept.join(", ")}`);
    if (json) io.out(JSON.stringify({ command: "ci", ok: written.code === 0, exitCode: written.code, dryRun, ...summary, status: written.status, kept: written.kept }));
    if (written.code !== table.done) return written.code;
    const wavesCode = jobs.waves ? await writeWaveJobs(chant, forge, jobs.waves, plan.words, table, io) : table.done;
    if (wavesCode !== table.done) return wavesCode;
    // The scheduled drift jobs, when plywood.yml sets drift.schedule (plywood#8).
    return writeDriftJobs(chant, forge, config.doc, plan.words, table, io);
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
}

/**
 * The jobs and chant's build argv for plywood.yml on `forge`, shared by
 * `plywood ci` and `plywood init`. productPipelineJobs checks the words
 * against the jobs and throws when they disagree. `extra` goes on the build
 * line (`--image`, `--before-script`, from src/images.ts).
 */
export function workflowPlan(chant: ChantProduct, doc: RawConfig, forge: ForgeKind, env: string, waves: unknown, extra: string[] = [], opts: { reviewStacks?: boolean } = {}): WorkflowPlan {
  const shape = pipelineShape(doc, forge, waves);
  const words = wordsForJobs(shape.jobs);
  const jobs = chant.productPipelineJobs(forge, env, {
    words,
    ...(shape.applyBeforeMerge ? { applyBeforeMerge: true } : {}),
    ...(shape.locks ? { locks: shape.locks } : {}),
    ...(shape.waves ? { waves } : {}),
  });
  const prWords = shape.applyBeforeMerge ? words : wordsForJobs(shape.jobs.filter((j) => j !== "apply"));
  const argv = [
    "build", ".", "--components", "--generate", forge, "--pr-loop", "--env", env, "--gate", jobs.words.prGate,
    ...(shape.applyBeforeMerge ? ["--apply-before-merge"] : []),
    // Review stacks (plywood#15): chant's pr-env jobs, only once the pulumi lexicon can remove what they create.
    ...(doc.review_stacks !== undefined && opts.reviewStacks ? ["--pr-env"] : []),
    ...extra,
  ];
  return { jobs, words, prWords, argv };
}

export function usage(message: string, table: ExitTable, io: StageIo): number {
  // A usage error is chant's `failed`, 1 (chant#4553 ruling C).
  io.err(`${PRODUCT}: ${message}`);
  return table.failed;
}
