/**
 * Stack operations behind a gate (plywood#16): `plywood export`, `cancel`,
 * `move` and `rollback`. plywood holds the verbs and the text; chant's
 * pulumi lexicon runs each one (chant#4578, #4542, #4562):
 *
 *   plywood export <stack> --out <file>
 *       gatedStackExport: a gated request `stack-export` on the workspace
 *       ledger. Once a second person approves it, `stack export` runs and
 *       the file lands mode 600 at --out on the requester's machine. chant
 *       refuses it in CI, inside a git working tree, and over a file that
 *       exists, before anything is asked.
 *   plywood cancel <stack> --lock <id>
 *       gatedStackCancel: `stack-cancel` of that lock id. After the approval
 *       chant checks the stack still holds that lock, then runs `pulumi
 *       cancel --yes`. A plunge stack is refused: plunge keeps no stack lock.
 *   plywood move <urn>... --from <stack> --to <stack>
 *       gatedStackMove: `stack-move`. Both stacks preview first, and the
 *       move runs only when the previews change nothing but the moved
 *       resources; then `pulumi state move`, or `plunge stack move` by
 *       markers on plunge (plunge#56), and both stacks preview again.
 *   plywood move <stack> --onto plunge
 *       chant's PulumiAdoptOp (chant#4562) as `plywood init --engine plunge`
 *       writes it (plywood.adopt.op.ts): `chant run plywood-adopt`, which
 *       stops at each stack's gate.
 *   plywood rollback <stack> [--digest <sha256:...>]
 *   plywood rollback --release <name> --env <env>
 *       chant components rollback (chant#4542): the release's recorded
 *       program previews against the stack, the release gate binds that
 *       preview, and the update runs once it is approved.
 *   plywood action <stack> <name>
 *       gatedStackAction (chant#4654), in src/actions.ts: the replacement of
 *       a command resource plywood.yml names under the stack's actions.
 *
 * Each request is approved with `plywood approve <gate> --op
 * pulumi-stack-ops --plan <digest>`, the line a waiting request prints, and
 * the requester runs the same command again to carry it out. The requester's
 * own approval never counts.
 *
 * Everything chant runs here is reached through a feature-detect: a pulumi
 * lexicon older than the pinned 0.124.58 may have none of it, and then each verb
 * says so and exits with chant's `failed` code.
 */
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { toChantSettings, type ChantMemberSettings, type ChantQuorumRule } from "./chant-config";
import { pulumiCloudOf } from "./config/identity";
import { checkConfig, findConfig, loadConfig, type PlywoodConfig } from "./config/index";
import { stacksOf } from "./config/stacks";
import type { ExitTable } from "./exit-codes";
import { ADOPT_OP, ADOPT_OP_FILE } from "./init/adopt";
import { environmentOf, slug } from "./init/detect";
import { explainRefusal } from "./refusals";
import { positionals, takeFlag, usage, withChant, type StageIo } from "./stages";
import { BUILT_CHANT } from "./chant-product";
import { PRODUCT, PRODUCT_WORDS, STACK_OP_WORDS, type StackOpVerb } from "./words";

/** chant's op the requests are recorded under (`PULUMI_STACK_OPS_OP`). */
export const STACK_OPS_OP = "pulumi-stack-ops";

/** How a gated request ended, as chant's lexicon answers (`PulumiStackOpOutcome`). */
export type StackOpOutcome<T> =
  | { status: "waiting"; digest: string; command: string }
  | { status: "refused"; digest: string; by: string; reason: string; command: string }
  | { status: "spent"; digest: string }
  | { status: "done"; digest: string; result: T }
  | { status: "failed"; digest: string; error: string };

/** What every request takes (`PulumiStackOpCommon`); plywood leaves the runners to chant. */
export interface StackOpCommon {
  by: string;
  rules: { mode: string; quorum?: ChantQuorumRule[] };
  op?: string;
  ledgerCwd?: string;
  env?: Record<string, string | undefined>;
}

export interface ExportResult {
  file: string;
  sha256: string;
  bytes: number;
  resources: number;
}

