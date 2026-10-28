/**
 * `plywood approve`, `plywood override` and `plywood up`, on chant's gates
 * and op waves (chant#4550, #4541, #4545, #4551, #4552, #4553). Each maps
 * onto one chant command line run in process with plywood's words, so every
 * approval, override and update is a row on chant's workspace ledger and
 * plywood writes nothing to git itself.
 *
 *   plywood approve <gate> --plan <digest>
 *       chant approve <op> <gate> --plan <digest>. The gate `up` is the pull
 *       request's, recorded under op pr-<n> (pr-<n>-<stack> for one stack);
 *       a wave gate `wave-<k>` is recorded under op pulumi-up, and the gate
 *       `review` is a review stack's (plywood#15), chant's pr-env under op
 *       pr-<n>. At a terminal
 *       chant shows the plan and asks for the target's name before it
 *       records anything (chant#4575); --yes skips the question.
 *   plywood override <stack> --rule <id>... --reason <text>
 *       chant approve policy-override <stack> --rule <id>... --reason <text>,
 *       an approval of the denial's override digest, spent once the update
 *       it lets through runs.
 *   plywood up [--wave <k>] [--decide | --share <i> | --group <name>]
 *       chant run wave --spec .chant/op-waves/pulumi-up.spec.json --wave <k>,
 *       the command each generated wave job runs. Each run applies through
 *       the spec's pulumi-up step (chant#4541). With no --wave, the waves run
 *       in order and stop at the first that does not finish.
 *   plywood up --pr <n>
 *       an update before merge, as /plywood up runs it: chant components
 *       pr-apply --before-merge, only under apply.when: pull-request.
 *
 * A refusal keeps chant's exit code and adds the plywood command that
 * clears it (./refusals.ts).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMergeOf, applyWhenOf } from "./config/apply";
import { chantNext, hasChantPullRequestApprovalStatus } from "./chant-next";
import type { RawConfig } from "./config/types";
import { checkConfig, findConfig, loadConfig } from "./config/index";
import { FORGES } from "./config/routing";
import type { ExitTable } from "./exit-codes";
import { explainRefusal } from "./refusals";
import { hasChant4607, type ChantProduct, type PendingGateByPlan } from "./chant-product";
import { REVIEW_GATE, REVIEW_GATE_WORD, reviewOp } from "./review-stacks";
import { APPLY_MERGE_NEEDS_CHANT, applyMergeArgv, positionals, requiresArgv, requiresNotHonoured, takeFlag, usage, withChant, type StageIo } from "./stages";
import { OP_NAME, PR_GATE, PRODUCT, PRODUCT_WORDS } from "./words";
import { unwrapWavesSpec } from "./waves-workflow";

/** chant's op for policy overrides (`OVERRIDE_GATE_OP`, chant op/gate-name.ts). */
export const OVERRIDE_OP = "policy-override";

/** The waves spec `plywood up` runs: `.chant/op-waves/pulumi-up.spec.json`, as chant's `productWavesSpecFile` names it. */
export const WAVES_SPEC_FILE = `.chant/op-waves/${OP_NAME}.spec.json`;

/** The capability step every run of a plywood wave applies through (chant#4541, #4545). */
export const UP_STEP_KIND = "pulumi-up";

const PR_OP = /^pr-(\d+)(?:-([a-z0-9][a-z0-9-]*))?$/;

