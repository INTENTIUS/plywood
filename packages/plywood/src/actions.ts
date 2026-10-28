/**
 * Day-2 actions (plywood#39): `plywood action <stack> <name>` runs one of
 * the actions plywood.yml declares under `stacks.<stack>.actions`. An action
 * is a `command:local:Command` or `command:remote:Command` resource in the
 * stack, and running it is that resource's replacement (tracker ruling F).
 * chant's pulumi lexicon does the work (`gatedStackAction`, chant#4654):
 *
 *   1. `pulumi preview --json --target <urn> --replace <urn>`; a preview
 *      that changes anything besides that replacement is refused
 *      (`action-scope`), and a URN of another type before it (`action-type`).
 *   2. A gated request `stack-action` under op pulumi-stack-ops, subject
 *      `action:<stack>:<name>`, binding the preview's digest. It waits for
 *      a second person: `plywood approve action:<stack>:<name> --op
 *      pulumi-stack-ops --plan <digest>`.
 *   3. Run again once approved: `pulumi up --yes --target <urn> --replace
 *      <urn>`, recorded on the ledger. A request runs once; `--anew` asks
 *      for a new run of an action that ran already.
 *
 * `plywood action --from-event` is the line chant's action job runs
 * (`build --pr-loop --action-job`): it reads the `/plywood action <stack>
 * <name>` comment or the dispatch's `stack` and `action` inputs through
 * chant's `productActionFromEnv`, and asks anew each time, since every
 * comment is a new request. A retried job still never runs an action twice
 * under one approval.
 *
 * `gatedStackAction` is probed on its own, outside the other stack
 * operations' REQUIRED list, so export, cancel and move keep working on a
 * chant without it; this verb then says which chant it needs and exits with
 * chant's `failed` code.
 */
import { chantProduct, hasChantActions } from "./chant-product";
import { actionsOf } from "./config/stacks";
import type { ExitTable } from "./exit-codes";
import { positionals, usage, type StageIo } from "./stages";
import {
  commonFlags,
  needsStackOpsMessage,
  readConfig,
  reportOutcome,
  requesterOf,
  requestRules,
  resolveStack,
  STACK_OPS_OP,
  useBackend,
  type StackOpCommon,
  type StackOpOutcome,
} from "./stack-ops";
import { ACTION_COMMAND, PRODUCT, PRODUCT_WORDS, STACK_OP_WORDS } from "./words";

/** What a finished action returns (`PulumiStackActionResult`). */
export interface ActionResult {
  urn: string;
  engine: string;
  preview: string;
  exit: number;
  tail: string;
}

/** chant's `gatedStackAction` (lexicons/pulumi/src/stack-ops.ts, chant#4654). */
export type ChantStackAction = (
  opts: StackOpCommon & { dir: string; stack: string; urn: string; name?: string; engine?: string; anew?: boolean },
) => Promise<StackOpOutcome<ActionResult>>;

/** The approval subject chant asks an action under (`stackActionSubject`). */
export const actionSubject = (stack: string, name: string): string => `action:${stack}:${name}`;

/** The last chant release without `gatedStackAction`. */
const ACTIONS_AFTER = "0.124.56";

let cachedAction: Promise<ChantStackAction | undefined> | undefined;

/** chant's gatedStackAction, or undefined when the installed pulumi lexicon lacks it. */
export function chantStackAction(): Promise<ChantStackAction | undefined> {
  cachedAction ??= (async () => {
    try {
      // @ts-ignore: gatedStackAction is newer than the lexicon at the pin (chant#4654).
      const m: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      return typeof m.gatedStackAction === "function" ? (m.gatedStackAction as ChantStackAction) : undefined;
    } catch {
      return undefined;
    }
  })();
  return cachedAction;
}

/** Tests stand in a fake gatedStackAction (or none, for the refusal). `reset` goes back to the real import. */
export function setChantStackActionForTests(fake: ChantStackAction | undefined | "reset"): void {
  cachedAction = fake === "reset" ? undefined : Promise.resolve(fake);
}

/** The message `plywood action` prints on a chant without gatedStackAction. */
export function needsActionsMessage(): string {
  return needsStackOpsMessage(`${PRODUCT} action`, "gated stack actions (gatedStackAction, chant#4654)", ACTIONS_AFTER);
}