export interface MoveResult {
  engine: string;
  moved: string[];
}

/** The part of chant's pulumi lexicon these verbs call (lexicons/pulumi/src/stack-ops.ts). */
export interface ChantStackOps {
  gatedStackExport(opts: StackOpCommon & { dir: string; stack: string; engine?: string; out: string }): Promise<StackOpOutcome<ExportResult>>;
  gatedStackCancel(opts: StackOpCommon & { dir: string; stack: string; engine?: string; lockId: string; project?: string }): Promise<StackOpOutcome<{ lockChecked: boolean }>>;
  gatedStackMove(opts: StackOpCommon & { source: { member: string; dir: string; stack: string }; dest: { member: string; dir: string; stack: string }; urns: string[]; engine?: string }): Promise<StackOpOutcome<MoveResult>>;
}

const REQUIRED = ["gatedStackExport", "gatedStackCancel", "gatedStackMove"] as const;

/** chant's stack lock reader (`pulumiStackLockIds`, chant#4615): the lock ids a stack holds now, read from a `file://` backend. */
export type ChantStackLockReader = (opts: { dir: string; stack: string; project?: string; engine?: string; env?: Record<string, string | undefined> }) => Promise<{ checked: boolean; backend?: string; ids: string[] }>;

let cachedLocks: Promise<ChantStackLockReader | undefined> | undefined;

/** chant's lock reader, or undefined when the installed pulumi lexicon lacks it; `cancel` then takes the id from `--lock` alone. */
export function chantStackLockReader(): Promise<ChantStackLockReader | undefined> {
  cachedLocks ??= (async () => {
    try {
      // @ts-ignore: pulumiStackLockIds is missing from older lexicons (chant#4615).
      const m: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      return typeof m.pulumiStackLockIds === "function" ? (m.pulumiStackLockIds as ChantStackLockReader) : undefined;
    } catch {
      return undefined;
    }
  })();
  return cachedLocks;
}

/** Tests stand in a lock reader (or none, for the fallback). `reset` goes back to the real import. */
export function setChantStackLockReaderForTests(fake: ChantStackLockReader | undefined | "reset"): void {
  cachedLocks = fake === "reset" ? undefined : Promise.resolve(fake);
}

/**
 * The lock id `cancel` asks to release: `--lock`, else the one lock chant's
 * reader finds on the stack's `file://` backend (chant#4615). No lock, two
 * locks, or a backend the reader cannot list is an error that says which.
 */
export async function lockToCancel(given: string | undefined, stack: { dir: string; stack: string; project?: string; engine?: string }, env: Record<string, string | undefined>): Promise<{ lockId: string; read: boolean } | { error: string }> {
  if (given) return { lockId: given, read: false };
  const reader = await chantStackLockReader();
  if (!reader) return { error: STACK_OP_WORDS.needsLock };
  let locks: Awaited<ReturnType<ChantStackLockReader>>;
  try {
    locks = await reader({ dir: stack.dir, stack: stack.stack, ...(stack.project ? { project: stack.project } : {}), ...(stack.engine ? { engine: stack.engine } : {}), env });
  } catch (e) {
    return { error: `${STACK_OP_WORDS.needsLock}. Reading the stack's lock failed: ${(e as Error).message}` };
  }
  if (!locks.checked) return { error: STACK_OP_WORDS.lockNotListed(locks.backend) };
  if (locks.ids.length === 0) return { error: STACK_OP_WORDS.noLock(stack.stack) };
  if (locks.ids.length > 1) return { error: STACK_OP_WORDS.manyLocks(stack.stack, locks.ids) };
  return { lockId: locks.ids[0]!, read: true };
}

let cachedOps: Promise<ChantStackOps | undefined> | undefined;
let cachedRollback: Promise<boolean> | undefined;

/** chant's gated stack operations, or undefined when the installed pulumi lexicon lacks them. */
export function chantStackOps(): Promise<ChantStackOps | undefined> {
  cachedOps ??= (async () => {
    try {
      // @ts-ignore: the gated stack operations are missing from older lexicons (chant#4578).
      const m: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      return REQUIRED.every((name) => typeof m[name] === "function") ? (m as unknown as ChantStackOps) : undefined;
    } catch {
      return undefined;
    }
  })();
  return cachedOps;
}

