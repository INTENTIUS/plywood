/**
 * plywood#60's scenarios: the checks they read and the plywood-e2e commands
 * that run them, with fakes. The programs that run inside the containers are
 * in probes.test.ts.
 */
import { describe, expect, it } from "vitest";
import { doraCounts, overrideRecorded, reportHolds } from "../checks";
import { dryRun } from "../main";
import { auditScript, mcpScript, queueRetentionScript, receivedArgv, receiverArgv, runCommand, type CommandContext } from "../ports";
import { RECEIVER, RECEIVER_URL } from "../probes";
import { readScenario } from "../scenarios";

describe("the checks", () => {
  it("reportHolds reads dotted paths and arrays, and says what differs", () => {
    const report = { status: "refused", refusal: "policy-denied", policy: { result: "denied", rules: ["main.deny_frozen"] } };
    expect(reportHolds(report, ["status=refused", "policy.rules=main.deny_frozen"]).code).toBe(0);
    expect(reportHolds(report, ["policy.result=passed"])).toEqual({ code: 1, line: `the report's policy.result is "denied", not passed` });
    expect(reportHolds(report, ["policy.override.by=reviewer"]).code).toBe(1);
    expect(() => reportHolds(report, ["status"])).toThrow(/path=value/);
  });

  it("overrideRecorded needs the person, a reason and the applied record that spends it", () => {
    const line = { gate: "pr-7-shop", resolvedBy: "reviewer", note: "why", planDigest: "sha256:ab" };
    const applied = [{ gate: "pr-7-shop", planDigest: "ab" }];
    const o = { subject: "pr-7-shop", by: "reviewer" };
    expect(overrideRecorded({ resolutions: [line], applied }, o).code).toBe(0);
    expect(overrideRecorded({ resolutions: [line], applied }, { ...o, by: "tutor" }).code).toBe(1);
    expect(overrideRecorded({ resolutions: [{ ...line, note: " " }], applied }, o).code).toBe(1);
    expect(overrideRecorded({ resolutions: [line], applied: [] }, o).code).toBe(1);
  });

  it("doraCounts needs plywood's schema, the count and the page", () => {
    const dora = { schema: "plywood.dora/v1", estate: { deployments: 1 } };
    expect(doraCounts(dora, "<html>", 1).code).toBe(0);
    expect(doraCounts({ ...dora, estate: { deployments: 0 } }, "<html>", 1).code).toBe(1);
    expect(doraCounts({ ...dora, schema: "chant.dora/v1" }, "<html>", 1).code).toBe(1);
    expect(doraCounts(dora, null, 1).code).toBe(1);
    expect(doraCounts(null, "<html>", 1).code).toBe(1);
  });
});

const author = { login: "tutor", token: "t0k" };
const reviewer = { login: "reviewer", token: "r3v" };

function ctx(o: { reports?: Array<unknown>; plan?: unknown; arm?: Record<string, string>; code?: (cmd: string[]) => number; objects?: Record<string, string> } = {}) {
  const ran: string[][] = [];
  const asked: string[] = [];
  let now = 0;
  const reports = [...(o.reports ?? [])];
  const c: CommandContext = {
    h: { RUNNER_JOB_ENV: {} },
    clock: { now: () => now, sleep: async (ms) => void (now += ms) },
    safe: { run: async (cmd) => (ran.push(cmd), o.code?.(cmd) ?? 0), log: () => undefined },
    ledger: { runs: async () => [], pending: async () => undefined, overrides: async () => ({ resolutions: [{ gate: "pr-7-shop", resolvedBy: "reviewer", note: "why", planDigest: "d" }], applied: [{ gate: "pr-7-shop", planDigest: "d" }] }) },
    observer: { result: () => ({ code: 0, line: "" }) },
    env: "local",
    since: () => "2026-11-01T00:00:00.000Z",
    armEnv: () => o.arm ?? {},
    floci: "http://127.0.0.1:4590",
    jobImage: "plywood-tutorial-job:local",
    author,
    reviewer,
    waitLimit: 60,
    pullReport: async (branch, stage) => {
      asked.push(`${branch} ${stage}`);
      return stage === "plan" ? (o.plan ?? { op: "pr-7-shop" }) : reports.length > 1 ? reports.shift() : reports[0];
    },
    report: async (k) => o.objects?.[k] ?? null,
  };
  return { c, ran, asked };
}
const last = (argv: string[]) => argv[argv.length - 1]!;

