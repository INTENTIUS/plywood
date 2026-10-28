/**
 * The plywood CLI. Each verb hands plywood's words to chant, which runs the
 * stage in process (chant#4550 ruling C). `check`, `preview` and `ci` are
 * built (src/stages.ts), and `up`, `approve` and `override` (src/up.ts);
 * and `drift` (src/drift.ts). `config check` reads plywood.yml
 * (src/config-check.ts), and `config identities` and `forge check` the
 * identities (src/identities.ts). `estate` (src/estate.ts) and `notify
 * relay` (src/notify.ts) are chant's estate and relay with plywood's words. chant's own verbs (`components`, `ci <sub>`, `run`,
 * `lock`, `unlock`) pass to chant unchanged with plywood's words, for the
 * lines the generated jobs run through the bin.
 *
 * Every command takes `--json`, which prints one JSON object on stdout in
 * place of the text.
 */
import { configCheck } from "./config-check";
import { exitCodes, type ExitTable } from "./exit-codes";
import { audit } from "./audit";
import { mcp } from "./agents";
import { drift } from "./drift";
import { estate } from "./estate";
import { notify } from "./notify";
import { useChantPolicySource } from "./config/policy";
import { guard } from "./guard";
import { configIdentities, forgeCheck } from "./identities";
import { control } from "./control";
import { applyTelemetry } from "./telemetry";
import { init, type InitIo } from "./init";
import { CHANT_PASSTHROUGH, check, ci, passthrough, preview, type StageIo } from "./stages";
import { tipById, tipLines, TIPS } from "./tips";
import { useChantInstallLines } from "./images";
import { approve, override, resume, up } from "./up";
import { cancelStack, exportStack, moveStack, rollbackStack } from "./stack-ops";
import { PRODUCT, TAGLINE, VERBS, type Verb } from "./words";

declare const __PLYWOOD_VERSION__: string | undefined;

/** The package version, set by scripts/build-cli.mjs. */
export const VERSION = typeof __PLYWOOD_VERSION__ === "string" ? __PLYWOOD_VERSION__ : "0.0.0-dev";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const stdio: Io = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
};

export function helpText(): string {
  const width = Math.max(...VERBS.map((v) => v.verb.length));
  return [
    `${PRODUCT}: ${TAGLINE}`,
    "",
    `Usage: ${PRODUCT} <command> [--json]`,
    "",
    "Commands:",
    ...VERBS.map((v) => `  ${v.verb.padEnd(width)}  ${v.summary}`),
    "",
    "Setup:",
    "  init [--preset <name>] [--gate <when>] [--engine pulumi|plunge] [--forge <kind>]",
    "       [--env <env>] [--from <source>[=<file>]] [--no-bucket-check] [--dry-run] [--yes]",
    "                                                      plywood.yml, the stacks and the workflow, from the repository",
    "                                                      --from reads pulumi-actions, deployments, spacelift or env0 settings",
    "  init --print-prompt                                 the prompt that has a coding agent set plywood up",
    "",
    "Stages:",
    "  check [--base <rev>] [<target>...]                  plywood.yml, then the check hooks at base",
    "  preview [<stack>] [--base <rev>] [--pr <n>] [--forge <kind>]",
    "                                                      preview the stacks the change reaches; --forge posts the note",
    "  ci [--forge <kind>] [--env <env>] [--output <file>] [--dry-run]",
    "                                                      write the pull request workflow",
    "  tips [<id>]                                         the tips a preview can name",
    "  up [--wave <k>] [--decide | --share <i> | --group <name>]",
    "                                                      run the merge's waves through the pulumi-up step",
    "  up --pr <n> [--base <rev>]                          update an open pull request (apply.when: pull-request)",
    "  resume [--op <op>] [--wave <k>] [--dry-run]         start the wave jobs an approval has since cleared",
    "  drift [<stack>...] [--resource <urn>] [--forge <kind>] [--respond issue|pull-request|up|none]",
    "                                                      read each stack against the cloud; --forge keeps one issue per stack",
    "",
    "Approvals:",
    "  approve <gate> --plan <digest> [--pr <n>] [--yes]   approve up (a pull request), review (its review stack) or wave-<k>;",
    "                                                      up finds its pull request from the digest when --pr is left out",
    "  override <stack> --rule <id>... --reason <text>     override a policy denial, spent once its update runs",
    "",
    "Stack operations (each waits for a second person's approval):",
    "  export <stack> --out <file>                         the stack's export, to a file on your machine",
    "  cancel <stack> [--lock <id>]                        release a stuck stack lock; on file:// it reads the id",
    "  move <urn>... --from <stack> --to <stack>           move resources; both stacks preview no change",
    "  move <stack> --onto plunge                          adopt the stacks onto plunge (plywood.adopt.op.ts)",
    "  rollback <stack> [--digest <d>] | --release <name> --env <env>",
    "                                                      preview a release's program, then update behind its gate",
    "",
    "Ledger:",
    "  audit [approvals|updates|runs|review-stacks] [--stack <s>] [--since <t>] [--where <f>=<v>]...",
    "                                                      the workspace ledger's rows, as chant ledger reads them",
    "  query \"<sql>\"                                      SQL over the ledger's tables (chant query)",
    "  estate [--report-url <url>] [--prefix <p>] [--fail-overdue]",
    "                                                      the estate page, overdue drift checks and delivery metrics",
    "  notify relay                                        receive Approve clicks from Slack and Teams and record them",
    "",
    "Control repo:",
    "  control init [--forge <kind>]                       in the control repo: the workflow that runs each repository's dependents",
    "  control put <host/owner/name>|defaults [--approver <glob>=<role>[:<n>]]... [--pin <tool>=<v>]... [--file <yml>]",
    "                                                      one entry's approvers and pins, on the control repo's ledger",
    "  control import <yml> | list | retire <host/owner/name>",
    "  control reconcile [--apply] [--project <key>]       each repository's plywood.yml from its entry, as a pull request",
    "  control dispatch [--sha <sha>]                      tell plywood.yml's control repo this commit applied",
    "",
    "Agents:",
    "  mcp [--report-url <url>]                            chant's read-only MCP server over stdio, with plywood's read tools",
    "  guard check <command line>                          whether the agent guard refuses a command",
    "  guard install [--dir <d>]                           the Claude Code hook and the pulumi and plunge wrappers",
    "",
    "Config:",
    "  config check [--file <path>]  check plywood.yml and print the settings in force",
    "  config identities [--file <path>] [--env <env>]",
    "                                the preview and up identity each stack takes, per cloud",
    "  forge check [--env <env>] [--forge <kind>] [--repo <owner/name>] [--branch <b>] [--require-clouds]",
    "                                the identities next to the forge, cloud and Pulumi Cloud setup",
    "",
    "Options:",
    "  --json     print one JSON object on stdout",
    "  --help     show this help",
    "  --version  print the version",
  ].join("\n");
}

