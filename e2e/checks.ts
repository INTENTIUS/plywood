/**
 * What the plywood scenarios check, read from chant's run ledger and from
 * floci, as pure functions over the records so a test feeds them fakes.
 *
 * A harness outcome reads one report or counts ledger runs. The plunge
 * claims need more from the same records: the targets chant keeps per wave
 * job (chant#4555, `wave.targets`) with plunge's per-resource timings as
 * spans (plunge#55, chant#4579), the job's exit code from chant's one table
 * (chant#4553), and the moved runs. The scenarios reach these checks
 * through out-of-band steps whose command starts with `plywood-e2e`
 * (./ports.ts runs those in process), each expecting exit 0.
 */
import type { LedgerRecord, TimedSpan } from "./harness";

/** chant's exit codes the checks name (chant#4553, `CHANT_EXIT`). */
export const EXIT = { done: 0, failed: 1, waiting: 3, moved: 4, held: 5 } as const;

/** What a check found: exit 0 when it held, and the line saying why. */
export interface CheckResult {
  code: number;
  line: string;
}

const ok = (line: string): CheckResult => ({ code: 0, line });
const no = (line: string, code = 1): CheckResult => ({ code, line });

/** Wave job records of `op` that started at or after `since`, oldest first. */
export function waveRuns(records: readonly LedgerRecord[], op: string, since: string): LedgerRecord[] {
  return records
    .filter((r) => r.op === op && r.wave !== undefined && r.started >= since)
    .slice()
    .sort((a, b) => a.started.localeCompare(b.started));
}

/** Whether a run target names `stack` (`shop/dev`, `dev`, or a member path ending in it). */
export const targetIsStack = (target: string, stack: string): boolean =>
  target === stack || target.endsWith(`/${stack}`) || target.endsWith(`:${stack}`) || target.endsWith(`-${stack}`);

/** The target entry of `stack` on a wave record. */
export function stackTarget(r: LedgerRecord, stack: string): { name: string; startedAt: string; durationMs: number; spans: TimedSpan[] } | undefined {
  for (const [name, t] of Object.entries(r.wave?.targets ?? {})) {
    if (targetIsStack(name, stack)) return { name, startedAt: t.startedAt, durationMs: t.durationMs, spans: t.spans ?? [] };
  }
  return undefined;
}

/** A URN's logical name, the part after its last `::`. */
export const urnName = (urn: string): string => urn.slice(urn.lastIndexOf("::") + 2);

/** plunge's provider calls that write the cloud (plunge#55 `kind: provider`). */
const WRITE_CALLS = new Set(["provider create", "provider update", "provider delete"]);

/** The logical names of the resources a target's spans show a cloud write for. */
export function writtenResources(spans: readonly TimedSpan[]): Set<string> {
  const out = new Set<string>();
  for (const s of spans) if ((s.children ?? []).some((c) => WRITE_CALLS.has(c.name))) out.add(urnName(s.name));
  return out;
}

const windowOf = (t: { startedAt: string; durationMs: number }): [number, number] => {
  const start = Date.parse(t.startedAt);
  return [start, start + t.durationMs];
};

/**
 * pw-disjoint's check: two wave jobs of `op` since `since` applied `stack`
 * with exit 0, one wrote `first` and not `second`, the other `second` and
 * not `first`, by plunge's timings, and their applies of the stack ran at
 * the same time. Under a stack lock the second would be held (exit 5) or
 * run after the first, and the check fails.
 */
export function disjointTogether(records: readonly LedgerRecord[], o: { op: string; since: string; stack: string; first: string; second: string }): CheckResult {
  const runs = waveRuns(records, o.op, o.since).filter((r) => stackTarget(r, o.stack));
  const held = runs.filter((r) => r.wave!.exitCode === EXIT.held || r.wave!.outcome === "held");
  if (held.length > 0) return no(`${held.length} ${o.op} job(s) on ${o.stack} were held (exit ${EXIT.held}), so the two updates did not run together`);
  const done = runs.filter((r) => r.wave!.exitCode === EXIT.done && r.wave!.applied.some((a) => targetIsStack(a, o.stack)));
  const by = (name: string, not: string) =>
    done.find((r) => {
      const w = writtenResources(stackTarget(r, o.stack)!.spans);
      return w.has(name) && !w.has(not);
    });
  const a = by(o.first, o.second);
  const b = by(o.second, o.first);
  if (!a || !b || a === b) {
    return no(`no two ${o.op} jobs applied ${o.stack} with exit 0, one writing ${o.first} and the other ${o.second} (by plunge's timings): ${done.length} applied`);
  }
  const [a0, a1] = windowOf(stackTarget(a, o.stack)!);
  const [b0, b1] = windowOf(stackTarget(b, o.stack)!);
  if (!(a0 < b1 && b0 < a1)) return no(`the two updates of ${o.stack} ran one after the other (${new Date(a0).toISOString()}..${new Date(a1).toISOString()} and ${new Date(b0).toISOString()}..${new Date(b1).toISOString()})`);
  return ok(`${o.stack}: ${o.first} and ${o.second} were written by two updates that overlapped by ${Math.min(a1, b1) - Math.max(a0, b0)} ms`);
}