/** chant's op and gate for what a person typed after `plywood approve`. */
export function approveTarget(
  gate: string,
  opts: { pr?: string; stack?: string; op?: string },
): { op: string; gate: string } | { error: string } {
  if (opts.op) return { op: opts.op, gate };
  // `plywood approve pr-12` names the pull request's op; its gate is `up`.
  if (PR_OP.test(gate)) return { op: gate, gate: PR_GATE };
  // `plywood approve review --pr 12`: the review stack's update, chant's gate pr-env under op pr-12 (plywood#15).
  if (gate === REVIEW_GATE_WORD || gate === REVIEW_GATE) {
    if (!opts.pr) return { error: `a review stack is a pull request's: name it with --pr <n> (or PR_NUMBER)` };
    if (!/^\d+$/.test(opts.pr)) return { error: `--pr takes a pull request number, not '${opts.pr}'` };
    return { op: reviewOp(opts.pr), gate: REVIEW_GATE };
  }
  if (gate === PR_GATE) {
    if (!opts.pr) return { error: `the ${PR_GATE} gate is a pull request's: name it with --pr <n> (or PR_NUMBER), or approve pr-<n>` };
    if (!/^\d+$/.test(opts.pr)) return { error: `--pr takes a pull request number, not '${opts.pr}'` };
    return { op: opts.stack ? `pr-${opts.pr}-${opts.stack}` : `pr-${opts.pr}`, gate };
  }
  // A wave gate, wave-<k>, and any other gate of the merge's waves are recorded under the op.
  return { op: OP_NAME, gate };
}

/** Flags chant's approve takes, passed through as typed. */
const APPROVE_PASS = ["--plan", "--approver", "--actor", "--note", "--url", "--env", "--roles", "--relayed-by"] as const;
const APPROVE_SWITCHES = ["--sign", "--yes", "--expire", "--allow-same-origin", "--resume"] as const;

function passFlags(args: string[], valued: readonly string[], switches: readonly string[]): { argv: string[]; rest: string[]; missing?: string } {
  const argv: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return { argv, rest, missing: a };
      argv.push(a, v);
      i++;
    } else if (switches.includes(a)) argv.push(a);
    else rest.push(a);
  }
  return { argv, rest };
}

/**
 * `plywood approve <gate> [--plan <digest>] [--pr <n>] [--stack <stack>]
 * [--op <op>] [--approver <name>] [--note <text>] [--sign] [--yes]
 * [--expire] [--json]`.
 */
export async function approve(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const pr = takeFlag(args, "--pr");
  const stack = takeFlag(pr.rest, "--stack");
  const op = takeFlag(stack.rest, "--op");
  const forgeFlag = takeFlag(op.rest, "--forge");
  const branchFlag = takeFlag(forgeFlag.rest, "--branch");
  for (const [flag, f] of [["--pr", pr], ["--stack", stack], ["--op", op], ["--forge", forgeFlag], ["--branch", branchFlag]] as const) {
    if (f.missing) return usage(`${flag} takes a value`, table, io);
  }
  if (forgeFlag.value !== undefined && !(FORGES as readonly string[]).includes(forgeFlag.value)) return usage(`--forge ${forgeFlag.value} is not one of ${FORGES.join(", ")}`, table, io);
  const passed = passFlags(branchFlag.rest, APPROVE_PASS, APPROVE_SWITCHES);
  if (passed.missing) return usage(`${passed.missing} takes a value`, table, io);
  const named = positionals(passed.rest);
  const unknown = passed.rest.filter((a) => a.startsWith("-"));
  if (unknown.length) return usage(`approve does not take ${unknown.join(" ")}`, table, io);
  if (named.length !== 1) return usage(`approve takes one gate: '${PRODUCT} approve ${PR_GATE} --pr <n> --plan <digest>' or '${PRODUCT} approve wave-<k> --plan <digest>'`, table, io);
  const prNumber = pr.value ?? io.env.PR_NUMBER;
  const gate = named[0]!;
  const plan = passed.argv[passed.argv.indexOf("--plan") + 1];
  // chant#4607: `approve up --plan <digest>` finds its pull request from the digest, when chant reads pending gates by plan.
  const byPlan = gate === PR_GATE && !prNumber && !op.value && passed.argv.includes("--plan");
  const target = byPlan ? undefined : approveTarget(gate, { pr: prNumber, stack: stack.value, op: op.value });
  if (target && "error" in target) return usage(target.error, table, io);
  if (!passed.argv.includes("--plan") && !passed.argv.includes("--expire")) {
    return usage(`approve needs --plan <digest>, the digest the preview printed, so a change that moved since is never approved in its place`, table, io);
  }
  return withChant(`${PRODUCT} approve`, table, io, async (chant) => {
    let to = target;
    if (!to) {
      const found = await upTargetByPlan(chant, plan!, { stack: stack.value, cwd: io.cwd });
      if ("error" in found) return usage(found.error, table, io);
      if (!json) io.err(`${PRODUCT} approve: ${plan} waits at pull request ${found.pr}'s ${PR_GATE} gate (op ${found.op})`);
      to = { op: found.op, gate: PR_GATE };
    }
    const argv = ["approve", to.op, to.gate, ...passed.argv, ...(json ? ["--json"] : [])];
    const code = explainRefusal(await chant.runChantInProcess(argv, PRODUCT_WORDS), table, io.err);
    // Only a recorded approval of a pull request's up gate goes further; --expire records none.
    if (code !== table.done || to.gate !== PR_GATE || !PR_OP.test(to.op) || !passed.argv.includes("--plan") || passed.argv.includes("--expire")) return code;
    const spec = wavesSpecAt(io.cwd);
    if (spec && wavesTakePullRequestApproval(spec)) {
      const carried = await chant.runChantInProcess(carryArgv(passed.argv), PRODUCT_WORDS);
      if (carried !== table.done) {
        io.err(`${PRODUCT} approve: ${to.op} is approved, and recording the same approval under ${OP_NAME} failed (exit ${carried}), so the waves after the merge still wait at ${PR_GATE}. Run '${PRODUCT} approve ${PR_GATE} --op ${OP_NAME} --plan ${plan} --yes' to record it there.`);
        return explainRefusal(carried, table, io.err);
      }
      if (!json) io.err(`${PRODUCT} approve: recorded the same approval under ${OP_NAME}, where the waves after the merge read the pull request's ${PR_GATE} gate`);
    }
    if (spec) await refreshApprovalStatus(chant, spec, { forge: forgeFlag.value, branch: branchFlag.value, json }, io);
    return code;
  });
}

