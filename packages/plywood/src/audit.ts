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
 *   record         the audit record in the reports bucket: `audit.jsonl`,
 *                  one `chant.audit/v1` line per approval, override and
 *                  update, which `plywood estate` writes. It reads
 *                  `reports.bucket` (or `--bucket <url>`) and takes
 *                  `--since <time>` and `--json`. A line another format wrote
 *                  is read as chant.audit/v1.
 *
 * Any other chant table name (`deploys`, `snapshots`, `resources`) passes as
 * written. `--stack shop/prod-east` reads the stack's project member, the
 * workspace member `plywood init` names after the project, since the ledger
 * keeps rows per member.
 */
import { chantReportStore, readAuditText, type AuditLineView } from "./audit-record";
import { toChantSettings } from "./chant-config";
import { checkConfig, ConfigError, findConfig, loadConfig } from "./config/index";
import { chantEstate } from "./estate";
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

/** The word that reads the reports bucket's record. */
export const AUDIT_RECORD_WORD = "record";

/** `plywood audit record`: `audit.jsonl` from the reports bucket, as `chant.audit/v1` lines. */
export async function auditRecord(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const bucket = takeFlag(args, "--bucket");
  const since = takeFlag(bucket.rest, "--since");
  const file = takeFlag(since.rest, "--file");
  for (const [flag, f] of [["--bucket", bucket], ["--since", since], ["--file", file]] as const) if (f.missing) return usage(`${flag} takes a value`, table, io);
  if (file.rest.length) return usage(`audit ${AUDIT_RECORD_WORD} does not take ${file.rest.join(" ")}`, table, io);
  let url = bucket.value;
  if (!url) {
    const path = file.value ?? findConfig(io.cwd);
    if (path) {
      try {
        const config = loadConfig(path);
        if (checkConfig(config).some((p) => p.severity === "error")) return usage(`${path} has errors; run '${PRODUCT} check'`, table, io);
        url = toChantSettings(config).ci.reportUrl;
      } catch (e) {
        return usage(e instanceof ConfigError ? e.message : `${path}: ${(e as Error).message}`, table, io);
      }
    }
  }
  if (!url) return usage("audit record reads the reports bucket: set reports.bucket in plywood.yml or pass --bucket <url>", table, io);
  const chant = await chantEstate();
  const target = chant.parseReportUrl(url, bucket.value ? "--bucket" : "reports.bucket");
  if (target && typeof target === "object" && "error" in target) return usage(String((target as { error: unknown }).error), table, io);
  const { AUDIT_RECORD_FILE } = await chantReportStore();
  const text = await (chant.reportGet(target) as (key: string) => Promise<string | null>)(AUDIT_RECORD_FILE);
  if (text === null) {
    io.err(`${PRODUCT} audit ${AUDIT_RECORD_WORD}: ${url} holds no ${AUDIT_RECORD_FILE}; '${PRODUCT} estate' writes it`);
    return table.failed;
  }
  const read = await readAuditText(text);
  const from = since.value ? Date.parse(since.value) : undefined;
  if (since.value && Number.isNaN(from)) return usage(`--since takes a time, such as 2026-11-01T00:00:00Z`, table, io);
  const lines: AuditLineView[] = read.lines.filter((l) => from === undefined || Date.parse(l.at) >= from);
  if (json) {
    for (const l of lines) io.out(JSON.stringify(l));
    return table.done;
  }
  for (const l of lines) io.out(`${l.at}  ${l.kind}  ${l.what}  ${l.who ?? "-"}  ${l.result}${l.digest ? `  ${l.digest.slice(0, 12)}` : ""}`);
  if (read.unreadable.length) io.err(`${PRODUCT} audit ${AUDIT_RECORD_WORD}: ${read.unreadable.length} line${read.unreadable.length === 1 ? "" : "s"} could not be read (line ${read.unreadable.join(", ")})`);
  return table.done;
}

export async function audit(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  if (args[0] === AUDIT_RECORD_WORD) return auditRecord(args.slice(1), json, table, io);
  const argv = auditArgv(args, json);
  if ("error" in argv) return usage(argv.error, table, io);
  return withChant(`${PRODUCT} audit`, table, io, (chant) => chant.runChantInProcess(argv, PRODUCT_WORDS));
}
