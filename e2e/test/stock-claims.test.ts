/**
 * plywood#22's stock Pulumi claims on the bench: the checks pw-one-note,
 * pw-moved-preview, pw-canary and pw-drift read, and the plywood-e2e
 * commands that run them, with fakes.
 */
import { describe, expect, it } from "vitest";
import { canaryFirst, driftIssueHolds, oneNote, waitsAtGate, type IssueView } from "../checks";
import type { LedgerRecord } from "../harness";
import { armBranch, configureScript, driftJobScript, retentionScript, runCommand, stockBackend, type CommandContext } from "../ports";

const SINCE = "2026-10-28T10:00:00.000Z";

function job(o: { number: number; started: string; ms: number; stacks: string[]; exit?: number; applied?: string[]; status?: LedgerRecord["status"] }): LedgerRecord {
  const end = new Date(Date.parse(o.started) + o.ms).toISOString();
  return {
    id: `${o.number}-${o.started}`,
    op: "pulumi-up",
    env: "local",
    started: o.started,
    ended: end,
    status: o.status ?? "ok",
    wave: {
      spec: "pulumi-up",
      number: o.number,
      name: `wave-${o.number}`,
      job: `wave-${o.number}`,
      exitCode: o.exit ?? 0,
      applied: o.applied ?? o.stacks.map((s) => `shop/${s}`),
      failed: [],
      moved: [],
      targets: Object.fromEntries(o.stacks.map((s) => [`shop/${s}`, { startedAt: o.started, durationMs: o.ms }])),
    },
  };
}