describe("plywood-e2e commands", () => {
  it("report waits for an apply report to come to the value, and gives up with 1", async () => {
    const t = ctx({ reports: [undefined, { status: "refused" }, { status: "applied" }] });
    expect(await runCommand(t.c, ["report", "e2e/x", "apply", "status=applied"])).toBe(0);
    expect(t.asked).toHaveLength(3);
    expect(await runCommand(ctx({ reports: [{ status: "refused" }] }).c, ["report", "e2e/x", "apply", "status=applied"])).toBe(1);
  });

  it("report reads a plan report once, on the arm's branch", async () => {
    const t = ctx({ plan: { policy: { result: "passed" } }, arm: { BREAK: "1" } });
    expect(await runCommand(t.c, ["report", "e2e/x", "plan", "policy.result=denied"])).toBe(1);
    expect(t.asked).toEqual(["e2e/x-break plan"]);
    await expect(runCommand(t.c, ["report", "e2e/x", "merge", "a=b"])).rejects.toThrow(/plan or apply/);
  });

  it("override runs plywood override on the plan's op as the person named, with the ledger", async () => {
    const t = ctx();
    expect(await runCommand(t.c, ["override", "e2e/x", "reviewer", "main.deny_frozen", "not", "this", "time"])).toBe(0);
    const script = last(t.ran[0]!);
    expect(script).toContain("plywood override 'pr-7-shop' --rule 'main.deny_frozen' --reason 'not this time' --approver 'reviewer'");
    expect(script).toContain("reviewer:r3v@forgejo:3000");
    expect(script).toContain("git push -q origin chant/lifecycle");
    await runCommand(t.c, ["override", "e2e/x", "author", "r", "why"]);
    expect(last(t.ran[1]!)).toContain("--approver 'tutor'");
    await expect(runCommand(t.c, ["override", "e2e/x", "admin", "r", "why"])).rejects.toThrow(/reviewer or author/);
    expect(await runCommand(ctx({ plan: {} }).c, ["override", "e2e/x", "reviewer", "r", "why"])).toBe(1);
  });

  it("overridden reads the ledger for the plan's op", async () => {
    expect(await runCommand(ctx().c, ["overridden", "e2e/x", "reviewer"])).toBe(0);
    expect(await runCommand(ctx().c, ["overridden", "e2e/x", "tutor"])).toBe(1);
  });

  it("audit runs plywood audit in a job container on the forge's ledger", async () => {
    const t = ctx();
    expect(await runCommand(t.c, ["audit", "runs", "op=pulumi-up"])).toBe(0);
    expect(last(t.ran[0]!)).toContain("plywood audit 'runs' --json > /tmp/plywood-e2e-audit.json");
    expect(last(t.ran[0]!)).toContain("git fetch -q origin chant/lifecycle:chant/lifecycle");
    expect(auditScript("updates", ["a=b"])).toContain("/tmp/plywood-e2e-audit.json 'a=b'");
    expect(auditScript("runs", ["a=b"], "2026-11-02T00:00:00.000Z")).toContain("plywood audit 'runs' --since '2026-11-02T00:00:00.000Z' --json");
  });

  it("job-ledger passes the words and dora reads what plywood estate wrote", async () => {
    const t = ctx();
    await runCommand(t.c, ["job-ledger", "plywood", "estate"]);
    expect(last(t.ran[0]!)).toContain("'plywood' 'estate'");
    const objects = { "estate/dora.json": JSON.stringify({ schema: "plywood.dora/v1", estate: { deployments: 2 } }), "estate/estate.html": "<html>" };
    expect(await runCommand(ctx({ objects }).c, ["dora", "1"])).toBe(0);
    expect(await runCommand(ctx({ objects }).c, ["dora", "3"])).toBe(1);
    expect(await runCommand(ctx().c, ["dora", "1"])).toBe(1);
  });

  it("receiver replaces the old one on the bench's network, and received asks again for a minute", async () => {
    const t = ctx();
    expect(await runCommand(t.c, ["receiver"])).toBe(0);
    expect(t.ran[0]).toEqual(["docker", "rm", "-f", RECEIVER]);
    expect(t.ran[1]!.slice(0, 8)).toEqual(["docker", "run", "-d", "--rm", "--name", RECEIVER, "--network", "plywood-tutorial"]);
    expect(RECEIVER_URL).toBe("http://plywood-tutorial-receiver:4318");
    let tries = 0;
    expect(await runCommand(ctx({ code: () => (++tries < 3 ? 1 : 0) }).c, ["received", "metric", "m"])).toBe(0);
    expect(tries).toBe(3);
    expect(await runCommand(ctx({ code: () => 1 }).c, ["received", "metric", "m"])).toBe(1);
    expect(receivedArgv(["metric", "m"]).slice(0, 3)).toEqual(["docker", "exec", RECEIVER]);
    expect(receiverArgv("i")[1]).toContain("i");
  });

  it("notify-drift-job gives the drift job the receiver's URL and the key to sign with", async () => {
    const t = ctx();
    await runCommand(t.c, ["notify-drift-job", "prod-us", "k"]);
    expect(t.ran[0]).toContain(`PLYWOOD_E2E_HOOK_URL=${RECEIVER_URL}/hook`);
    expect(t.ran[0]).toContain("PLYWOOD_E2E_HOOK_KEY=k");
    expect(last(t.ran[0]!)).toContain("plywood drift --op 'plywood-drift-shop-prod-us' --forge forgejo");
  });

  it("mcp takes the read-only and propose tiers and queue-retention takes seconds", async () => {
    expect(mcpScript("read-only")).toMatch(/shop\/prod-us plywood mcp$/);
    expect(mcpScript("propose")).toMatch(/plywood mcp --propose$/);
    expect(() => mcpScript("write")).toThrow(/read-only or propose/);
    const t = ctx();
    expect(await runCommand(t.c, ["queue-retention", "prod-us", "7200"])).toBe(0);
    expect(last(t.ran[0]!)).toContain("pulumi stack output eventsQueueUrl --stack 'prod-us'");
    expect(queueRetentionScript("prod-us", "3600")).toContain("<Name>MessageRetentionPeriod<\\/Name>\\s*<Value>(\\d+)<\\/Value>");
    expect(() => queueRetentionScript("prod-us", "soon")).toThrow(/seconds/);
    expect(() => queueRetentionScript("dev", "1")).toThrow(/not a stock Pulumi stack/);
  });
});