/**
 * Whether the installed pulumi lexicon rolls a stack back by release: the
 * `pulumi-up` step answers `releaseInputs` (chant#4541) and a release copy
 * gets its dependencies installed before its preview (chant#4542 item 3).
 */
export function chantStackRollback(): Promise<boolean> {
  cachedRollback ??= (async () => {
    try {
      // @ts-ignore: pulumiReleaseInputs is missing from older lexicons (the release after 0.124.54).
      const m: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      if (typeof m.pulumiReleaseInputs !== "function") return false;
      // @ts-ignore: older lexicons lack the subpath (chant#4542).
      const copy: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi/release-copy");
      return typeof copy.prepareReleaseCopy === "function";
    } catch {
      return false;
    }
  })();
  return cachedRollback;
}

/** Tests stand in a fake lexicon (or none, for the fallback). `reset` goes back to the real import. */
export function setChantStackOpsForTests(fake: ChantStackOps | undefined | "reset", rollback?: boolean): void {
  cachedOps = fake === "reset" ? undefined : Promise.resolve(fake);
  cachedRollback = fake === "reset" ? undefined : Promise.resolve(rollback ?? fake !== undefined);
}

/** The message a stack operation prints when the installed lexicon lacks it; `after` is the last chant release without the feature. */
export function needsStackOpsMessage(what: string, feature: string, after = "0.124.54"): string {
  return (
    `${what} needs @intentius/chant-lexicon-pulumi >= the release after ${after}, which carries ${feature}. ` +
    `This plywood was built with chant ${BUILT_CHANT}, which lacks it. ` +
    "Upgrade plywood once that chant is out, or build against a local chant with 'just chant-local'."
  );
}

/** A stack as a request names it: plywood.yml's key, its directory, and the `--stack` the engine takes. */
export interface ResolvedStack {
  key: string;
  project: string;
  stack: string;
  dir: string;
  engine?: "pulumi" | "plunge";
  backend?: string;
}

/** The config around `cwd`, checked; an error names the first problem. */
export function readConfig(cwd: string): { config: PlywoodConfig; path: string } | { error: string } {
  const path = findConfig(cwd);
  if (!path) return { error: `no plywood.yml in ${cwd} or above it; run '${PRODUCT} init' first` };
  const config = loadConfig(path);
  const errors = checkConfig(config).filter((p) => p.severity === "error");
  if (errors.length) return { error: errors.map((p) => `${path}: ${p.key} ${p.message}`).join("\n") };
  return { config, path };
}

/** The stack `key` names (`project/stack`), from plywood.yml's stacks, or `dir` when given. */
export function resolveStack(config: PlywoodConfig, path: string, key: string, dir?: string): ResolvedStack | { error: string } {
  const [project, stack, extra] = key.split("/");
  if (!project || !stack || extra !== undefined) return { error: `a stack is project/stack, as plywood.yml lists it, not '${key}'` };
  const settings = toChantSettings(config);
  const listed = stacksOf(config.doc);
  const root = dirname(path);
  const member: Partial<ChantMemberSettings> = settings.members.find((m) => m.name === key) ?? settings.memberDefaults;
  if (dir === undefined && Object.keys(listed).length > 0 && !(key in listed)) {
    return { error: `${key} is not under stacks in ${path}; the stacks are ${Object.keys(listed).join(", ")} (or name its directory with --dir)` };
  }
  const at = dir ?? listed[key]?.dir ?? ".";
  return {
    key,
    project,
    stack,
    dir: isAbsolute(at) ? at : resolve(root, at),
    ...(member.engine ? { engine: member.engine } : {}),
    ...(member.backend ? { backend: member.backend } : {}),
  };
}

/** Which approvals count for a request: plywood.yml's `approval` and `approval_rules`, as chant reads them. */
export function requestRules(config: PlywoodConfig): StackOpCommon["rules"] {
  const p = toChantSettings(config).pipeline;
  return { mode: p.approval ?? "ledger", ...(p.quorum?.length ? { quorum: p.quorum } : {}) };
}

