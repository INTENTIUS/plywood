/**
 * `plywood estate [--report-url <url>] [--prefix <p>] [--file <plywood.yml>]
 * [--fail-overdue] [--json]`: the estate page, the overdue drift checks and
 * the delivery metrics, read from the workspace ledger by chant
 * (`@intentius/chant/ci-estate`, chant#4612). plywood keeps no row and no
 * copy of the code: it passes its words, and its drift schedule as the
 * schedules to judge (one `plywood-drift-<stack>` Op per stack on
 * `drift.schedule`).
 *
 * With a report URL (`--report-url`, else plywood.yml's `reports.url`, chant's
 * `ci.reportUrl`) chant writes `estate.json`, `estate.html` and `dora.json`
 * under `<prefix>/` (default `estate`) through the report store
 * (chant#4554), and sends the delivery gauges (`plywood_dora_*`) when an OTLP
 * metrics endpoint is set. Without one it prints the estate and writes
 * nothing.
 *
 * The subpath is imported on first use.
 */
import { dirname } from "node:path";
import { chantProduct } from "./chant-product";
import { toChantSettings } from "./chant-config";
import { checkConfig, ConfigError, findConfig, loadConfig, type PlywoodConfig } from "./config/index";
import type { ExitTable } from "./exit-codes";
import { takeFlag, usage, type StageIo } from "./stages";
import { driftOpName, PRODUCT, PRODUCT_WORDS } from "./words";

/** One schedule chant judges (`DriftSchedule`). */
export interface EstateSchedule {
  op: string;
  cron: string;
}

/** The part of chant's `LedgerEstate` plywood reads. */
export interface ChantLedgerEstate {
  estate: { totals?: Record<string, number> } & Record<string, unknown>;
  dora: Record<string, unknown>;
  overdue: Array<{ op: string; member: string; message: string }>;
}

/** What plywood calls from `@intentius/chant/ci-estate` and the report store. */
export interface ChantEstate {
  readEstateLedger(cwd: string, members?: readonly string[]): Promise<unknown>;
  buildLedgerEstate(input: { load: unknown; words?: unknown; schedules?: readonly EstateSchedule[]; driftOps?: readonly string[] }): ChantLedgerEstate;
  writeEstate(e: ChantLedgerEstate, options: { put: unknown; prefix?: string; words?: unknown; env?: NodeJS.ProcessEnv }): Promise<{ keys: string[]; metrics?: unknown }>;
  parseReportUrl(raw: string, name?: string): unknown;
  reportPut(target: unknown): unknown;
}

let estateModule: Promise<ChantEstate> | undefined;

/** chant's estate (`@intentius/chant/ci-estate`, chant#4612) and report store, imported on first use. */
export function chantEstate(): Promise<ChantEstate> {
  estateModule ??= (async () => {
    const m = await import("@intentius/chant/ci-estate");
    const r = await import("@intentius/chant/pr-report-url");
    return { readEstateLedger: m.readEstateLedger, buildLedgerEstate: m.buildLedgerEstate, writeEstate: m.writeEstate, parseReportUrl: r.parseReportUrl, reportPut: r.reportPut } as unknown as ChantEstate;
  })();
  return estateModule;
}

/** Tests stand in a fake chant estate. `reset` goes back to the real import. */
export function setChantEstateForTests(fake: ChantEstate | "reset"): void {
  estateModule = fake === "reset" ? undefined : Promise.resolve(fake);
}

/** The drift Ops plywood ci writes, and their schedule, for chant to judge. */
export function estateSchedules(config: PlywoodConfig): { schedules: EstateSchedule[]; driftOps: string[] } {
  const drift = toChantSettings(config).pipeline.drift;
  const driftOps = (drift?.stacks ?? []).map(driftOpName);
  const schedules = drift?.schedule ? driftOps.map((op) => ({ op, cron: drift.schedule! })) : [];
  return { schedules, driftOps };
}

/** `plywood estate`. */
export async function estate(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const failOverdue = args.includes("--fail-overdue");
  let rest = args.filter((a) => a !== "--fail-overdue");
  const flags: Record<string, string | undefined> = {};
  for (const flag of ["--file", "--report-url", "--prefix"]) {
    const f = takeFlag(rest, flag);
    if (f.missing) return usage(`${flag} takes a value`, table, io);
    flags[flag] = f.value;
    rest = f.rest;
  }
  if (rest.length) return usage(`estate does not take ${rest.join(" ")}`, table, io);
  const chant = await chantEstate();
  const path = flags["--file"] ?? findConfig(io.cwd);
  let config: PlywoodConfig | undefined;
  if (path) {
    try {
      config = loadConfig(path);
    } catch (e) {
      return usage(e instanceof ConfigError ? e.message : `${path}: ${(e as Error).message}`, table, io);
    }
    const errors = checkConfig(config).filter((p) => p.severity === "error");
    if (errors.length) {
      for (const p of errors) io.err(`${path}: ${p.key} ${p.message}`);
      return table.failed;
    }
  }
  const { schedules, driftOps } = config ? estateSchedules(config) : { schedules: [], driftOps: [] };
  // chant's resolved words when it has the product pipeline; the ledger read takes the words' product, stages and noun.
  const product = await chantProduct();
  const words = product ? product.assertProductWords(PRODUCT_WORDS) : PRODUCT_WORDS;
  const root = path ? dirname(path) : io.cwd;
  const load = await chant.readEstateLedger(root);
  const built = chant.buildLedgerEstate({ load, words, schedules, ...(driftOps.length ? { driftOps } : {}) });

  const url = flags["--report-url"] ?? (config ? toChantSettings(config).ci.reportUrl : undefined);
  let written: { keys: string[]; metrics?: unknown } | undefined;
  if (url) {
    const target = chant.parseReportUrl(url, flags["--report-url"] ? "--report-url" : "reports.url");
    if (target && typeof target === "object" && "error" in target) return usage(String((target as { error: unknown }).error), table, io);
    written = await chant.writeEstate(built, { put: chant.reportPut(target), words, env: io.env, ...(flags["--prefix"] ? { prefix: flags["--prefix"] } : {}) });
  }

  const code = failOverdue && built.overdue.length > 0 ? table.failed : table.done;
  if (json) {
    io.out(JSON.stringify({ command: "estate", ok: code === table.done, exitCode: code, estate: built.estate, dora: built.dora, overdue: built.overdue, ...(written ? { written } : {}) }));
    return code;
  }
  const totals = built.estate.totals ?? {};
  io.out(`${PRODUCT} estate: ${Object.entries(totals).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing on the ledger yet"}`);
  for (const o of built.overdue) io.out(`  ${o.message}`);
  if (written) io.out(`  wrote ${written.keys.join(", ")} under ${url}`);
  else io.out(`  no report URL (reports.url or --report-url), so nothing was written`);
  return code;
}
