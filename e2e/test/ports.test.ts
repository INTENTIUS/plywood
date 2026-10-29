import { describe, expect, it } from "vitest";
import { join } from "node:path";
import type { BucketPort, LedgerRecord } from "../harness";
import { LockObserver, armPort, jobArgv, memberReports, outOfBand, reviewerChant, runCommand, type CommandContext } from "../ports";

function fakeBucket(objects: Record<string, string>): BucketPort {
  return {
    get: async (k) => objects[k] ?? null,
    put: async (k, b) => void (objects[k] = b),
    list: async (p) => Object.keys(objects).filter((k) => k.startsWith(p)),
    delete: async (k) => void delete objects[k],
  };
}

describe("reports", () => {
  it("reads the report at the driver's key, else the one member report below it", async () => {
    const b = memberReports(fakeBucket({ "shop/7/abc/dev/pr-plan.json": '{"status":"planned"}', "shop/8/def/pr-plan.json": '{"status":"nothing"}' }));
    expect(await b.get("shop/7/abc/pr-plan.json")).toBe('{"status":"planned"}');
    expect(await b.get("shop/8/def/pr-plan.json")).toBe('{"status":"nothing"}');
    expect(await b.get("shop/9/xyz/pr-plan.json")).toBeNull();
  });

  it("refuses to pick between two member reports", async () => {
    const b = memberReports(fakeBucket({ "s/7/a/dev/pr-plan.json": "{}", "s/7/a/staging/pr-plan.json": "{}" }));
    await expect(b.get("s/7/a/pr-plan.json")).rejects.toThrow(/2 member reports/);
  });
});

describe("the lock observer", () => {
  it("keeps every lock-like key it saw while running", async () => {
    const objects: Record<string, string> = { "records/dev/events.json": "{}" };
    const o = new LockObserver(fakeBucket(objects));
    await o.tick();
    expect(o.result().code).toBe(0);
    objects[".pulumi/locks/dev/x.json"] = "{}";
    await o.tick();
    delete objects[".pulumi/locks/dev/x.json"];
    await o.tick();
    expect(o.result()).toEqual({ code: 1, line: "lock-like keys appeared in the record store: .pulumi/locks/dev/x.json" });
    o.start();
    expect(o.result().code).toBe(0);
    o.stop();
  });
});