/** The stack and action an action job was started for, read through chant (chant#4654). */
async function fromEvent(env: NodeJS.ProcessEnv): Promise<{ stack: string; name: string } | { error: string }> {
  const chant = await chantProduct();
  if (!chant || !hasChantActions(chant)) return { error: `${PRODUCT} action --from-event reads the action job's comment or inputs through chant's productActionFromEnv, which this chant lacks. ${needsActionsMessage()}` };
  const words = chant.assertProductWords({ ...PRODUCT_WORDS, commands: { ...PRODUCT_WORDS.commands, ...ACTION_COMMAND } });
  const asked = chant.productActionFromEnv!(words, env);
  if (asked.kind === "refused") return { error: `the action job was asked for no action: ${asked.reason}` };
  return { stack: asked.member, name: asked.address };
}

/**
 * `plywood action <project/stack> <name> [--anew] [--by <name>] [--dir
 * <path>] [--json]`, or `plywood action --from-event [--json]` in chant's
 * action job.
 */
export async function action(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const event = args.includes("--from-event");
  const anew = event || args.includes("--anew");
  const common = commonFlags(args.filter((a) => a !== "--from-event" && a !== "--anew"));
  if (common.missing) return usage(`${common.missing} takes a value`, table, io);
  const extra = common.rest.filter((a) => a.startsWith("-"));
  if (extra.length) return usage(`action does not take ${extra.join(" ")}`, table, io);
  const named = positionals(common.rest);

  let key: string;
  let name: string;
  if (event) {
    if (named.length) return usage(`action --from-event reads the stack and the action from the job's event, so it takes neither: ${STACK_OP_WORDS.usage.action}`, table, io);
    const asked = await fromEvent(io.env);
    if ("error" in asked) return usage(asked.error, table, io);
    ({ stack: key, name } = asked);
  } else {
    if (named.length !== 2) return usage(`action takes a stack and an action's name: ${STACK_OP_WORDS.usage.action}`, table, io);
    [key, name] = named as [string, string];
  }

  const read = readConfig(io.cwd);
  if ("error" in read) return usage(read.error, table, io);
  const stack = resolveStack(read.config, read.path, key, common.dir);
  if ("error" in stack) return usage(stack.error, table, io);
  const declared = actionsOf(read.config.doc, stack.key);
  const chosen = declared.find((a) => a.name === name);
  if (!chosen) return usage(STACK_OP_WORDS.noAction(stack.key, name, declared.map((a) => a.name)), table, io);

  const gated = await chantStackAction();
  if (!gated) {
    io.err(`${PRODUCT}: ${needsActionsMessage()}`);
    return table.failed;
  }
  useBackend([stack], io.env);
  const rules = requestRules(read.config);
  try {
    const outcome = await gated({
      by: requesterOf(common.by, io.env), rules, op: STACK_OPS_OP, ledgerCwd: io.cwd, env: io.env,
      dir: stack.dir, stack: stack.stack, urn: chosen.urn, name: chosen.name,
      ...(stack.engine ? { engine: stack.engine } : {}),
      ...(anew ? { anew: true } : {}),
    });
    return reportOutcome("action", outcome, actionSubject(stack.stack, chosen.name), rules, (r) => STACK_OP_WORDS.acted(stack.key, chosen.name, r), json, table, io);
  } catch (e) {
    // chant refuses before asking: PulumiStackActionRefused carries `code` (action-urn, action-type, action-scope) and the other URNs.
    const err = e as Error & { code?: unknown; urns?: unknown };
    const refusal = typeof err.code === "string" && err.code.startsWith("action-") ? err.code : undefined;
    const urns = Array.isArray(err.urns) ? (err.urns as string[]) : [];
    if (json) {
      io.out(JSON.stringify({
        command: "action", ok: false, exitCode: table.failed, op: STACK_OPS_OP, gate: actionSubject(stack.stack, chosen.name), error: err.message,
        ...(refusal ? { refusal } : {}), ...(urns.length ? { urns } : {}),
      }));
    } else io.err(`${PRODUCT} action: ${err.message}`);
    return table.failed;
  }
}
