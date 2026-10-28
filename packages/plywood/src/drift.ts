/**
 * `plywood drift` and the scheduled drift jobs (plywood#8). The read is
 * chant's, run in process with plywood's words; plywood holds the words of
 * the issue and the defaults.
 *
 *   plywood drift [<stack>...] [--op <name>] [--resource <urn>] [--env <env>]
 *                 [--forge github|gitlab|forgejo] [--respond issue|pull-request|up|none] [--json]
 *       For each stack, chant's `workspace drift --member <stack>`: the
 *       pulumi lexicon's drift read, `pulumi refresh --preview-only --json
 *       --target <urn>` per resource on stock Pulumi and `plunge drift
 *       --resource <urn> --stream` on plunge, over the export the last
 *       update stored under refs/chant/snapshots (chant#4546) or a
 *       checked-in stack-export.json. A drifted or missing resource is
 *       drift, as PulumiWatchOp counts it. With --forge, each stack keeps
 *       one issue through chant's forge client (`trackIssue`): opened on the
 *       first finding, edited when the finding changes, closed by a clean
 *       run. respond.drift up then runs the waves holding the drifted
 *       stacks through `plywood up`, each through its gate. The run exits
 *       with chant's `drift` code when any stack drifted, as pulumi/actions'
 *       expect-no-changes does, and `failed` when a read could not run.
 *
 *   plywood ci, with drift.schedule set
 *       writes ops/plywood-drift.op.ts, one chant PulumiWatchOp per stack on
 *       the schedule, and .chant/ops/plywood-drift.spec.json, then has
 *       chant's Op pipeline generator (`run --generate <forge> --spec`)
 *       write the scheduled jobs. Each job runs `plywood drift --op <name>
 *       --forge <forge>` (the spec's `runCommand`), after fetching
 *       refs/chant/snapshots, and gets the issue permission chant's
 *       `findingMode` grants. `chant run plywood-drift-<stack>` runs the
 *       same stack's PulumiWatchOp by hand.
 *
 * Nothing here runs pulumi, plunge or git: chant does.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { toChantSettings } from "./chant-config";
import type { ChantProduct, ForgeKind } from "./chant-product";
import { driftResponseOf, driftSettingsOf, driftStacksOf, DRIFT_RESPONSES, type DriftResponse } from "./config/drift";
import { checkConfig, findConfig, loadConfig, type RawConfig } from "./config/index";
import { stacksOf } from "./config/stacks";
import { FORGES } from "./config/routing";
import type { ExitTable } from "./exit-codes";
import { chantPipelineOptions } from "./images";
import { positionals, takeFlag, usage, withChant, type StageIo } from "./stages";
import { up } from "./up";
import {
  BIN,
  driftClearedComment,
  driftIssueBody,
  driftIssueMarker,
  driftIssueTitle,
  driftOpName,
  PRODUCT,
  PRODUCT_WORDS,
  type DriftRow,
  type ProductWordsInput,
} from "./words";

/** The Op file `plywood ci` writes; chant discovers `*.op.ts` beside chant.config.ts. */
export const DRIFT_OP_FILE = "ops/plywood-drift.op.ts";
/** The scheduled Op spec chant's generator reads. */
export const DRIFT_SPEC_FILE = ".chant/ops/plywood-drift.spec.json";
/** The ref chant's pulumi apply stores each stack's export under (chant#4546, #4519). */
export const SNAPSHOTS_REF = "refs/chant/snapshots";
/** The line a drift job runs before the read, so chant finds the stored export; a repository with none yet reads the checked-in file. */
export const SNAPSHOTS_FETCH = `git fetch --no-tags origin '+${SNAPSHOTS_REF}:${SNAPSHOTS_REF}' || true`;

/** The statuses that count as drift, as PulumiWatchOp's `drifted` counts them. */
export const DRIFT_STATUSES = ["drifted", "missing"] as const;

/** The parts of chant's drift document plywood reads (`@intentius/chant/drift-record`). */
export interface DriftDoc {
  records?: Array<{ address: string; status: string; observedAt?: string; attributes?: Array<{ path: string }> }>;
  counts?: Record<string, number>;
  error?: { code: string; message: string };
}

