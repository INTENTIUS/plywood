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

/** How many of the `wanted` runs of `op` since `since` have finished (any status). */
export function finishedRuns(records: readonly LedgerRecord[], op: string, since: string, onlyWaves: boolean): number {
  return records.filter((r) => r.op === op && r.started >= since && (!onlyWaves || r.wave !== undefined)).length;
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
