/**
 * `plywood audit [<table>] [--stack <project/stack>] [--since <time>]
 * [--where <field><op><value>]... [--at <rev>] [--json]`: one table of the
 * chant workspace ledger on `chant/lifecycle`, read by `chant ledger` in
 * process with plywood's words (chant#4551, #4363). plywood keeps no copy
 * of any row: approvals, updates, runs and review stacks are chant's
 * records, so `plywood audit --json` prints exactly what `chant ledger
 * <table> --json` prints.
 *
 * The tables, in plywood's words:
 *
 *   approvals      gates: each pending gate and each approval, with the
 *                  actor, the time and the plan digest (the default)
 *   updates        applies: each update under an approval, and how it ended
 *   runs           runs: each wave's run record
 *   review-stacks  pr_envs: each review stack made and removed
 *
 * Any other chant table name (`deploys`, `snapshots`, `resources`) passes as
 * written. `--stack shop/prod-east` reads the stack's project member, the
 * workspace member `plywood init` names after the project, since the ledger
 * keeps rows per member.
 */
import type { ExitTable } from "./exit-codes";
import { slug } from "./init/detect";
import { takeFlag, usage, withChant, type StageIo } from "./stages";
import { PRODUCT, PRODUCT_WORDS } from "./words";

/** plywood's table words to chant's ledger tables. */
export const AUDIT_TABLES = { approvals: "gates", updates: "applies", runs: "runs", "review-stacks": "pr_envs" } as const;
export const DEFAULT_AUDIT_TABLE = "approvals";

/** chant's ledger table for what a person typed. */
export function auditTable(word: string | undefined): string {
  const w = word ?? DEFAULT_AUDIT_TABLE;
  return (AUDIT_TABLES as Record<string, string>)[w] ?? w;
}

/** The workspace member a stack's rows are under: the slug of its project. */
export function auditMember(stack: string): string | undefined {
  const [project, name] = stack.split("/");
  // As plywood init names the member (src/init/render.ts memberName).
  return project && name ? slug(project).slice(0, 36).replace(/-+$/, "") : undefined;
}

/** chant's `ledger` argv for `plywood audit`'s arguments, or the usage error. */
export function auditArgv(args: string[], json: boolean): string[] | { error: string } {
  const stack = takeFlag(args, "--stack");
  const since = takeFlag(stack.rest, "--since");
  const at = takeFlag(since.rest, "--at");
  for (const [flag, f] of [["--stack", stack], ["--since", since], ["--at", at]] as const) if (f.missing) return { error: `${flag} takes a value` };
  const wheres: string[] = [];
  const rest: string[] = [];
  for (let i = 0; i < at.rest.length; i++) {
    const a = at.rest[i]!;
    if (a === "--where") {
      const v = at.rest[i + 1];
      if (v === undefined || v.startsWith("--")) return { error: "--where takes <field><op><value>, such as gate=wave-2" };
      wheres.push("--where", v);
      i++;
    } else rest.push(a);
  }
  const flags = rest.filter((a) => a.startsWith("-"));
  if (flags.length) return { error: `audit does not take ${flags.join(" ")}` };
  if (rest.length > 1) return { error: `audit reads one table: ${Object.keys(AUDIT_TABLES).join(", ")}, or a chant ledger table` };
  let member: string | undefined;
  if (stack.value !== undefined) {
    member = auditMember(stack.value);
    if (!member) return { error: `--stack takes project/stack, not '${stack.value}'` };
  }
  return [
    "ledger", auditTable(rest[0]),
    ...(member ? ["--member", member] : []),
    ...(since.value ? ["--since", since.value] : []),
    ...wheres,
    ...(at.value ? ["--at", at.value] : []),
    ...(json ? ["--json"] : []),
  ];
}

export async function audit(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const argv = auditArgv(args, json);
  if ("error" in argv) return usage(argv.error, table, io);
  return withChant(`${PRODUCT} audit`, table, io, (chant) => chant.runChantInProcess(argv, PRODUCT_WORDS));
}
