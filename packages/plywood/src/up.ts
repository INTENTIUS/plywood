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
 *       a wave gate `wave-<k>` is recorded under op pulumi-up. At a terminal
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
import { applyWhenOf } from "./config/apply";
import { checkConfig, findConfig, loadConfig } from "./config/index";
import { FORGES } from "./config/routing";
import type { ExitTable } from "./exit-codes";
import { explainRefusal } from "./refusals";
import { positionals, takeFlag, usage, withChant, type StageIo } from "./stages";
import { OP_NAME, PR_GATE, PRODUCT, PRODUCT_WORDS } from "./words";

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
  if (pr.missing || stack.missing || op.missing) return usage(`${pr.missing ? "--pr" : stack.missing ? "--stack" : "--op"} takes a value`, table, io);
  const passed = passFlags(op.rest, APPROVE_PASS, APPROVE_SWITCHES);
  if (passed.missing) return usage(`${passed.missing} takes a value`, table, io);
  const named = positionals(passed.rest);
  const unknown = passed.rest.filter((a) => a.startsWith("-"));
  if (unknown.length) return usage(`approve does not take ${unknown.join(" ")}`, table, io);
  if (named.length !== 1) return usage(`approve takes one gate: '${PRODUCT} approve ${PR_GATE} --pr <n> --plan <digest>' or '${PRODUCT} approve wave-<k> --plan <digest>'`, table, io);
  const target = approveTarget(named[0]!, { pr: pr.value ?? io.env.PR_NUMBER, stack: stack.value, op: op.value });
  if ("error" in target) return usage(target.error, table, io);
  if (!passed.argv.includes("--plan") && !passed.argv.includes("--expire")) {
    return usage(`approve needs --plan <digest>, the digest the preview printed, so a change that moved since is never approved in its place`, table, io);
  }
  const argv = ["approve", target.op, target.gate, ...passed.argv, ...(json ? ["--json"] : [])];
  return withChant(`${PRODUCT} approve`, table, io, async (chant) => explainRefusal(await chant.runChantInProcess(argv, PRODUCT_WORDS), table, io.err));
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
    spec = JSON.parse(readFileSync(path, "utf8"));
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
  const argv = [
    "components", "pr-apply", "--before-merge", "--base", at, "--pr", number,
    "--env", envFlag.value ?? "production", "--gate", PR_GATE, "--forge", forge,
    ...(json ? ["--json"] : []),
  ];
  return withChant(`/${PRODUCT} up`, table, io, async (chant) => explainRefusal(await chant.runChantInProcess(argv, PRODUCT_WORDS), table, io.err, { pr: number }));
}