/** Runs one command line (without the node and script arguments) and returns its exit code. */
export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const { table, source } = await exitCodes();
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const verb = args[0];
  const emit = (envelope: Record<string, unknown>, text: string, toErr = false): void => {
    if (json) io.out(JSON.stringify(envelope));
    else (toErr ? io.err : io.out)(text);
  };

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    emit({ command: "help", ok: true, exitCode: table.done, verbs: VERBS }, helpText());
    return table.done;
  }
  if (verb === "--version" || verb === "-v") {
    emit({ command: "version", ok: true, exitCode: table.done, version: VERSION, exitCodes: source }, VERSION);
    return table.done;
  }
  // chant's verified install lines, when the installed pulumi lexicon has them (chant#4592); the config translation is synchronous.
  await useChantInstallLines();
  // Whether chant reads ci.policy.source and ci.policy.packs (chant#4613); the config check and translation read it.
  await useChantPolicySource();
  const stageIo: StageIo = { out: io.out, err: io.err, cwd: process.cwd(), env: process.env };
  // plywood.yml's telemetry as chant's OTEL_* variables, before the first call into chant (plywood#20).
  if (verb !== "config" && verb !== "init" && verb !== "tips") await applyTelemetry(stageIo.cwd, stageIo.env);
  if (verb === "audit") return audit(args.slice(1), json, table, stageIo);
  if (verb === "config" && args[1] === "identities") return configIdentities(args.slice(2), json, table, stageIo);
  if (verb === "config") return config(args.slice(1), table, emit);
  if (verb === "forge") return forgeCheck(args.slice(1), json, table, stageIo);
  if (verb === "estate") return estate(args.slice(1), json, table, stageIo);
  if (verb === "notify") return notify(args.slice(1), json, table, stageIo);
  if (verb === "control") return control(args.slice(1), json, table, stageIo);
  if (verb === "init") {
    const interactive = !json && !args.includes("--yes") && !args.includes("-y") && process.stdin.isTTY === true && process.stderr.isTTY === true;
    const initIo: InitIo = interactive ? { ...stageIo, ask: askOnTerminal } : stageIo;
    return init(args.slice(1), json, table, initIo);
  }
  if (verb === "check") return check(args.slice(1), json, table, stageIo);
  if (verb === "preview") return preview(args.slice(1), json, table, stageIo);
  if (verb === "up") return up(args.slice(1), json, table, stageIo);
  if (verb === "resume") return resume(args.slice(1), json, table, stageIo);
  if (verb === "approve") return approve(args.slice(1), json, table, stageIo);
  if (verb === "override") return override(args.slice(1), json, table, stageIo);
  if (verb === "export") return exportStack(args.slice(1), json, table, stageIo);
  if (verb === "cancel") return cancelStack(args.slice(1), json, table, stageIo);
  if (verb === "move") return moveStack(args.slice(1), json, table, stageIo);
  if (verb === "rollback") return rollbackStack(args.slice(1), json, table, stageIo);
  if (verb === "drift") return drift(args.slice(1), json, table, stageIo);
  if (verb === "mcp") return mcp(args.slice(1), json, table, stageIo);
  if (verb === "guard") return guard(args.slice(1), json, table, stageIo);
  // `plywood ci` writes the workflow; `plywood ci <sub>` is chant's `ci <sub>`, as a generated job runs it.
  if (verb === "ci") {
    const sub = args[1];
    return sub === undefined || sub.startsWith("-") ? ci(args.slice(1), json, table, stageIo) : passthrough(argv, table, stageIo);
  }
  if ((CHANT_PASSTHROUGH as readonly string[]).includes(verb)) return passthrough(argv, table, stageIo);
  if (verb === "tips") return tips(args[1], table, emit);
  const known = VERBS.find((v) => v.verb === verb);
  if (!known) {
    // A usage error is chant's `failed`, 1 (chant#4553 ruling C).
    const message = `unknown command '${verb}'. Run '${PRODUCT} --help' for the commands.`;
    emit({ command: verb, ok: false, exitCode: table.failed, error: message }, `${PRODUCT}: ${message}`, true);
    return table.failed;
  }
  return notBuilt(known.verb, table.failed, emit);
}