const h = { RUNNER_JOB_ENV: { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" } };
const author = { login: "tutor", token: "t0k" };
const reviewer = { login: "reviewer", token: "r3v" };

function ctx(o: { records?: LedgerRecord[]; pending?: { gate: string; planDigest?: string }; arm?: Record<string, string>; seen?: number } = {}) {
  const ran: string[][] = [];
  const logged: string[] = [];
  let now = 0;
  const c: CommandContext = {
    h,
    clock: { now: () => now, sleep: async (ms) => void (now += ms) },
    safe: { run: async (cmd) => (ran.push(cmd), 0), log: (l) => void logged.push(l) },
    ledger: { runs: async () => o.records ?? [], pending: async () => o.pending },
    observer: { result: () => (o.seen ? { code: 1, line: "seen" } : { code: 0, line: "none" }) },
    env: "local",
    since: () => "2026-10-28T10:00:00.000Z",
    armEnv: () => o.arm ?? {},
    floci: "http://127.0.0.1:4590",
    jobImage: "plywood-tutorial-job:local",
    author,
    reviewer,
    waitLimit: 60,
    queueTags: async () => [{ url: "http://floci/q", tags: { "plunge-urn": "urn:pulumi:dev::shop::aws:sqs/queue:Queue::worker-3", "plunge-stack": "dev" } }],
  };
  return { c, ran, logged };
}

const wave = (started: string): LedgerRecord => ({ id: started, op: "pulumi-up", env: "local", started, ended: started, status: "ok", wave: { spec: "pulumi-up", number: 1, name: "dev", job: "wave", exitCode: 0, applied: ["shop/dev"], failed: [], moved: [], targets: { "shop/dev": { startedAt: started, durationMs: 1 } } } });

describe("plywood-e2e commands", () => {
  it("waits for the jobs, and gives up past the limit with 124", async () => {
    const yes = ctx({ records: [wave("2026-10-28T10:01:00.000Z"), wave("2026-10-28T10:02:00.000Z")] });
    expect(await runCommand(yes.c, ["wait-runs", "pulumi-up", "2"])).toBe(0);
    const no = ctx({ records: [wave("2026-10-28T10:01:00.000Z"), wave("2026-10-28T09:00:00.000Z")] });
    expect(await runCommand(no.c, ["wait-runs", "pulumi-up", "2"])).toBe(124);
    expect(no.logged.pop()).toMatch(/1 of 2 pulumi-up wave jobs after 60s/);
  });

  it("with a stack, counts only the wave jobs that targeted it (plywood#22 finding 10)", async () => {
    const staging = (started: string): LedgerRecord => ({ ...wave(started), wave: { ...wave(started).wave!, name: "staging", applied: ["shop/staging"], targets: { "shop/staging": { startedAt: started, durationMs: 1 } } } });
    // One merge's staging and prod records do not stand in for the other merge's dev job.
    const one = ctx({ records: [wave("2026-10-28T10:01:00.000Z"), staging("2026-10-28T10:02:00.000Z")] });
    expect(await runCommand(one.c, ["wait-runs", "pulumi-up", "2", "dev"])).toBe(124);
    expect(one.logged.pop()).toMatch(/1 of 2 pulumi-up wave jobs on dev after 60s/);
    const two = ctx({ records: [wave("2026-10-28T10:01:00.000Z"), staging("2026-10-28T10:02:00.000Z"), wave("2026-10-28T10:03:00.000Z")] });
    expect(await runCommand(two.c, ["wait-runs", "pulumi-up", "2", "dev"])).toBe(0);
  });

  it("checks the newest job applied a stack", async () => {
    expect(await runCommand(ctx({ records: [wave("2026-10-28T10:01:00.000Z")] }).c, ["applied", "pulumi-up", "dev"])).toBe(0);
    expect(await runCommand(ctx({ records: [] }).c, ["applied", "pulumi-up", "dev"])).toBe(1);
  });

  it("passes the observer's result and the markers through", async () => {
    expect(await runCommand(ctx().c, ["locks-seen"])).toBe(0);
    expect(await runCommand(ctx({ seen: 1 }).c, ["locks-seen"])).toBe(1);
    expect(await runCommand(ctx().c, ["markers", "dev", "worker-3"])).toBe(0);
    expect(await runCommand(ctx().c, ["markers", "dev", "worker-4"])).toBe(1);
  });

  it("runs plunge up in a job container on plunge's store, with the config set first", async () => {
    const { c, ran } = ctx();
    await runCommand(c, ["plunge-up", "dev", "corpus:eventsRetentionSeconds=1800"]);
    const argv = ran[0]!;
    expect(argv.slice(0, 5)).toEqual(["docker", "run", "--rm", "--network", "plywood-tutorial"]);
    expect(argv).toContain("PULUMI_BACKEND_URL=plunge+s3://plywood-tutorial-plunge?region=us-east-1&endpoint=http://floci:4566&s3ForcePathStyle=true");
    expect(argv).toContain("PULUMI_SKIP_UPDATE_CHECK=true");
    const script = argv[argv.length - 1]!;
    expect(script).toContain("plunge config set --stack 'dev' 'corpus:eventsRetentionSeconds' '1800'\nplunge up --yes --non-interactive --stack 'dev'");
    expect(script).toContain("git clone -q 'http://tutor:t0k@forgejo:3000/tutor/shop.git' /w");
  });

  it("approves the newest pending gate with the plan it binds, as the reviewer", async () => {
    const { c, ran } = ctx({ pending: { gate: "adopt-staging", planDigest: "sha256:abc" } });
    expect(await runCommand(c, ["approve-pending", "plywood-adopt"])).toBe(0);
    expect(ran[0]![ran[0]!.length - 1]).toContain("plywood approve 'adopt-staging' --op 'plywood-adopt' --plan 'sha256:abc' --approver 'reviewer' --yes");
    expect(ran[0]![ran[0]!.length - 1]).toContain("reviewer:r3v@forgejo:3000");
    expect(await runCommand(ctx().c, ["approve-pending", "plywood-adopt"])).toBe(1);
    expect(await runCommand(ctx({ pending: { gate: "g" } }).c, ["approve-pending", "plywood-adopt"])).toBe(1);
  });

  it("runs plywood action as the author on the stack's own backend, in a job container", async () => {
    const { c, ran } = ctx();
    expect(await runCommand(c, ["action", "prod-us", "rotate"])).toBe(0);
    const argv = ran[0]!;
    expect(argv).toContain("PULUMI_BACKEND_URL=s3://plywood-tutorial-state?region=us-east-1&endpoint=http://floci:4566&use_path_style=true");
    const script = argv[argv.length - 1]!;
    expect(script).toContain("plywood action 'shop/prod-us' 'rotate' --by 'tutor'");
    expect(script).toContain("tutor:t0k@forgejo:3000");
    await expect(runCommand(c, ["action", "dev", "rotate"])).rejects.toThrow(/not a stock Pulumi stack/);
  });

  it("refuses a command it does not know", async () => {
    await expect(runCommand(ctx().c, ["teardown"])).rejects.toThrow(/no command teardown/);
  });
});

describe("the out-of-band port", () => {
  it("expands the arm's words, runs plywood-e2e in process and anything else through SafeRun", async () => {
    const { c, ran } = ctx({ arm: { PLYWOOD_E2E_RETENTION: "3600" } });
    const port = outOfBand(c);
    await port.run(["plywood-e2e", "plunge-up", "dev", "corpus:eventsRetentionSeconds=${PLYWOOD_E2E_RETENTION:-1800}"]);
    expect(ran[0]![ran[0]!.length - 1]).toContain("'corpus:eventsRetentionSeconds' '3600'");
    await port.run(["echo", "${PLYWOOD_E2E_RETENTION:-1}"]);
    expect(ran[1]).toEqual(["echo", "3600"]);
  });
});

describe("chant and main", () => {
  it("approves the driver's plan with plywood approve in a job container", async () => {
    const { c, ran } = ctx();
    await reviewerChant(c).approve({ pull: 7, op: "pr-7", gate: "up", digest: "sha256:d", approver: "forgejo@forgejo:3000:reviewer" });
    expect(ran[0]).toContain("PR_NUMBER=7");
    expect(ran[0]![ran[0]!.length - 1]).toContain("plywood approve 'up' --op 'pr-7' --plan 'sha256:d' --approver 'forgejo@forgejo:3000:reviewer' --yes");
  });

  it("names a file:// backend and no update check in every job container unless told otherwise", () => {
    const argv = jobArgv(h, { image: "i", person: author }, "true");
    expect(argv).toContain("PULUMI_BACKEND_URL=file:///tmp/plywood-tutorial-backend");
    expect(argv).toContain("PULUMI_SKIP_UPDATE_CHECK=true");
    expect(argv.filter((a) => a.startsWith("PULUMI_BACKEND_URL=")).length).toBe(1);
  });

  it("lays a BREAK arm's base overlay on main before starting the observer", async () => {
    const order: string[] = [];
    let pushed: Record<string, string> = {};
    const arm = armPort({
      baseOverlays: join(import.meta.dirname, "..", "scenarios", "base-overlays"),
      repoDir: join(import.meta.dirname, "fixtures", "shop"),
      observer: { start: () => void order.push("observe") },
      setArm: (a) => void order.push(`arm ${a}`),
      push: async (files) => {
        pushed = files;
        order.push("push");
        return "sha";
      },
    });
    await arm("plain", {});
    expect(order).toEqual(["arm plain", "observe"]);
    await arm("break", { BREAK: "1", PLYWOOD_E2E_BASE_OVERLAY: "stack-grain" });
    expect(order.slice(2)).toEqual(["arm break", "push", "observe"]);
    expect(pushed["plywood.yml"]).toMatch(/\nlocks:\n  grain: stack\n$/);
  });
});