describe("pw-canary: the canary wave ends before the next starts", () => {
  const canary = (rs: LedgerRecord[]) => canaryFirst(rs, { op: "pulumi-up", since: SINCE, first: "prod-us", then: "prod-eu" });

  it("holds when prod-us updated in wave 1 and prod-eu in wave 2 after it", () => {
    const r = canary([job({ number: 1, started: "2026-10-28T10:01:00.000Z", ms: 20_000, stacks: ["prod-us"] }), job({ number: 2, started: "2026-10-28T10:01:30.000Z", ms: 20_000, stacks: ["prod-eu"] })]);
    expect(r.code).toBe(0);
    expect(r.line).toMatch(/10000 ms after the canary ended/);
  });

  it("does not hold when both stacks updated in one wave job (the BREAK arm)", () => {
    expect(canary([job({ number: 1, started: "2026-10-28T10:01:00.000Z", ms: 20_000, stacks: ["prod-us", "prod-eu"] })]).line).toMatch(/in one wave job/);
  });

  it("does not hold when the next wave started before the canary ended, or came first", () => {
    expect(canary([job({ number: 1, started: "2026-10-28T10:01:00.000Z", ms: 20_000, stacks: ["prod-us"] }), job({ number: 2, started: "2026-10-28T10:01:10.000Z", ms: 20_000, stacks: ["prod-eu"] })]).line).toMatch(/before the canary's update/);
    expect(canary([job({ number: 2, started: "2026-10-28T10:01:00.000Z", ms: 1, stacks: ["prod-us"] }), job({ number: 1, started: "2026-10-28T10:02:00.000Z", ms: 1, stacks: ["prod-eu"] })]).line).toMatch(/not before/);
  });

  it("does not hold when the canary failed and the next wave never ran", () => {
    const failed = job({ number: 1, started: "2026-10-28T10:01:00.000Z", ms: 1, stacks: ["prod-us"], exit: 1, applied: [], status: "fail" });
    expect(canary([failed]).line).toMatch(/no pulumi-up job applied prod-us/);
  });

  it("reads only the arm's jobs", () => {
    expect(canary([job({ number: 1, started: "2026-10-28T09:01:00.000Z", ms: 1, stacks: ["prod-us"] }), job({ number: 2, started: "2026-10-28T10:01:30.000Z", ms: 1, stacks: ["prod-eu"] })]).code).toBe(1);
  });
});

describe("pw-moved-preview: a changed preview waits at its wave's own gate", () => {
  const gated = job({ number: 1, started: "2026-10-28T10:05:00.000Z", ms: 1, stacks: [], exit: 3, applied: [], status: "gated" });
  const waits = (rs: LedgerRecord[], pending?: { gate: string }) => waitsAtGate(rs, { op: "pulumi-up", since: SINCE, stack: "prod-us" }, pending);

  it("holds on a gated wave, nothing applied and wave-1 pending", () => {
    expect(waits([gated], { gate: "wave-1" })).toEqual({ code: 0, line: "wave 1 waits at wave-1; prod-us was not applied" });
  });

  it("does not hold when prod-us applied under the approval (the BREAK arm)", () => {
    expect(waits([job({ number: 1, started: "2026-10-28T10:05:00.000Z", ms: 1, stacks: ["prod-us"] })], undefined).line).toMatch(/applied prod-us although/);
  });

  it("does not hold without a stopped wave, without a pending gate, or on the pull request's gate", () => {
    expect(waits([], { gate: "wave-1" }).line).toMatch(/no pulumi-up job stopped/);
    expect(waits([gated], undefined).line).toMatch(/no gate of pulumi-up is pending/);
    expect(waits([gated], { gate: "up" }).line).toMatch(/not a wave's own gate/);
  });
});

describe("pw-one-note: one note, one group, one approval line", () => {
  const note = "## plywood preview\n\n2 stacks: 1 group, 0 destroys or replacements.\n\nStacks: shop/prod-eu, shop/prod-us\n\nplywood approve up --plan jcs1-sha256:71d2\n";
  const one = (bodies: string[]) => oneNote(bodies, { once: "plywood approve up --plan", holds: [": 1 group,", "shop/prod-us", "shop/prod-eu"] });

  it("holds on one note that holds the summary and the line", () => {
    expect(one(["a first comment", note]).code).toBe(0);
  });

  it("does not hold on two groups (the BREAK arm), or no note yet", () => {
    expect(one([note.replace(": 1 group,", ": 2 groups,")]).line).toMatch(/no comment holds ": 1 group,"/);
    expect(one([]).code).toBe(1);
  });

  it("does not hold when another comment repeats the approval line", () => {
    expect(one([note, "plywood approve up --plan jcs1-sha256:aaaa"]).line).toMatch(/appears 2 times/);
  });
});

describe("pw-drift: one issue naming the URN and the attribute", () => {
  const title = "plywood: shop/prod-us has drifted";
  const body = "<!-- plywood:drift shop/prod-us -->\n\n| URN | Status | Attributes |\n|---|---|---|\n| `urn:pulumi:prod-us::shop::aws:sqs/queue:Queue::events` | drifted | `messageRetentionSeconds` |\n";
  const issue = (o: Partial<IssueView> = {}): IssueView => ({ number: 3, title, body, open: true, ...o });
  const holds = (issues: IssueView[]) => driftIssueHolds(issues, { title, name: "events", attribute: "messageRetentionSeconds" });

  it("holds on one open issue with the row", () => {
    expect(holds([issue(), issue({ number: 1, open: false })])).toEqual({ code: 0, line: "issue #3 names events with messageRetentionSeconds" });
  });

  it("does not hold on no issue, two, another resource or another attribute", () => {
    expect(holds([]).code).toBe(1);
    expect(holds([issue(), issue({ number: 4 })]).line).toMatch(/2 open issues/);
    expect(holds([issue({ body: body.replace("::events`", "::worker-0`") })]).line).toMatch(/no row for a resource named events/);
    expect(holds([issue({ body: body.replace("messageRetentionSeconds", "delaySeconds") })]).line).toMatch(/does not name messageRetentionSeconds/);
  });
});

const h = { RUNNER_JOB_ENV: { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" } };
const author = { login: "tutor", token: "t0k" };
const admin = { login: "plywood-admin", token: "adm" };

function ctx(o: { records?: LedgerRecord[]; arm?: Record<string, string>; comments?: string[][]; issues?: IssueView[] } = {}) {
  const ran: string[][] = [];
  const pushed: Array<{ branch: string; files: Record<string, string> }> = [];
  let now = 0;
  let read = 0;
  const c: CommandContext = {
    h,
    clock: { now: () => now, sleep: async (ms) => void (now += ms) },
    safe: { run: async (cmd) => (ran.push(cmd), 0), log: () => {} },
    ledger: { runs: async () => o.records ?? [], pending: async () => ({ gate: "wave-1" }) },
    observer: { result: () => ({ code: 0, line: "none" }) },
    env: "local",
    since: () => SINCE,
    armEnv: () => o.arm ?? {},
    floci: "http://127.0.0.1:4590",
    jobImage: "plywood-tutorial-job:local",
    author,
    reviewer: { login: "reviewer", token: "r3v" },
    waitLimit: 120,
    admin,
    overlay: (name, kind) => ({ [`${kind}.txt`]: name }),
    pushBranch: async (branch, files) => (pushed.push({ branch, files }), "abcdef0123456789"),
    pullComments: async () => o.comments?.[Math.min(read++, o.comments.length - 1)],
    issues: async () => o.issues ?? [],
  };
  return { c, ran, pushed };
}

describe("the stock claims' plywood-e2e commands", () => {
  it("configures main in a job container as the admin, with the base overlay's files and plywood init", async () => {
    const t = ctx();
    expect(await runCommand(t.c, ["configure", "stock-first"])).toBe(0);
    const argv = t.ran[0]!;
    const files = argv.find((a) => a.startsWith("PLYWOOD_E2E_FILES="))!;
    expect(JSON.parse(Buffer.from(files.slice("PLYWOOD_E2E_FILES=".length), "base64").toString("utf8"))).toEqual({ "base.txt": "stock-first" });
    expect(argv.at(-1)).toContain("http://plywood-admin:adm@forgejo:3000/tutor/shop.git");
    const script = configureScript("stock-first");
    expect(script).toContain("plywood init --forge forgejo --yes");
    expect(script).toContain("[skip ci]");
    expect(script).toContain("git push -q origin HEAD:main");
    expect(script).toMatch(/PULUMI_BACKEND_URL='s3:\/\/plywood-tutorial-state\?/);
  });

  it("pushes one more commit on the arm's branch", async () => {
    const plain = ctx();
    expect(await runCommand(plain.c, ["push", "e2e/x", "prod-us-workers-5"])).toBe(0);
    expect(plain.pushed).toEqual([{ branch: "e2e/x", files: { "pull.txt": "prod-us-workers-5" } }]);
    const brk = ctx({ arm: { BREAK: "1" } });
    await runCommand(brk.c, ["push", "e2e/x", "notes-line"]);
    expect(brk.pushed[0]!.branch).toBe("e2e/x-break");
    expect(armBranch("b", {})).toBe("b");
  });

  it("waits for the note, then reads it", async () => {
    const note = "2 stacks: 1 group, 0 destroys or replacements.\nplywood approve up --plan d\n";
    const t = ctx({ comments: [[], [note]] });
    expect(await runCommand(t.c, ["note", "e2e/x", "plywood approve up --plan", ": 1 group,"])).toBe(0);
    const never = ctx({ comments: [[note.replace("1 group", "2 groups")]] });
    expect(await runCommand(never.c, ["note", "e2e/x", "plywood approve up --plan", ": 1 group,"])).toBe(1);
  });

  it("waits until the stacks settled, or a wave stopped", async () => {
    const both = ctx({ records: [job({ number: 1, started: "2026-10-28T10:01:00.000Z", ms: 1, stacks: ["prod-us"] }), job({ number: 2, started: "2026-10-28T10:02:00.000Z", ms: 1, stacks: ["prod-eu"] })] });
    expect(await runCommand(both.c, ["wait-stacks", "pulumi-up", "prod-us", "prod-eu"])).toBe(0);
    const stopped = ctx({ records: [job({ number: 1, started: "2026-10-28T10:01:00.000Z", ms: 1, stacks: [], exit: 3, applied: [], status: "gated" })] });
    expect(await runCommand(stopped.c, ["wait-stacks", "pulumi-up", "prod-us"])).toBe(0);
    expect(await runCommand(ctx().c, ["wait-stacks", "pulumi-up", "prod-us"])).toBe(124);
  });

  it("changes the events queue by hand and runs the drift job's command in job containers", async () => {
    const t = ctx();
    expect(await runCommand(t.c, ["sqs-retention", "prod-us", "60"])).toBe(0);
    expect(t.ran[0]!.at(-1)).toContain("pulumi stack output eventsQueueUrl --stack 'prod-us'");
    expect(retentionScript("prod-eu", "60")).toContain("SetQueueAttributes");
    expect(() => retentionScript("prod-us", "sixty")).toThrow(/takes seconds/);
    expect(() => stockBackend("dev")).toThrow(/not a stock Pulumi stack/);
    expect(stockBackend("staging")).toMatch(/^s3:\/\/plywood-tutorial-plunge\?/);
    expect(await runCommand(t.c, ["drift-job", "prod-us"])).toBe(0);
    const argv = t.ran[1]!;
    for (const e of ["FORGEJO_SERVER_URL=http://forgejo:3000", "FORGEJO_REPOSITORY=tutor/shop", "FORGEJO_TOKEN=t0k"]) expect(argv).toContain(e);
    expect(driftJobScript("prod-us")).toContain("plywood drift --op 'plywood-drift-shop-prod-us' --forge forgejo");
    expect(driftJobScript("prod-us")).toContain("refs/chant/snapshots");
  });

  it("reads the drift issue and the canary and gate checks off the ledger", async () => {
    const body = "| `urn:pulumi:prod-us::shop::aws:sqs/queue:Queue::events` | drifted | `messageRetentionSeconds` |";
    expect(await runCommand(ctx({ issues: [{ number: 1, title: "plywood: shop/prod-us has drifted", body, open: true }] }).c, ["drift-issue", "prod-us", "events", "messageRetentionSeconds"])).toBe(0);
    expect(await runCommand(ctx().c, ["drift-issue", "prod-us", "events", "messageRetentionSeconds"])).toBe(1);
    const gated = ctx({ records: [job({ number: 1, started: "2026-10-28T10:05:00.000Z", ms: 1, stacks: [], exit: 3, applied: [], status: "gated" })] });
    expect(await runCommand(gated.c, ["waits", "pulumi-up", "prod-us"])).toBe(0);
    expect(await runCommand(ctx().c, ["canary", "pulumi-up", "prod-us", "prod-eu"])).toBe(1);
  });
});