/** A question on the terminal, answered by name or by number; Enter takes the fallback. */
async function askOnTerminal(question: string, choices: readonly string[], fallback: string): Promise<string> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    for (;;) {
      const answer = (await rl.question(`${question} (${choices.map((c, i) => `${i + 1}. ${c}`).join(", ")}) [${fallback}]: `)).trim();
      if (answer === "") return fallback;
      const byNumber = choices[Number(answer) - 1];
      if (byNumber) return byNumber;
      if (choices.includes(answer)) return answer;
    }
  } finally {
    rl.close();
  }
}

function notBuilt(
  verb: Verb,
  code: number,
  emit: (envelope: Record<string, unknown>, text: string, toErr?: boolean) => void,
): number {
  const message = `${PRODUCT} ${verb} is not built yet.`;
  emit({ command: verb, ok: false, exitCode: code, error: message }, `${PRODUCT}: ${message}`, true);
  return code;
}

/** `plywood tips [<id>]`: every tip, or the one named. */
function tips(id: string | undefined, table: ExitTable, emit: Emit): number {
  const chosen = id === undefined ? TIPS : [tipById(id)].filter((t) => t !== undefined);
  if (chosen.length === 0) {
    const message = `no tip '${id}'. The tips are ${TIPS.map((t) => t.id).join(", ")}.`;
    emit({ command: "tips", ok: false, exitCode: table.failed, error: message }, `${PRODUCT}: ${message}`, true);
    return table.failed;
  }
  emit({ command: "tips", ok: true, exitCode: table.done, tips: chosen }, tipLines(chosen).join("\n"));
  return table.done;
}

type Emit = (envelope: Record<string, unknown>, text: string, toErr?: boolean) => void;

/** `plywood config check [--file <path>]`. A config with an error exits with chant's `failed`. */
function config(args: string[], table: ExitTable, emit: Emit): number {
  const [sub, ...rest] = args;
  const command = `config ${sub ?? ""}`.trim();
  const fileAt = rest.indexOf("--file");
  const file = fileAt >= 0 ? rest[fileAt + 1] : undefined;
  if (sub !== "check" || (fileAt >= 0 && !file)) {
    const message = sub !== "check" ? `unknown config command '${sub ?? ""}'. Run '${PRODUCT} config check' or '${PRODUCT} config identities'.` : "--file takes a path";
    emit({ command, ok: false, exitCode: table.failed, error: message }, `${PRODUCT}: ${message}`, true);
    return table.failed;
  }
  const r = configCheck(process.cwd(), file);
  const code = r.ok ? table.done : table.failed;
  emit({ command, ok: r.ok, exitCode: code, ...r.envelope }, r.lines.join("\n"), !r.ok);
  return code;
}