/** The drifted and missing resources in a drift document, sorted by URN. */
export function driftRows(doc: DriftDoc): DriftRow[] {
  return (doc.records ?? [])
    .filter((r) => (DRIFT_STATUSES as readonly string[]).includes(r.status))
    .map((r) => ({ urn: r.address, status: r.status, attributes: (r.attributes ?? []).map((a) => a.path).sort() }))
    .sort((a, b) => (a.urn < b.urn ? -1 : a.urn > b.urn ? 1 : 0));
}

/** A finding's fingerprint: the same rows give the same one, whenever they are read. */
export function driftFingerprint(rows: readonly DriftRow[]): string {
  const text = rows.map((r) => `${r.urn}\t${r.status}\t${r.attributes.join(",")}`).join("\n");
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** The latest observation time in the document, else now. */
function observedAt(doc: DriftDoc): string {
  const times = (doc.records ?? []).map((r) => r.observedAt).filter((t): t is string => typeof t === "string").sort();
  return times[times.length - 1] ?? new Date().toISOString();
}

/** The part of chant's forge client (`PrForge`, `@intentius/chant/pr-forge`) `plywood drift` calls. */
export interface DriftForge {
  runUrl?: string;
  trackIssue(
    marker: string,
    finding: { title: string; body: string } | null,
    opts?: { closeOnClear?: boolean; clearComment?: string; sameWhen?: string },
  ): Promise<{ action: string; number?: number; url?: string }>;
}

let forgeOverride: ((kind: ForgeKind, env: NodeJS.ProcessEnv) => Promise<DriftForge>) | undefined;

/** Tests stand in a fake forge client; `reset` goes back to chant's. */
export function setDriftForgeForTests(fake: ((kind: ForgeKind, env: NodeJS.ProcessEnv) => Promise<DriftForge>) | "reset"): void {
  forgeOverride = fake === "reset" ? undefined : fake;
}

/** chant's forge client for the job's forge, from the job's own variables. */
async function forgeFor(kind: ForgeKind, env: NodeJS.ProcessEnv): Promise<DriftForge> {
  if (forgeOverride) return forgeOverride(kind, env);
  const m = (await import("@intentius/chant/pr-forge")) as unknown as {
    forgeTargetFromEnv(env: Record<string, string | undefined>, opts: { kind: ForgeKind }): unknown;
    forgeClient(target: unknown): DriftForge;
  };
  return m.forgeClient(m.forgeTargetFromEnv(env, { kind }));
}

export interface StackDrift {
  stack: string;
  ok: boolean;
  drifted: number;
  rows: DriftRow[];
  /** When chant read the stack, from the records. */
  observedAt?: string;
  error?: string;
  issue?: { action: string; number?: number; url?: string };
}

/** The waves (1-based) that hold any of `stacks`; every wave when plywood.yml lists none. */
export function wavesHolding(doc: RawConfig, stacks: readonly string[]): number[] | "all" {
  if (!Array.isArray(doc.waves)) return "all";
  return (doc.waves as string[][]).flatMap((w, i) => (w.some((s) => stacks.includes(s)) ? [i + 1] : []));
}

/** `plywood drift`; see the module comment. */
export async function drift(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const opFlag = takeFlag(args, "--op");
  const resource = takeFlag(opFlag.rest, "--resource");
  const envFlag = takeFlag(resource.rest, "--env");
  const forgeFlag = takeFlag(envFlag.rest, "--forge");
  const respondFlag = takeFlag(forgeFlag.rest, "--respond");
  const stackFlag = takeFlag(respondFlag.rest, "--stack");
  for (const [flag, f] of [["--op", opFlag], ["--resource", resource], ["--env", envFlag], ["--forge", forgeFlag], ["--respond", respondFlag], ["--stack", stackFlag]] as const) {
    if (f.missing) return usage(`${flag} takes a value`, table, io);
  }
  const unknown = stackFlag.rest.filter((a) => a.startsWith("-"));
  if (unknown.length) return usage(`drift does not take ${unknown.join(" ")}`, table, io);
  if (forgeFlag.value !== undefined && !(FORGES as readonly string[]).includes(forgeFlag.value)) return usage(`--forge ${forgeFlag.value} is not one of ${FORGES.join(", ")}`, table, io);
  if (respondFlag.value !== undefined && !(DRIFT_RESPONSES as readonly string[]).includes(respondFlag.value)) return usage(`--respond takes one of ${DRIFT_RESPONSES.join(", ")}`, table, io);

  const path = findConfig(io.cwd);
  if (!path) return usage(`no plywood.yml in ${io.cwd} or above it; run '${PRODUCT} init' first`, table, io);
  const config = loadConfig(path);
  const errors = checkConfig(config).filter((p) => p.severity === "error");
  if (errors.length) {
    for (const p of errors) io.err(`${path}: ${p.key} ${p.message}`);
    return table.failed;
  }
  const doc = config.doc;
  const listed = Object.keys(stacksOf(doc));
  const named = [...positionals(stackFlag.rest), ...(stackFlag.value ? [stackFlag.value] : [])];
  let stacks: string[];
  if (opFlag.value !== undefined) {
    const hit = listed.find((s) => driftOpName(s) === opFlag.value);
    if (!hit) return usage(`--op ${opFlag.value} names no stack in ${path}; run '${PRODUCT} ci' to write the drift jobs again`, table, io);
    stacks = [hit];
  } else stacks = named.length ? named : driftStacksOf(doc);
  if (stacks.length === 0) return usage(`${path} lists no stacks to read; name one, or list them under stacks`, table, io);
  const strangers = listed.length ? stacks.filter((s) => !listed.includes(s)) : [];
  if (strangers.length) return usage(`${strangers.join(", ")} ${strangers.length === 1 ? "is" : "are"} not under stacks in ${path}`, table, io);
  if (resource.value !== undefined && stacks.length !== 1) return usage("--resource reads one resource of one stack; name the stack", table, io);
  const respond: DriftResponse = (respondFlag.value as DriftResponse | undefined) ?? driftResponseOf(doc);
  const forge = forgeFlag.value as ForgeKind | undefined;

  return withChant(`${PRODUCT} drift`, table, io, async (chant) => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-drift-"));
    const results: StackDrift[] = [];
    try {
      for (const stack of stacks) results.push(await readStack(chant, stack, dir, { resource: resource.value, env: envFlag.value }));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    let upkeepFailed = false;
    if (forge && respond !== "none") {
      let client: DriftForge | undefined;
      try {
        client = await forgeFor(forge, io.env);
      } catch (e) {
        io.err(`${PRODUCT} drift: no ${forge} client for the drift issues: ${(e as Error).message}`);
        upkeepFailed = true;
      }
      for (const r of client ? results.filter((x) => x.ok) : []) {
        try {
          r.issue = await keepIssue(client!, r, respond);
        } catch (e) {
          io.err(`${PRODUCT} drift: ${r.stack}'s issue: ${(e as Error).message}`);
          upkeepFailed = true;
        }
      }
    }
    if (respond === "pull-request" && results.some((r) => r.drifted > 0)) {
      io.err(`${PRODUCT} drift: respond.drift is pull-request; the drift agent's pull request is plywood's agent feature, so this run kept the issue only`);
    }

    const drifted = results.filter((r) => r.drifted > 0).map((r) => r.stack);
    let upCode: number | undefined;
    if (respond === "up" && drifted.length) {
      const waves = wavesHolding(doc, drifted);
      io.err(`${PRODUCT} drift: respond.drift is up; updating ${waves === "all" ? "every wave" : `wave ${waves.join(", ")}`} for ${drifted.join(", ")}, each through its gate`);
      if (waves === "all") upCode = await up([], false, table, io);
      else
        for (const k of waves) {
          upCode = await up(["--wave", String(k)], false, table, io);
          if (upCode !== table.done) break;
        }
    }

    const failed = results.some((r) => !r.ok) || upkeepFailed;
    const code = failed ? table.failed : upCode !== undefined && upCode !== table.done ? upCode : drifted.length ? table.drift : table.done;
    if (json) {
      io.out(JSON.stringify({ command: "drift", ok: code === table.done, exitCode: code, respond, stacks: results }));
    } else {
      for (const r of results) {
        if (!r.ok) io.out(`${r.stack}: the drift read failed: ${r.error}`);
        else if (r.drifted === 0) io.out(`${r.stack}: matches its state${r.issue && r.issue.action === "closed" ? `; closed issue #${r.issue.number}` : ""}`);
        else {
          io.out(`${r.stack}: ${r.drifted} resource${r.drifted === 1 ? "" : "s"} drifted${r.issue ? ` (issue #${r.issue.number ?? "?"} ${r.issue.action})` : ""}`);
          for (const row of r.rows) io.out(`  ${row.status.padEnd(8)} ${row.urn}${row.attributes.length ? `  ${row.attributes.join(", ")}` : ""}`);
        }
      }
    }
    return code;
  });
}

/** One stack's read: chant's `workspace drift`, written to a file plywood reads back. */
async function readStack(chant: ChantProduct, stack: string, dir: string, opts: { resource?: string; env?: string }): Promise<StackDrift> {
  const file = join(dir, `${driftOpName(stack)}.json`);
  const argv = ["workspace", "drift", "--member", stack, ...(opts.resource ? ["--resource", opts.resource] : []), ...(opts.env ? ["--env", opts.env] : []), "-o", file];
  const code = await chant.runChantInProcess(argv, PRODUCT_WORDS);
  let doc: DriftDoc | undefined;
  try {
    if (existsSync(file)) doc = JSON.parse(readFileSync(file, "utf8")) as DriftDoc;
  } catch (e) {
    return { stack, ok: false, drifted: 0, rows: [], error: `chant wrote a drift document plywood cannot read: ${(e as Error).message}` };
  }
  if (code !== 0 || !doc || doc.error) {
    return { stack, ok: false, drifted: 0, rows: [], error: doc?.error ? `${doc.error.code}: ${doc.error.message}` : `chant workspace drift exited ${code}` };
  }
  const rows = driftRows(doc);
  return { stack, ok: true, drifted: rows.length, rows, observedAt: observedAt(doc) };
}

/** Keep the stack's one issue in line with its read. */
async function keepIssue(client: DriftForge, r: StackDrift, respond: DriftResponse): Promise<{ action: string; number?: number; url?: string }> {
  const at = r.observedAt ?? new Date().toISOString();
  const marker = driftIssueMarker(r.stack);
  if (r.drifted === 0) return client.trackIssue(marker, null, { closeOnClear: true, clearComment: driftClearedComment(r.stack, at) });
  const fingerprint = driftFingerprint(r.rows);
  const body = driftIssueBody({ stack: r.stack, rows: r.rows, observedAt: at, fingerprint, ...(client.runUrl ? { runUrl: client.runUrl } : {}), respond });
  return client.trackIssue(marker, { title: driftIssueTitle(r.stack), body }, { sameWhen: fingerprint });
}

/** The PulumiWatchOp file for the stacks, one Op per stack on `schedule`. */
export function driftOpFile(doc: RawConfig, stacks: readonly string[], schedule: string): string {
  const listed = stacksOf(doc);
  const lines = [
    `// Written by '${PRODUCT} ci' from plywood.yml's drift key, and written again on each run: edit plywood.yml, not this file.`,
    `// One chant PulumiWatchOp per stack; the scheduled jobs run '${PRODUCT} drift --op <name>', and 'chant run <name>' runs one by hand.`,
    `import { PulumiWatchOp } from "@intentius/chant-lexicon-pulumi";`,
    "",
  ];
  for (const stack of stacks) {
    const name = driftOpName(stack);
    const pulumiStack = stack.slice(stack.indexOf("/") + 1);
    const dir = listed[stack]?.dir ?? ".";
    const config = { name, member: stack, dir, stack: pulumiStack, schedule };
    const fields = Object.entries(config).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
    lines.push(`export const ${name.replace(/-/g, "_")} = PulumiWatchOp({ ${fields} }).op;`);
  }
  return lines.join("\n") + "\n";
}

/** chant's scheduled Op spec (`ScheduledOpSpec[]` and `ComponentPipelineOptions`) for the drift jobs. */
export function driftOpSpec(doc: RawConfig, forge: ForgeKind, stacks: readonly string[], schedule: string): { ops: unknown[]; options: Record<string, unknown> } {
  const respond = driftResponseOf(doc);
  const findingMode = respond === "none" ? "report" : respond === "pull-request" ? (forge === "gitlab" ? "merge-request" : "pull-request") : "issue";
  const pipeline = toChantSettings({ doc }).pipeline;
  const engine = chantPipelineOptions({ ...(pipeline.image ? { image: pipeline.image } : {}), ...(pipeline.engineSetup ? { engineSetup: pipeline.engineSetup } : {}) }, false);
  return {
    ops: stacks.map((s) => ({ name: driftOpName(s), trigger: { kind: "cron", schedule }, findingMode })),
    options: {
      runCommand: [...BIN.split(/\s+/), "drift", "--op", "{name}", "--forge", forge],
      beforeScript: [SNAPSHOTS_FETCH, ...(engine.beforeScript ?? [])],
      ...(engine.image ? { image: engine.image } : {}),
    },
  };
}

/** Where chant's Op generator writes for each forge (chant run-generate.ts `DEFAULT_OP_PIPELINE_DIRS`). */
const OP_OUTPUT_DIR: Readonly<Record<ForgeKind, string>> = { github: ".github/workflows", forgejo: ".forgejo/workflows", gitlab: "." };

/** Write `text` at `file` under `cwd` when it differs; true when it was written. */
function writeIfChanged(cwd: string, file: string, text: string): boolean {
  const path = join(cwd, file);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/**
 * The scheduled drift jobs, for `plywood ci`: the Op file, the spec, and
 * chant's generator over them. Nothing when plywood.yml has no
 * drift.schedule.
 */
export async function writeDriftJobs(chant: ChantProduct, forge: ForgeKind, doc: RawConfig, words: ProductWordsInput, table: ExitTable, io: StageIo): Promise<number> {
  const settings = driftSettingsOf(doc);
  if (!settings.schedule) return table.done;
  if (settings.stacks.length === 0) {
    io.err(`${PRODUCT} ci: drift.schedule is set and plywood.yml lists no stacks, so no drift job was written`);
    return table.done;
  }
  if (writeIfChanged(io.cwd, DRIFT_OP_FILE, driftOpFile(doc, settings.stacks, settings.schedule))) io.err(`${PRODUCT} ci: wrote ${DRIFT_OP_FILE}; commit it with the workflow`);
  if (writeIfChanged(io.cwd, DRIFT_SPEC_FILE, JSON.stringify(driftOpSpec(doc, forge, settings.stacks, settings.schedule), null, 2) + "\n")) io.err(`${PRODUCT} ci: wrote ${DRIFT_SPEC_FILE}`);
  const outDir = OP_OUTPUT_DIR[forge];
  const code = await chant.runChantInProcess(["run", "--generate", forge, "--spec", DRIFT_SPEC_FILE, "--output", outDir], words);
  if (code !== table.done) return code;
  const dir = join(io.cwd, outDir);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && (readFileSync(join(dir, f), "utf8").split("\n", 1)[0] ?? "").includes(`--spec ${DRIFT_SPEC_FILE}`))
    : [];
  for (const f of files) io.err(`${PRODUCT} ci: drift job at ${join(outDir, f).replace(/^\.\//, "")} on ${settings.schedule}`);
  if (files.length && forge === "gitlab") io.err(`${PRODUCT} ci: GitLab runs the drift job from a pipeline schedule; include the file from .gitlab-ci.yml and add a schedule`);
  return table.done;
}