describe("the scenarios' BREAK arms", () => {
  it("change the subject each checks, and say Forgejo only where a forge is in the claim", () => {
    const cases: Array<[string, string, string]> = [
      ["pw-policy-deny", "PLYWOOD_E2E_POLICY", "policy-frozen-nothing"],
      ["pw-policy-override", "PLYWOOD_E2E_OVERRIDER", "author"],
      ["pw-audit", "PLYWOOD_E2E_WAVES", "stock-without-prod-us"],
      ["pw-comment-up", "PLYWOOD_E2E_MAIN", "comment-up-main-moved"],
      ["pw-notify", "PLYWOOD_E2E_SIGNING_KEY", "another-key"],
      ["pw-traces", "PLYWOOD_E2E_TELEMETRY", "telemetry-off"],
      ["pw-estate", "PLYWOOD_E2E_TELEMETRY", "telemetry-none"],
    ];
    for (const [id, key, value] of cases) {
      const s = readScenario(id);
      expect(s.break.env[key], id).toBe(value);
      expect(s.break.note, id).toContain("Forgejo only");
      expect(s.title, id).toContain("Forgejo only");
      expect(dryRun(s).join("\n"), id).toContain(value);
    }
    expect(readScenario("pw-mcp").break.env.PLYWOOD_E2E_MCP_TIER).toBe("propose");
  });

  it("comment /plywood up with the driver's step, on the pull request the scenario opened", () => {
    expect(dryRun(readScenario("pw-comment-up")).join("\n")).toContain(`comment "/plywood up" on events as author`);
    const s = readScenario("pw-policy-override");
    expect(s.steps.filter((x) => x.do === "comment").map((x) => x.id)).toEqual(["up-denied", "up-overridden"]);
  });
});