/** Who asks: --by, else the name chant's approve would record (the forge's actor, else the user). */
export function requesterOf(by: string | undefined, env: NodeJS.ProcessEnv): string {
  return by ?? env.GITHUB_ACTOR ?? env.GITLAB_USER_LOGIN ?? env.USER ?? "unknown";
}

/**
 * The destination as `pulumi state move --dest` takes it: the bare stack in
 * the same project, else fully qualified. A DIY backend's organization is
 * always `organization`; on Pulumi Cloud it is plywood.yml's pulumi_cloud.org.
 */
export function destStackName(source: ResolvedStack, dest: ResolvedStack, config: PlywoodConfig): string {
  if (dest.project === source.project) return dest.stack;
  const cloud = !dest.backend || /^https?:\/\//.test(dest.backend);
  const org = cloud ? pulumiCloudOf(config.doc).org : undefined;
  return `${org ?? "organization"}/${dest.project}/${dest.stack}`;
}

/** The line that approves a waiting request, in plywood's words. */
export function approveRequestLine(gate: string, digest: string, mode: string): string {
  return `${PRODUCT} approve ${gate} --op ${STACK_OPS_OP} --plan ${digest}${mode === "sealed" ? " --sign" : ""}`;
}

/** The backend a stack names, for the engine's run, when the environment names none. */
export function useBackend(stacks: ResolvedStack[], env: NodeJS.ProcessEnv): string | undefined {
  const named = [...new Set(stacks.map((s) => s.backend).filter((b): b is string => b !== undefined))];
  if (named.length > 1) return `the stacks are on different backends (${named.join(", ")}); a move needs both on one backend`;
  if (named[0] && !env.PULUMI_BACKEND_URL) env.PULUMI_BACKEND_URL = named[0];
  return undefined;
}

/** Print what a request's outcome means, and return chant's code for it. */
export function reportOutcome<T>(
  verb: StackOpVerb,
  outcome: StackOpOutcome<T>,
  gate: string,
  rules: StackOpCommon["rules"],
  done: (result: T) => string,
  json: boolean,
  table: ExitTable,
  io: StageIo,
): number {
  const approveLine = outcome.status === "waiting" || outcome.status === "refused" ? approveRequestLine(gate, outcome.digest, rules.mode) : undefined;
  let code: number;
  let text: string;
  switch (outcome.status) {
    case "waiting":
      code = table.waiting;
      text = STACK_OP_WORDS.waiting(verb, approveLine!);
      break;
    case "refused":
      code = table.waiting;
      text = `${outcome.reason}. ${STACK_OP_WORDS.waiting(verb, approveLine!)}`;
      break;
    case "spent":
      code = table.failed;
      text = STACK_OP_WORDS.spent(verb);
      break;
    case "done":
      code = table.done;
      text = done(outcome.result);
      break;
    case "failed":
      code = table.failed;
      text = `${PRODUCT} ${verb}: ${outcome.error}`;
      break;
  }
  if (json) {
    io.out(JSON.stringify({
      command: verb, ok: code === table.done, exitCode: code, status: outcome.status, op: STACK_OPS_OP, gate, digest: outcome.digest,
      ...(approveLine ? { approve: approveLine } : {}),
      ...(outcome.status === "done" ? { result: outcome.result } : {}),
      ...(outcome.status === "failed" ? { error: outcome.error } : {}),
      ...(outcome.status === "refused" ? { refusedBy: outcome.by, reason: outcome.reason } : {}),
    }));
  } else (code === table.done ? io.out : io.err)(text);
  return code;
}