/** The waves spec at `cwd` as JSON, or undefined when it is missing or does not parse. */
function wavesSpecAt(cwd: string, file = WAVES_SPEC_FILE): Record<string, unknown> | undefined {
  const path = join(cwd, file);
  if (!existsSync(path)) return undefined;
  try {
    const spec: unknown = unwrapWavesSpec(JSON.parse(readFileSync(path, "utf8")));
    return spec && typeof spec === "object" && !Array.isArray(spec) ? (spec as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether the waves after the merge take the pull request's approval: a
 * wave with `approval: "pull-request"` and `approvals.pullRequest.gate` set
 * to `up` (chant#4550, ruling B), as productWavesSpec writes plywood's spec.
 * Such a wave reads that approval under the spec's op, pulumi-up, and never
 * under pr-<n>, so `plywood approve up` records it under both.
 */
export function wavesTakePullRequestApproval(spec: Record<string, unknown>): boolean {
  const gate = (spec.approvals as { pullRequest?: { gate?: unknown } } | undefined)?.pullRequest?.gate;
  const waves = Array.isArray(spec.waves) ? (spec.waves as Array<{ approval?: unknown } | null>) : [];
  return gate === PR_GATE && waves.some((w) => w?.approval === "pull-request");
}

/**
 * chant's approve line for the same approval under pulumi-up's `up` gate.
 * The person confirmed the digest on the first line, so `--yes` skips the
 * second question; `--resume` belongs to the pull request's own gate.
 */
export function carryArgv(passed: readonly string[]): string[] {
  const kept = passed.filter((a) => a !== "--resume");
  return ["approve", OP_NAME, PR_GATE, ...kept, ...(kept.includes("--yes") ? [] : ["--yes"])];
}

/**
 * The forge and target branch the approval status is posted for: `--forge`
 * and `--branch` first, then plywood.yml's forge.kind, then the CI job's
 * variables. Undefined parts are not known.
 */
export function approvalStatusTarget(opts: { forge?: string; branch?: string }, doc: RawConfig | undefined, env: NodeJS.ProcessEnv): { forge?: string; branch?: string } {
  const configured = (doc?.forge as { kind?: string } | undefined)?.kind;
  const ci = env.GITLAB_CI === "true" ? "gitlab" : env.FORGEJO_ACTIONS === "true" || env.GITEA_ACTIONS === "true" ? "forgejo" : env.GITHUB_ACTIONS === "true" ? "github" : undefined;
  const forge = opts.forge ?? configured ?? ci;
  const branch = opts.branch ?? (env.GITHUB_BASE_REF || env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || env.CI_DEFAULT_BRANCH || (env.GITHUB_ACTIONS === "true" ? env.GITHUB_REF_NAME : undefined) || undefined);
  return { ...(forge ? { forge } : {}), ...(branch ? { branch } : {}) };
}

/**
 * After an approval of a pull request's `up` gate, post plywood/approval
 * again on the open pull requests (`run wave --approval-status --open`,
 * chant#4630), since a ledger approval starts no run on any forge. Only on
 * a chant that posts the status for pull-request waves. A refresh that
 * cannot run or fails is a line on stderr and leaves the approval's exit
 * code alone.
 */
async function refreshApprovalStatus(chant: ChantProduct, spec: Record<string, unknown>, opts: { forge?: string; branch?: string; json: boolean }, io: StageIo): Promise<void> {
  if (!hasChantPullRequestApprovalStatus(chant)) return;
  const posts = chant.opWavesPostsApprovalStatus ? chant.opWavesPostsApprovalStatus(spec) : wavesTakePullRequestApproval(spec);
  if (!posts) return;
  const path = findConfig(io.cwd);
  const doc = path ? loadConfig(path).doc : undefined;
  const at = approvalStatusTarget(opts, doc, io.env);
  const line = (branch: string, forge: string) => `${PRODUCT} run wave --spec ${WAVES_SPEC_FILE} --approval-status --open --branch ${branch} --forge ${forge}`;
  if (!at.forge || !at.branch) {
    io.err(`${PRODUCT} approve: ${PRODUCT}/approval moves at the next push or review; to post it now, run '${line(at.branch ?? "<target branch>", at.forge ?? "<forge>")}' with a forge token`);
    return;
  }
  const code = await chant.runChantInProcess(["run", "wave", "--spec", WAVES_SPEC_FILE, "--approval-status", "--open", "--branch", at.branch, "--forge", at.forge], PRODUCT_WORDS);
  if (code !== 0) io.err(`${PRODUCT} approve: the approval is recorded, and ${PRODUCT}/approval was not posted again (exit ${code}); it moves at the next push or review, or run '${line(at.branch, at.forge)}'`);
  else if (!opts.json) io.err(`${PRODUCT} approve: posted ${PRODUCT}/approval again on the open pull requests into ${at.branch}`);
}

/**
 * The pull request op whose `up` gate waits on `digest` (chant#4607's
 * `pendingGatesByPlan`). With `stack`, the op of that stack's gate
 * (`pr-<n>-<stack>`). Without chant#4607, `--pr` or PR_NUMBER stays required.
 */
export async function upTargetByPlan(chant: ChantProduct, digest: string, opts: { stack?: string; cwd?: string } = {}): Promise<{ op: string; pr: number } | { error: string }> {
  const needsPr = `the ${PR_GATE} gate is a pull request's: name it with --pr <n> (or PR_NUMBER), or approve pr-<n>`;
  if (!hasChant4607(chant)) return { error: `${needsPr}. The installed chant cannot find a pull request from a plan digest (chant#4607)` };
  let gates: PendingGateByPlan[];
  try {
    gates = await chant.pendingGatesByPlan!(digest, { pullRequestsOnly: true, ...(opts.cwd ? { cwd: opts.cwd } : {}) });
  } catch (e) {
    return { error: `${needsPr}. Reading the pending gates for ${digest} failed: ${(e as Error).message}` };
  }
  let up = gates.filter((g) => g.gate === PR_GATE && g.pr !== undefined);
  if (opts.stack) up = up.filter((g) => g.member === opts.stack);
  const ops = [...new Set(up.map((g) => g.op))];
  if (ops.length === 0) return { error: `no pull request's ${PR_GATE} gate waits on ${digest}${opts.stack ? ` for ${opts.stack}` : ""}. Check the digest the preview printed and fetch chant/lifecycle, or name the pull request with --pr <n>` };
  const prs = [...new Set(up.map((g) => g.pr!))];
  if (prs.length > 1) return { error: `${digest} waits at the ${PR_GATE} gate of pull requests ${prs.sort((a, b) => a - b).join(", ")}; name one with --pr <n>` };
  // One pull request: its own op, unless only stack ops wait and there is more than one.
  const whole = up.find((g) => g.member === undefined);
  if (whole) return { op: whole.op, pr: whole.pr! };
  if (ops.length > 1) return { error: `${digest} waits at the ${PR_GATE} gate of ${ops.join(", ")}; name the stack with --stack <stack>` };
  return { op: ops[0]!, pr: prs[0]! };
}

/**
 * `plywood override <stack> --rule <id>... --reason <text> [--plan <digest>]
 * [--approver <name>] [--sign] [--json]`: chant's override of a policy
 * denial, recorded as an approval on policy-override.
 */
export async function override(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const rules: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--rule") {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return usage("--rule takes a rule id", table, io);
      rules.push(v);
      i++;
    } else rest.push(args[i]!);
  }
  const reason = takeFlag(rest, "--reason");
  if (reason.missing) return usage("--reason takes a text", table, io);
  const passed = passFlags(reason.rest, ["--plan", "--approver", "--actor", "--url", "--relayed-by"], ["--sign", "--allow-same-origin"]);
  if (passed.missing) return usage(`${passed.missing} takes a value`, table, io);
  const unknown = passed.rest.filter((a) => a.startsWith("-"));
  if (unknown.length) return usage(`override does not take ${unknown.join(" ")}`, table, io);
  const named = positionals(passed.rest);
  const line = `${PRODUCT} override <stack> --rule <id> --reason <text>`;
  if (named.length !== 1) return usage(`override takes the stack the policy denied: ${line}`, table, io);
  if (rules.length === 0) return usage(`an override names each rule it overrides: ${line}`, table, io);
  if (!reason.value?.trim()) return usage(`an override needs --reason <text>: why this change goes out although the policy denies it`, table, io);
  const argv = ["approve", OVERRIDE_OP, named[0]!, ...rules.flatMap((r) => ["--rule", r]), "--reason", reason.value, ...passed.argv, ...(json ? ["--json"] : [])];
  return withChant(`${PRODUCT} override`, table, io, async (chant) => explainRefusal(await chant.runChantInProcess(argv, PRODUCT_WORDS), table, io.err));
}

/** The parts of the waves spec `plywood up` reads before handing it to chant. */
export interface UpSpec {
  waves: Array<{ name: string }>;
  step?: { kind?: string };
}

/** Read and check the waves spec: it must apply each run through the pulumi-up step. */
export function readUpSpec(cwd: string, file = WAVES_SPEC_FILE): UpSpec | { error: string } {
  const path = join(cwd, file);
  if (!existsSync(path)) return { error: `no ${file}; '${PRODUCT} init' writes it from plywood.yml's waves` };
  let spec: unknown;
  try {
    spec = unwrapWavesSpec(JSON.parse(readFileSync(path, "utf8")));
  } catch (e) {
    return { error: `${file}: ${(e as Error).message}` };
  }
  const s = spec as Partial<UpSpec> | null;
  if (!s || !Array.isArray(s.waves) || s.waves.length === 0) return { error: `${file} has no waves` };
  if (s.step?.kind !== UP_STEP_KIND) {
    return { error: `${file} applies through ${s.step?.kind ? `the ${s.step.kind} step` : "no capability step"}; ${PRODUCT} up runs each stack through the ${UP_STEP_KIND} step ("step": { "kind": "${UP_STEP_KIND}" }). Run '${PRODUCT} init' to write it again.` };
  }
  return s as UpSpec;
}

/**
 * `plywood up [--wave <k>] [--decide | --share <i> | --group <name>]
 * [--base <rev>] [--spec <file>] [--no-record] [--events-json] [--json]`,
 * or `plywood up --pr <n> [--base <rev>] [--forge <kind>] [--env <env>]`
 * for an update before merge.
 */
export async function up(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const pr = takeFlag(args, "--pr");
  if (pr.missing) return usage("--pr takes a pull request number", table, io);
  if (pr.value !== undefined) return upBeforeMerge(pr.value, pr.rest, json, table, io);

  const specFlag = takeFlag(pr.rest, "--spec");
  const wave = takeFlag(specFlag.rest, "--wave");
  const share = takeFlag(wave.rest, "--share");
  const group = takeFlag(share.rest, "--group");
  const base = takeFlag(group.rest, "--base");
  for (const [flag, f] of [["--spec", specFlag], ["--wave", wave], ["--share", share], ["--group", group], ["--base", base]] as const) {
    if (f.missing) return usage(`${flag} takes a value`, table, io);
  }
  const switches = base.rest.filter((a) => ["--decide", "--no-record", "--events-json"].includes(a));
  const extra = base.rest.filter((a) => !switches.includes(a));
  if (extra.length) return usage(`up does not take ${extra.join(" ")}`, table, io);
  if (wave.value !== undefined && !/^[1-9]\d*$/.test(wave.value)) return usage(`--wave takes a wave number, 1 or more, not '${wave.value}'`, table, io);
  if ((share.value !== undefined || group.value !== undefined || switches.includes("--decide")) && wave.value === undefined) {
    return usage("--decide, --share and --group are one wave's jobs; name the wave with --wave <k>", table, io);
  }

  const file = specFlag.value ?? WAVES_SPEC_FILE;
  const spec = readUpSpec(io.cwd, file);
  if ("error" in spec) return usage(spec.error, table, io);
  const waves = wave.value !== undefined ? [Number(wave.value)] : spec.waves.map((_, i) => i + 1);
  if (waves.some((k) => k > spec.waves.length)) return usage(`${file} has ${spec.waves.length} wave${spec.waves.length === 1 ? "" : "s"}, so there is no wave ${wave.value}`, table, io);

  return withChant(`${PRODUCT} up`, table, io, async (chant) => {
    for (const k of waves) {
      const argv = [
        "run", "wave", "--spec", file, "--wave", String(k),
        ...(base.value ? ["--base", base.value] : []),
        ...(share.value ? ["--share", share.value] : []),
        ...(group.value ? ["--group", group.value] : []),
        ...switches,
        ...(json ? ["--json"] : []),
      ];
      if (!json && waves.length > 1) io.err(`${PRODUCT} up: wave ${k} (${spec.waves[k - 1]!.name})`);
      const code = await chant.runChantInProcess(argv, PRODUCT_WORDS);
      // A wave that waits, holds or fails stops the ones after it, as the generated jobs' needs: do.
      if (code !== table.done) return explainRefusal(code, table, io.err, { wave: k });
    }
    return table.done;
  });
}

/** `plywood up --pr <n>`: the update before merge `/plywood up` runs, only under apply.when: pull-request. */
async function upBeforeMerge(number: string, args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  if (!/^\d+$/.test(number)) return usage(`--pr takes a pull request number, not '${number}'`, table, io);
  const base = takeFlag(args, "--base");
  const forgeFlag = takeFlag(base.rest, "--forge");
  const envFlag = takeFlag(forgeFlag.rest, "--env");
  if (base.missing || forgeFlag.missing || envFlag.missing) return usage("--base, --forge and --env each take a value", table, io);
  const extra = envFlag.rest;
  if (extra.length) return usage(`up --pr does not take ${extra.join(" ")}`, table, io);

  const path = findConfig(io.cwd);
  if (!path) return usage(`no plywood.yml in ${io.cwd} or above it; run '${PRODUCT} init' first`, table, io);
  const config = loadConfig(path);
  const errors = checkConfig(config).filter((p) => p.severity === "error");
  if (errors.length) {
    for (const p of errors) io.err(`${path}: ${p.key} ${p.message}`);
    return table.failed;
  }
  if (applyWhenOf(config.doc) !== "pull-request") {
    return usage(`/${PRODUCT} up updates an open pull request only under apply.when: pull-request, and ${path} updates after the merge. Set apply.when: pull-request, or merge and let the waves run.`, table, io);
  }
  const at = base.value ?? io.env.BASE_SHA;
  if (!at) return usage("up --pr needs --base <rev>, the target branch's commit (or BASE_SHA)", table, io);
  const configured = (config.doc.forge as { kind?: string } | undefined)?.kind;
  const forge = forgeFlag.value ?? configured ?? "github";
  if (!(FORGES as readonly string[]).includes(forge)) return usage(`--forge ${forge} is not one of ${FORGES.join(", ")}`, table, io);
  return withChant(`/${PRODUCT} up`, table, io, async (chant) => {
    // chant#4607: apply.requires as --requires; a chant before it asks all four, and plywood says so.
    const note = requiresNotHonoured(chant, config.doc);
    if (note) io.err(`${PRODUCT}: ${note}`);
    const argv = [
      "components", "pr-apply", "--before-merge", "--base", at, "--pr", number,
      "--env", envFlag.value ?? "production", "--gate", PR_GATE, "--forge", forge,
      ...requiresArgv(chant, config.doc),
      ...(await mergeArgv(config.doc, io)),
      ...(json ? ["--json"] : []),
    ];
    return explainRefusal(await chant.runChantInProcess(argv, PRODUCT_WORDS), table, io.err, { pr: number });
  });
}

/** `--merge auto` for `apply.merge: auto` on a chant with chant#4636; on one without it, a line that a person merges. */
async function mergeArgv(doc: RawConfig, io: StageIo): Promise<string[]> {
  const merge = applyMergeOf(doc);
  if (!merge) return [];
  if (!(await chantNext()).applyMerge) {
    io.err(`${PRODUCT}: ${APPLY_MERGE_NEEDS_CHANT}`);
    return [];
  }
  return applyMergeArgv(merge);
}

/**
 * `plywood resume [--op <op>] [--wave <k>] [--dry-run] [--json]`: chant's
 * `run resume --op pulumi-up`, in process with plywood's words. It starts
 * the wave jobs whose gate an approval has since cleared, from the gate
 * ledgers (chant#3683). `--wave <k>` names the gate `wave-<k>`; `--op` reads
 * another op's gates, such as `plywood-adopt`. A refusal gets the line
 * `plywood up` adds.
 */
export async function resume(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const op = takeFlag(args, "--op");
  const wave = takeFlag(op.rest, "--wave");
  if (op.missing || wave.missing) return usage(`${op.missing ? "--op takes an op, such as pulumi-up" : "--wave takes a wave number"}`, table, io);
  const switches: string[] = wave.rest.filter((a) => a === "--dry-run");
  const extra = wave.rest.filter((a) => !switches.includes(a));
  if (extra.length) return usage(`resume does not take ${extra.join(" ")}`, table, io);
  if (wave.value !== undefined && !/^[1-9]\d*$/.test(wave.value)) return usage(`--wave takes a wave number, 1 or more, not '${wave.value}'`, table, io);
  const k = wave.value !== undefined ? Number(wave.value) : undefined;
  const argv = [
    "run", "resume", "--op", op.value ?? OP_NAME,
    ...(k !== undefined ? ["--gate", PRODUCT_WORDS.gateName.replace("{k}", String(k))] : []),
    ...switches,
    ...(json ? ["--json"] : []),
  ];
  return withChant(`${PRODUCT} resume`, table, io, async (chant) => explainRefusal(await chant.runChantInProcess(argv, PRODUCT_WORDS), table, io.err, k !== undefined ? { wave: k } : {}));
}
