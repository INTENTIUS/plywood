import { describe, expect, it } from "vitest";
import { busyTasks, disjointTogether, expandWord, hasMarkers, lockishKeys, movedNotGated, urnName, waveRuns, writtenResources } from "../checks";
import type { LedgerRecord, TimedSpan } from "../harness";

const SINCE = "2026-10-28T10:00:00.000Z";
const urn = (name: string) => `urn:pulumi:dev::shop::aws:sqs/queue:Queue::${name}`;
const span = (name: string, calls: string[]): TimedSpan => ({
  name: urn(name),
  startedAt: "2026-10-28T10:01:00.000Z",
  durationMs: 10,
  children: calls.map((c) => ({ name: c, startedAt: "2026-10-28T10:01:00.000Z", durationMs: 5 })),
});

/** A pulumi-up wave job on dev. */
function up(o: { started: string; at: string; ms: number; spans: TimedSpan[]; exit?: number; applied?: string[]; moved?: string[]; status?: LedgerRecord["status"]; outcome?: "held" }): LedgerRecord {
  return {
    id: o.started,
    op: "pulumi-up",
    env: "local",
    started: o.started,
    ended: o.started,
    status: o.status ?? "ok",
    wave: {
      spec: "pulumi-up",
      number: 1,
      name: "dev",
      job: "wave",
      exitCode: o.exit ?? 0,
      ...(o.outcome ? { outcome: o.outcome } : {}),
      applied: o.applied ?? ["shop/dev"],
      failed: [],
      moved: o.moved ?? [],
      targets: { "shop/dev": { startedAt: o.at, durationMs: o.ms, spans: o.spans } },
    },
  };
}

const events = (at: string, ms: number, extra: Partial<Parameters<typeof up>[0]> = {}) =>
  up({ started: at, at, ms, spans: [span("events", ["provider check", "provider diff", "provider update", "record write"]), span("worker-0", ["provider check", "provider diff"])], ...extra });
const workers = (at: string, ms: number, extra: Partial<Parameters<typeof up>[0]> = {}) =>
  up({ started: at, at, ms, spans: [span("events", ["provider check", "provider diff"]), span("worker-3", ["provider check", "provider create", "record write"])], ...extra });
const disjoint = (rs: LedgerRecord[]) => disjointTogether(rs, { op: "pulumi-up", since: SINCE, stack: "dev", first: "events", second: "worker-3" });

describe("pw-disjoint: two updates of one plunge stack, one resource each, at once", () => {
  it("holds when each update wrote its own resource by plunge's timings and the two overlapped", () => {
    const r = disjoint([events("2026-10-28T10:01:00.000Z", 30_000), workers("2026-10-28T10:01:05.000Z", 30_000)]);
    expect(r.code).toBe(0);
    expect(r.line).toMatch(/overlapped by 25000 ms/);
  });

  it("does not hold when the second ran after the first, as under a stack lock", () => {
    const r = disjoint([events("2026-10-28T10:01:00.000Z", 30_000), workers("2026-10-28T10:02:00.000Z", 30_000)]);
    expect(r.code).toBe(1);
    expect(r.line).toMatch(/one after the other/);
  });

  it("does not hold when a job was held (exit 5)", () => {
    const r = disjoint([events("2026-10-28T10:01:00.000Z", 30_000), workers("2026-10-28T10:01:05.000Z", 0, { exit: 5, outcome: "held", applied: [] })]);
    expect(r.code).toBe(1);
    expect(r.line).toMatch(/held/);
  });

  it("does not hold when one update wrote both resources", () => {
    const both = up({ started: "2026-10-28T10:01:00.000Z", at: "2026-10-28T10:01:00.000Z", ms: 30_000, spans: [span("events", ["provider update"]), span("worker-3", ["provider create"])] });
    expect(disjoint([both, events("2026-10-28T10:01:01.000Z", 30_000)]).code).toBe(1);
  });

  it("reads only the arm's jobs", () => {
    expect(disjoint([events("2026-10-28T09:01:00.000Z", 30_000), workers("2026-10-28T10:01:05.000Z", 30_000)]).code).toBe(1);
    expect(waveRuns([events("2026-10-28T09:00:00.000Z", 1), events("2026-10-28T10:00:01.000Z", 1)], "pulumi-up", SINCE)).toHaveLength(1);
  });

  it("counts a provider create, update or delete as a write, and check, diff and read as none", () => {
    expect([...writtenResources([span("a", ["provider check", "provider diff", "provider read", "record write"]), span("b", ["provider delete"])])]).toEqual(["b"]);
    expect(urnName("urn:pulumi:dev::shop::corpus:index:Site$aws:s3/bucket:Bucket::docs-assets")).toBe("docs-assets");
  });
});

describe("pw-moved-plan: a saved plan whose records moved", () => {
  const moved = (o: Partial<Parameters<typeof up>[0]>) => movedNotGated([up({ started: "2026-10-28T10:05:00.000Z", at: "2026-10-28T10:05:00.000Z", ms: 1, spans: [], ...o })], { op: "pulumi-up", since: SINCE, stack: "dev" });

  it("holds on chant's moved code with dev among the moved runs and nothing applied", () => {
    expect(moved({ exit: 4, moved: ["shop/dev"], applied: [], status: "fail" }).code).toBe(0);
  });

  it("does not hold when the update applied (the BREAK arm)", () => {
    expect(moved({ exit: 0 }).line).toMatch(/exited 0, not chant's moved code 4/);
  });

  it("does not hold on gated or waiting, which chant keeps apart from moved", () => {
    expect(moved({ exit: 3, status: "gated", applied: [] }).line).toMatch(/gated or waiting/);
  });

  it("does not hold on exit 4 that names another stack", () => {
    expect(moved({ exit: 4, moved: ["shop/staging"], applied: [] }).code).toBe(1);
  });
});

describe("the small pieces", () => {
  it("expands ${NAME:-default} from the arm and refuses a name with no value", () => {
    expect(expandWord("x=${PLYWOOD_E2E_RETENTION:-1800}", {})).toBe("x=1800");
    expect(expandWord("x=${PLYWOOD_E2E_RETENTION:-1800}", { PLYWOOD_E2E_RETENTION: "3600" })).toBe("x=3600");
    expect(() => expandWord("${NOPE}", {})).toThrow(/does not set/);
    expect(expandWord("plain", {})).toBe("plain");
  });

  it("takes lock-like keys as plunge's races do", () => {
    expect(lockishKeys([".pulumi/locks/dev/1.json", "records/dev/x.json", "a/LOCK", "stacks/dev.json"])).toEqual([".pulumi/locks/dev/1.json", "a/LOCK"]);
  });

  it("reads plunge's markers off a queue's tags", () => {
    expect(hasMarkers({ "plunge-urn": urn("worker-3"), "plunge-stack": "shop/dev" }, "worker-3", "dev")).toBe(true);
    expect(hasMarkers({ "plunge-urn": urn("worker-3") }, "worker-3", "dev")).toBe(false);
    expect(hasMarkers({ "plunge-urn": urn("worker-30"), "plunge-stack": "dev" }, "worker-3", "dev")).toBe(false);
  });
});

describe("the reset waits for Forgejo's tasks (plywood#22 finding 10)", () => {
  it("counts running, waiting and blocked tasks as busy, and finished ones as not", () => {
    const tasks = ["success", "running", "failure", "waiting", "cancelled", "blocked", "skipped"].map((status, id) => ({ id, status }));
    expect(busyTasks(tasks).map((t) => t.status)).toEqual(["running", "waiting", "blocked"]);
    expect(busyTasks([])).toEqual([]);
  });
});