/** Run one request, turning a refusal chant throws before asking into chant's `failed`. */
async function runRequest(verb: StackOpVerb, json: boolean, table: ExitTable, io: StageIo, call: (ops: ChantStackOps) => Promise<number>): Promise<number> {
  const ops = await chantStackOps();
  if (!ops) {
    io.err(`${PRODUCT}: ${needsStackOpsMessage(`${PRODUCT} ${verb}`, "the gated stack operations (chant#4578)")}`);
    return table.failed;
  }
  try {
    return await call(ops);
  } catch (e) {
    const message = (e as Error).message;
    if (json) io.out(JSON.stringify({ command: verb, ok: false, exitCode: table.failed, error: message }));
    else io.err(`${PRODUCT} ${verb}: ${message}`);
    return table.failed;
  }
}

/** --by, --dir: the flags every request takes. */
export function commonFlags(args: string[]): { by?: string; dir?: string; rest: string[]; missing?: string } {
  const by = takeFlag(args, "--by");
  const dir = takeFlag(by.rest, "--dir");
  if (by.missing) return { rest: args, missing: "--by" };
  if (dir.missing) return { rest: args, missing: "--dir" };
  return { by: by.value, dir: dir.value, rest: dir.rest };
}

/** `plywood export <stack> --out <file> [--by <name>] [--dir <path>] [--json]`. */
export async function exportStack(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const common = commonFlags(args);
  if (common.missing) return usage(`${common.missing} takes a value`, table, io);
  const out = takeFlag(common.rest, "--out");
  if (out.missing) return usage("--out takes a file path outside the repository", table, io);
  const extra = out.rest.filter((a) => a.startsWith("-"));
  if (extra.length) return usage(`export does not take ${extra.join(" ")}`, table, io);
  const named = positionals(out.rest);
  if (named.length !== 1) return usage(`export takes one stack: ${STACK_OP_WORDS.usage.export}`, table, io);
  if (!out.value) return usage(`export needs --out <file>, a path on your machine outside every git working tree: ${STACK_OP_WORDS.usage.export}`, table, io);
  const read = readConfig(io.cwd);
  if ("error" in read) return usage(read.error, table, io);
  const stack = resolveStack(read.config, read.path, named[0]!, common.dir);
  if ("error" in stack) return usage(stack.error, table, io);
  useBackend([stack], io.env);
  const rules = requestRules(read.config);
  const outFile = resolve(io.cwd, out.value);
  return runRequest("export", json, table, io, async (ops) => {
    const outcome = await ops.gatedStackExport({
      by: requesterOf(common.by, io.env), rules, op: STACK_OPS_OP, ledgerCwd: io.cwd, env: io.env,
      dir: stack.dir, stack: stack.stack, out: outFile, ...(stack.engine ? { engine: stack.engine } : {}),
    });
    return reportOutcome("export", outcome, stack.stack, rules, (r) => STACK_OP_WORDS.exported(stack.key, r), json, table, io);
  });
}

/** `plywood cancel <stack> --lock <id> [--by <name>] [--dir <path>] [--json]`. */
export async function cancelStack(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const common = commonFlags(args);
  if (common.missing) return usage(`${common.missing} takes a value`, table, io);
  const lock = takeFlag(common.rest, "--lock");
  if (lock.missing) return usage("--lock takes the lock id", table, io);
  const extra = lock.rest.filter((a) => a.startsWith("-"));
  if (extra.length) return usage(`cancel does not take ${extra.join(" ")}`, table, io);
  const named = positionals(lock.rest);
  if (named.length !== 1) return usage(`cancel takes one stack: ${STACK_OP_WORDS.usage.cancel}`, table, io);
  const read = readConfig(io.cwd);
  if ("error" in read) return usage(read.error, table, io);
  const stack = resolveStack(read.config, read.path, named[0]!, common.dir);
  if ("error" in stack) return usage(stack.error, table, io);
  useBackend([stack], io.env);
  // chant#4615: with no --lock, the one lock a file:// backend holds for the stack.
  const lockId = await lockToCancel(lock.value, stack, io.env);
  if ("error" in lockId) return usage(lockId.error, table, io);
  if (lockId.read && !json) io.err(`${PRODUCT} cancel: ${stack.key} holds lock ${lockId.lockId}`);
  const rules = requestRules(read.config);
  return runRequest("cancel", json, table, io, async (ops) => {
    const outcome = await ops.gatedStackCancel({
      by: requesterOf(common.by, io.env), rules, op: STACK_OPS_OP, ledgerCwd: io.cwd, env: io.env,
      dir: stack.dir, stack: stack.stack, lockId: lockId.lockId, project: stack.project, ...(stack.engine ? { engine: stack.engine } : {}),
    });
    return reportOutcome("cancel", outcome, stack.stack, rules, (r) => STACK_OP_WORDS.cancelled(stack.key, lockId.lockId, r.lockChecked), json, table, io);
  });
}