/**
 * pw-moved-plan's check: the newest wave job of `op` since `since` on
 * `stack` refused with chant's moved code (4), named the stack among its
 * moved runs, and was neither gated nor waiting (3).
 */
export function movedNotGated(records: readonly LedgerRecord[], o: { op: string; since: string; stack: string }): CheckResult {
  const runs = waveRuns(records, o.op, o.since).filter((r) => stackTarget(r, o.stack) || r.wave!.moved.some((m) => targetIsStack(m, o.stack)));
  const last = runs[runs.length - 1];
  if (!last) return no(`no ${o.op} job on ${o.stack} since the run started`);
  const w = last.wave!;
  if (last.status === "gated" || w.exitCode === EXIT.waiting) return no(`the ${o.op} job stopped as gated or waiting (exit ${w.exitCode}), not moved`);
  if (w.exitCode !== EXIT.moved) return no(`the ${o.op} job exited ${w.exitCode}, not chant's moved code ${EXIT.moved}`);
  if (!w.moved.some((m) => targetIsStack(m, o.stack))) return no(`the ${o.op} job exited ${EXIT.moved} without naming ${o.stack} among its moved runs`);
  if (w.applied.some((a) => targetIsStack(a, o.stack))) return no(`the ${o.op} job applied ${o.stack} although its plan moved`);
  return ok(`${o.stack}'s saved plan moved: exit ${EXIT.moved}, nothing applied`);
}

/**
 * How many of the `wanted` runs of `op` since `since` have finished (any
 * status). With `stack`, only the wave jobs that targeted it count
 * (plywood#22 finding 10): staging's and prod's records of one merge no
 * longer stand in for the other merge's dev job.
 */
export function finishedRuns(records: readonly LedgerRecord[], op: string, since: string, onlyWaves: boolean, stack?: string): number {
  return records.filter((r) => r.op === op && r.started >= since && (!onlyWaves || r.wave !== undefined) && (stack === undefined || stackTarget(r, stack) !== undefined)).length;
}

/** One Forgejo Actions task as `/repos/<o>/<r>/actions/tasks` lists it. */
export interface ForgeTask {
  id: number;
  name?: string;
  status: string;
}

/** Statuses of a task the runner has not finished: one still running, or one queued behind another. */
export const BUSY_TASK_STATUSES = ["running", "waiting", "blocked"] as const;

/** The tasks still running or waiting (plywood#22 finding 10): an arm's reset waits until there are none. */
export function busyTasks(tasks: readonly ForgeTask[]): ForgeTask[] {
  return tasks.filter((t) => (BUSY_TASK_STATUSES as readonly string[]).includes(t.status));
}

/** Keys of a bucket listing that look like a lock: the DIY backend's lock directory, or any key naming a lock (plunge races.sh). */
export const LOCKISH = /(^|\/)\.pulumi\/locks\/|lock/i;

export const lockishKeys = (keys: readonly string[]): string[] => keys.filter((k) => LOCKISH.test(k));

/** `${NAME}` and `${NAME:-default}` in a command word, from the arm's environment. */
export function expandWord(word: string, env: Record<string, string | undefined>): string {
  return word.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback: string | undefined) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    throw new Error(`the command names \${${name}}, which this arm does not set`);
  });
}

/** Whether a set of SQS tags carries plunge's markers for `name` (plunge's markers/keys.go: plunge-stack, plunge-urn). */
export function hasMarkers(tags: Record<string, string>, name: string, stack: string): boolean {
  const urn = tags["plunge-urn"];
  const owner = tags["plunge-stack"];
  return typeof urn === "string" && urnName(urn) === name && typeof owner === "string" && owner.length > 0 && (owner === stack || owner.endsWith(`/${stack}`) || owner.includes(stack));
}

// ── plywood#22's stock Pulumi claims ────────────────────────────────────

/** A wave record's window on `stack`: its target's timing when chant kept one, else the record's own start and end. */
function stackWindow(r: LedgerRecord, stack: string): [number, number] {
  const t = stackTarget(r, stack);
  return t ? windowOf(t) : [Date.parse(r.started), Date.parse(r.ended)];
}

const appliedStack = (r: LedgerRecord, stack: string): boolean => r.wave!.exitCode === EXIT.done && r.wave!.applied.some((a) => targetIsStack(a, stack));

/**
 * pw-canary's check (`wave/canary`): one wave job of `op` since `since`
 * applied `first` with exit 0, a later wave's job applied `then` with exit 0,
 * and the later one started only after the canary's update of `first`
 * ended. Both stacks in one wave job is a failure: nothing went first.
 */