/**
 * `plywood move <urn>... --from <stack> --to <stack> [--by <name>] [--json]`,
 * or `plywood move <stack> --onto plunge`.
 */
export async function moveStack(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const onto = takeFlag(args, "--onto");
  if (onto.missing) return usage("--onto takes plunge", table, io);
  if (onto.value !== undefined) return moveOntoPlunge(onto.value, onto.rest, json, table, io);

  const common = commonFlags(onto.rest);
  if (common.missing) return usage(`${common.missing} takes a value`, table, io);
  const from = takeFlag(common.rest, "--from");
  const to = takeFlag(from.rest, "--to");
  if (from.missing || to.missing) return usage(`${from.missing ? "--from" : "--to"} takes a stack, as project/stack`, table, io);
  const extra = to.rest.filter((a) => a.startsWith("-"));
  if (extra.length) return usage(`move does not take ${extra.join(" ")}`, table, io);
  if (common.dir !== undefined) return usage("move reads each stack's directory from plywood.yml's stacks, so it does not take --dir", table, io);
  const urns = positionals(to.rest);
  if (!from.value || !to.value) return usage(`move needs --from and --to: ${STACK_OP_WORDS.usage.move}`, table, io);
  if (urns.length === 0) return usage(`move names each resource it moves by URN: ${STACK_OP_WORDS.usage.move}`, table, io);
  const bad = urns.filter((u) => !u.startsWith("urn:pulumi:"));
  if (bad.length) return usage(`move takes URNs (urn:pulumi:...), not ${bad.join(", ")}; 'pulumi stack --show-urns' lists them`, table, io);
  if (from.value === to.value) return usage(`--from and --to are both ${from.value}; a move is between two stacks`, table, io);

  const read = readConfig(io.cwd);
  if ("error" in read) return usage(read.error, table, io);
  const source = resolveStack(read.config, read.path, from.value, undefined);
  if ("error" in source) return usage(source.error, table, io);
  const dest = resolveStack(read.config, read.path, to.value, undefined);
  if ("error" in dest) return usage(dest.error, table, io);
  const backend = useBackend([source, dest], io.env);
  if (backend) return usage(backend, table, io);
  const rules = requestRules(read.config);
  const destName = destStackName(source, dest, read.config);
  const engine = source.engine ?? dest.engine;
  return runRequest("move", json, table, io, async (ops) => {
    const outcome = await ops.gatedStackMove({
      by: requesterOf(common.by, io.env), rules, op: STACK_OPS_OP, ledgerCwd: io.cwd, env: io.env,
      source: { member: source.key, dir: source.dir, stack: source.stack },
      dest: { member: dest.key, dir: dest.dir, stack: destName },
      urns,
      ...(engine ? { engine } : {}),
    });
    return reportOutcome("move", outcome, `move:${source.stack}:${destName}`, rules, (r) => STACK_OP_WORDS.moved(source.key, dest.key, r), json, table, io);
  });
}

/** `plywood move <stack> --onto plunge`: chant's adopt Op, as plywood init wrote it (chant#4562). */
async function moveOntoPlunge(engine: string, args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  if (engine !== "plunge") return usage(`--onto takes plunge, not '${engine}'; a move between backends is an export and an import (see '${PRODUCT} export')`, table, io);
  const extra = args.filter((a) => a.startsWith("-"));
  if (extra.length) return usage(`move --onto does not take ${extra.join(" ")}`, table, io);
  const named = positionals(args);
  if (named.length > 1) return usage(`move --onto plunge takes at most one stack`, table, io);
  const read = readConfig(io.cwd);
  if ("error" in read) return usage(read.error, table, io);
  const opFile = join(dirname(read.path), ADOPT_OP_FILE);
  if (!existsSync(opFile)) return usage(STACK_OP_WORDS.noAdoptOp(opFile), table, io);
  if (named[0]) {
    const stack = resolveStack(read.config, read.path, named[0], undefined);
    if ("error" in stack) return usage(stack.error, table, io);
    if (!json) io.err(STACK_OP_WORDS.adoptAll(stack.key));
  }
  const argv = ["run", ADOPT_OP, ...(json ? ["--json"] : [])];
  return withChant(`${PRODUCT} move --onto plunge`, table, io, async (chant) => {
    const code = await chant.runChantInProcess(argv, PRODUCT_WORDS);
    if (code === table.waiting && !json) io.err(STACK_OP_WORDS.adoptWaiting);
    return code === table.waiting ? code : explainRefusal(code, table, io.err);
  });
}

/**
 * `plywood rollback <stack> [--digest <sha256:...>] [--env <env>]` or
 * `plywood rollback --release <name> --env <env>`, each with `[--dry-run]
 * [--actor <name>] [--events-json] [--json]`: chant components rollback
 * (chant#4542) with plywood's words.
 */
export async function rollbackStack(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const release = takeFlag(args, "--release");
  const env = takeFlag(release.rest, "--env");
  const digest = takeFlag(env.rest, "--digest");
  const actor = takeFlag(digest.rest, "--actor");
  for (const [flag, f] of [["--release", release], ["--env", env], ["--digest", digest], ["--actor", actor]] as const) {
    if (f.missing) return usage(`${flag} takes a value`, table, io);
  }
  const switches: string[] = actor.rest.filter((a) => a === "--dry-run" || a === "--events-json");
  const rest = actor.rest.filter((a) => !switches.includes(a));
  const extra = rest.filter((a) => a.startsWith("-"));
  if (extra.length) return usage(`rollback does not take ${extra.join(" ")}`, table, io);
  const named = positionals(rest);
  if (named.length > 1) return usage(`rollback takes one stack: ${STACK_OP_WORDS.usage.rollback}`, table, io);

  let argv: string[];
  if (release.value !== undefined) {
    if (named.length) return usage(STACK_OP_WORDS.releaseIsEnvWide(named[0]!, environmentOf(named[0]!)), table, io);
    if (digest.value !== undefined) return usage("--release takes no --digest: the release names what each stack goes back to", table, io);
    if (!env.value) return usage(`rollback --release needs --env <env>, the environment whose stacks go back: ${STACK_OP_WORDS.usage.rollback}`, table, io);
    argv = ["components", "rollback", env.value, "--release", release.value];
  } else {
    if (named.length !== 1) return usage(`rollback takes a stack, or --release <name> --env <env>: ${STACK_OP_WORDS.usage.rollback}`, table, io);
    const read = readConfig(io.cwd);
    if ("error" in read) return usage(read.error, table, io);
    const stack = resolveStack(read.config, read.path, named[0]!, undefined);
    if ("error" in stack) return usage(stack.error, table, io);
    // plywood init names each stack's component after its key (src/init/render.ts componentName).
    argv = ["components", "rollback", env.value ?? environmentOf(stack.stack), "--component", slug(stack.key), ...(digest.value ? ["--digest", digest.value] : [])];
  }
  argv.push(...(actor.value ? ["--actor", actor.value] : []), ...switches, ...(json ? ["--json"] : []));

  if (!(await chantStackRollback())) {
    io.err(`${PRODUCT}: ${needsStackOpsMessage(`${PRODUCT} rollback`, "rollback by release for stacks (chant#4542)")}`);
    return table.failed;
  }
  return withChant(`${PRODUCT} rollback`, table, io, async (chant) => {
    const code = await chant.runChantInProcess(argv, PRODUCT_WORDS);
    if (code === table.waiting && !json) io.err(STACK_OP_WORDS.rollbackWaiting);
    return code === table.waiting ? code : explainRefusal(code, table, io.err);
  });
}