export function canaryFirst(records: readonly LedgerRecord[], o: { op: string; since: string; first: string; then: string }): CheckResult {
  const runs = waveRuns(records, o.op, o.since);
  const a = runs.find((r) => appliedStack(r, o.first));
  if (!a) return no(`no ${o.op} job applied ${o.first} with exit 0 since the run started`);
  const b = runs.find((r) => appliedStack(r, o.then));
  if (!b) return no(`no ${o.op} job applied ${o.then} with exit 0 since the run started`);
  if (a === b) return no(`${o.first} and ${o.then} updated in one wave job (wave ${a.wave!.number}), so nothing went first`);
  if (a.wave!.number >= b.wave!.number) return no(`${o.first} updated in wave ${a.wave!.number}, not before ${o.then}'s wave ${b.wave!.number}`);
  const [, aEnd] = stackWindow(a, o.first);
  const [bStart] = stackWindow(b, o.then);
  if (bStart < aEnd) return no(`${o.then}'s update started ${aEnd - bStart} ms before the canary's update of ${o.first} ended`);
  return ok(`${o.first} updated in wave ${a.wave!.number}, then ${o.then} in wave ${b.wave!.number}, ${bStart - aEnd} ms after the canary ended`);
}

/**
 * pw-moved-preview's check (`gate/moved-preview`): after a push past the
 * approval, no wave job of `op` since `since` applied `stack`, one stopped
 * gated or waiting (chant's 3), and a wave gate (`wave-<k>`) stands pending
 * since the run started. `pending` is the newest pending gate of `op`.
 */
export function waitsAtGate(records: readonly LedgerRecord[], o: { op: string; since: string; stack: string }, pending: { gate: string } | undefined): CheckResult {
  const runs = waveRuns(records, o.op, o.since);
  const applied = runs.find((r) => r.wave!.applied.some((a) => targetIsStack(a, o.stack)));
  if (applied) return no(`wave ${applied.wave!.number} of ${o.op} applied ${o.stack} although its preview changed after the approval`);
  const waiting = runs.find((r) => r.status === "gated" || r.status === "waiting" || r.wave!.exitCode === EXIT.waiting);
  if (!waiting) return no(`no ${o.op} job stopped at a gate since the run started (${runs.length} wave jobs)`);
  if (!pending) return no(`wave ${waiting.wave!.number} stopped, and no gate of ${o.op} is pending since the run started`);
  if (!/^wave-\d+$/.test(pending.gate)) return no(`the pending gate is ${pending.gate}, not a wave's own gate`);
  return ok(`wave ${waiting.wave!.number} waits at ${pending.gate}; ${o.stack} was not applied`);
}

/**
 * pw-one-note's check (`preview/one-note`): one comment holds every text
 * in `holds` and the approval line `once`, and no other comment repeats
 * that line, so the pull request has one note with one approval command.
 */
export function oneNote(bodies: readonly string[], o: { once: string; holds: readonly string[] }): CheckResult {
  const count = (b: string) => b.split(o.once).length - 1;
  const total = bodies.reduce((n, b) => n + count(b), 0);
  const note = bodies.find((b) => count(b) === 1 && o.holds.every((h) => b.includes(h)));
  if (!note) {
    const missing = o.holds.filter((h) => !bodies.some((b) => b.includes(h)));
    return no(`no comment holds ${JSON.stringify(o.once)} with ${o.holds.map((h) => JSON.stringify(h)).join(" and ")}${missing.length ? ` (no comment holds ${missing.map((m) => JSON.stringify(m)).join(", ")})` : ""}`);
  }
  if (total !== 1) return no(`${JSON.stringify(o.once)} appears ${total} times across ${bodies.length} comments, not once`);
  return ok(`one note holds the approval line and ${o.holds.map((h) => JSON.stringify(h)).join(", ")}`);
}

/** A forge issue as the checks read it. */
export interface IssueView {
  number: number;
  title: string;
  body: string;
  open: boolean;
}

/**
 * pw-drift's check (`drift/issue`): exactly one open issue titled `title`,
 * whose table has a row for the resource named `name` (a URN ending in
 * `::<name>`) listing `attribute`.
 */
export function driftIssueHolds(issues: readonly IssueView[], o: { title: string; name: string; attribute: string }): CheckResult {
  const open = issues.filter((i) => i.open && i.title === o.title);
  if (open.length !== 1) return no(`${open.length} open issues titled "${o.title}", not one`);
  const row = open[0]!.body.split("\n").find((l) => l.startsWith("|") && new RegExp(`::${o.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\`?\\s*\\|`).test(l));
  if (!row) return no(`issue #${open[0]!.number} has no row for a resource named ${o.name}`);
  if (!row.includes(o.attribute)) return no(`issue #${open[0]!.number}'s row for ${o.name} does not name ${o.attribute}: ${row.trim()}`);
  return ok(`issue #${open[0]!.number} names ${o.name} with ${o.attribute}`);
}
