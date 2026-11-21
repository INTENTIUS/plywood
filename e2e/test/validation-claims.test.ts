/**
 * plywood#60's scenarios: the checks they read and the plywood-e2e commands
 * that run them, with fakes. The programs that run inside the containers are
 * in probes.test.ts.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { doraCounts, overrideRecorded, reportHolds } from "../checks";
import { dryRun } from "../main";
import { agentRunScript, agentSecretsScript, alertScript, auditScript, deployScript, mcpScript, releaseScript, revokeScript, rollbackScript, queueRetentionScript, receivedArgv, receiverArgv, runCommand, type CommandContext, deployGatedScript, promoteScript } from "../ports";
import { RECEIVER, RECEIVER_URL, ROLLBACK_JS, PROMOTE_JS } from "../probes";
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
      ["pw-rollback", "PLYWOOD_E2E_REVOKED", "shop-a"],
      ["pw-alert-agent", "PLYWOOD_E2E_AGENT", "agent-alert-off"],
      ["pw-promote", "PLYWOOD_E2E_FROM", "dev"],
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

describe("pw-rollback", () => {
  it("cuts, deploys, revokes and rolls back through the commands, each with the forge's ledger under it", async () => {
    const t = ctx();
    for (const words of [["release", "shop-a"], ["revoke", "shop-a"], ["revoke", "none"], ["deploy", "prod", "shop-a"], ["rollback", "prod", "shop-a"]]) expect(await runCommand(t.c, words)).toBe(0);
    expect(t.ran).toHaveLength(5);
    for (const argv of t.ran) expect(last(argv)).toContain("git push -q origin chant/lifecycle");
    expect(last(t.ran[0]!)).toContain("chant release cut 'shop-a' --yes --actor 'tutor'");
    expect(last(t.ran[1]!)).toContain('git tag -a "ci/revoked/$sha"');
    expect(last(t.ran[2]!)).toContain("no release revoked");
    expect(last(t.ran[3]!)).toContain("chant run --components --env 'prod' --release 'shop-a'");
    await expect(runCommand(t.c, ["rollback", "prod"])).rejects.toThrow(/takes <env> <label>/);
  });

  it("asks as the author, has the reviewer approve the line it prints, and reads the restore from the second run", () => {
    const script = rollbackScript("prod", "shop-a", "tutor", "reviewer");
    expect(script).toContain("plywood rollback 'prod' --release 'shop-a' --actor 'tutor'");
    expect(script).toContain('if [ "$code" != 3 ]; then exit "$code"; fi');
    expect(script).toContain(`plywood "$@" --approver 'reviewer' --yes`);
    expect(script.indexOf("--approver")).toBeLessThan(script.indexOf("--json"));
    expect(releaseScript("shop-b", "tutor")).toContain('git tag -a "ci/green/$sha"');
    expect(deployScript("prod", "shop-b")).toBe("chant run --components --env 'prod' --release 'shop-b' --yes");
    expect(revokeScript("none")).not.toContain("git tag");
  });

  it("holds when the document records a restore in the environment, and fails on a refusal or another environment", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-rollback-155-"));
    const run = (doc: string, env: string) => {
      const file = join(dir, `${env}.json`);
      writeFileSync(file, doc);
      return spawnSync("node", ["-e", ROLLBACK_JS, file, env]).status;
    };
    const record = { component: "shop", env: "prod", digest: "sha256:ab", restores: { env: "prod", runId: "4790", timestamp: "2026-11-20T11:20:05.000Z" } };
    expect(run(JSON.stringify({ outcome: { deployed: [] }, records: [record] }), "prod")).toBe(0);
    expect(run(JSON.stringify([{ ...record, env: "staging" }]), "prod")).toBe(1);
    expect(run(JSON.stringify({ error: "release-revoked" }), "prod")).toBe(1);
    expect(run("release-revoked: shop-a", "prod")).toBe(1);
  });

  it("revokes shop-a in the BREAK arm only, and rolls back to it last", () => {
    const s = readScenario("pw-rollback");
    const lines = dryRun(s).join("\n");
    expect(lines).toContain("run plywood-e2e revoke none");
    expect(lines).toContain("run plywood-e2e revoke shop-a");
    expect(s.steps.map((x) => x.id).slice(-2)).toEqual(["revoke", "applied"]);
    expect(s.steps.at(-1)).toMatchObject({ command: ["plywood-e2e", "rollback", "prod", "shop-a"], expect: [{ exit: 0 }] });
  });
});

describe("pw-alert-agent", () => {
  it("posts one signed generic alert to a relay on loopback and reads its fact from chant/lifecycle", () => {
    const script = alertScript("e2e checkout latency");
    expect(script).toContain("chant notify relay --host 127.0.0.1 --port 8787");
    expect(script).toContain("X-Chant-Signature: sha256=$sig");
    expect(script).toContain("/alert/generic");
    expect(script).toContain("git show FETCH_HEAD:_alerts/alert.jsonl | grep -F 'e2e checkout latency'");
    expect(script.indexOf("/alert/generic")).toBeLessThan(script.indexOf("_alerts/alert.jsonl"));
  });

  it("sets the two secrets as the admin, and starts the workflow by the dispatch API before it looks for the pull request", () => {
    expect(agentSecretsScript()).toContain("actions/secrets/CHANT_RELAY_KEY");
    const run = agentRunScript("plywood-alert-agent");
    expect(run).toContain("actions/workflows/plywood-alert-agent.yml/dispatches");
    expect(run.indexOf("dispatches")).toBeLessThan(run.indexOf("pulls?state=open"));
    expect(run).toContain("plywood/agent/plywood-alert-agent");
  });

  it("runs the commands, the alert with the forge's ledger under it", async () => {
    const t = ctx();
    expect(await runCommand(t.c, ["alert", "e2e checkout latency"])).toBe(0);
    expect(last(t.ran[0]!)).toContain("git push -q origin chant/lifecycle");
    expect(await runCommand(t.c, ["agent-run", "plywood-alert-agent"])).toBe(0);
    await expect(runCommand(t.c, ["alert"])).rejects.toThrow(/takes <title>/);
  });

  it("configures agent.alert in the plain arm and leaves it off in the BREAK arm", () => {
    const lines = dryRun(readScenario("pw-alert-agent")).join("\n");
    expect(lines).toContain("run plywood-e2e configure agent-alert");
    expect(readScenario("pw-alert-agent").steps.at(-1)).toMatchObject({ command: ["plywood-e2e", "agent-run", "plywood-alert-agent"], expect: [{ exit: 0 }] });
  });
});

describe("pw-promote", () => {
  it("deploys dev and promotes through the commands, each with the forge's ledger under it", async () => {
    const t = ctx();
    for (const words of [["deploy-gated", "dev", "shop-p1"], ["promote", "staging", "shop-p1", "dev"]]) expect(await runCommand(t.c, words)).toBe(0);
    expect(t.ran).toHaveLength(2);
    for (const argv of t.ran) expect(last(argv)).toContain("git push -q origin chant/lifecycle");
    expect(last(t.ran[0]!)).toContain("chant run --components --env 'dev' --release 'shop-p1' --yes --actor 'tutor'");
    expect(last(t.ran[1]!)).toContain("plywood promote --to 'staging' --release 'shop-p1' --from 'dev' --actor 'tutor'");
    await expect(runCommand(t.c, ["promote", "staging", "shop-p1"])).rejects.toThrow(/takes <env> <label> <from>/);
  });

  it("approves each gate it waits at as the reviewer, and reads the deploy from the last run", () => {
    const script = promoteScript("prod-us", "shop-p1", "staging", "tutor", "reviewer");
    expect(script).toContain('if [ "$code" != 3 ]; then break; fi');
    expect(script).toContain('if [ "$code" != 0 ]; then exit "$code"; fi');
    expect(script).toContain(`plywood approve release --plan "$digest" --approver 'reviewer' --yes`);
    expect(script.lastIndexOf("--approver")).toBeLessThan(script.indexOf("node -e"));
    const gated = deployGatedScript("dev", "shop-p1", "tutor", "reviewer");
    expect(gated).toContain("chant approve shop release --env 'dev' --approver 'reviewer' --yes");
  });

  it("reads the digest off the release gate's line", () => {
    const script = promoteScript("prod-us", "shop-p1", "staging", "tutor", "reviewer");
    const line = script.split("\n").map((l) => l.trim()).find((l) => l.startsWith("digest="))!;
    const out = 'release gate: change set jcs1-sha256:ab12 for "prod-us", 1 entry, 0 hole(s)';
    const r = spawnSync("sh", ["-c", `out=${JSON.stringify(out)}\n${line}\nprintf '%s' "$digest"`], { encoding: "utf8" });
    expect(r.stdout).toBe("jcs1-sha256:ab12");
  });

  it("holds when the document records a deploy in the environment, and fails on a refusal or another environment", () => {
    const dir = mkdtempSync(join(tmpdir(), "pw-promote-154-"));
    const run = (doc: string, env: string) => {
      const file = join(dir, `${env}.json`);
      writeFileSync(file, doc);
      return spawnSync("node", ["-e", PROMOTE_JS, file, env]).status;
    };
    const record = { component: "shop", env: "prod-us", digest: "sha256:ab", runId: "4790" };
    expect(run(JSON.stringify({ plan: {}, records: [record] }), "prod-us")).toBe(0);
    expect(run(JSON.stringify({ records: [{ ...record, env: "staging" }] }), "prod-us")).toBe(1);
    expect(run(JSON.stringify({ error: "promote-skips-environment" }), "prod-us")).toBe(1);
    expect(run("promote-skips-environment", "prod-us")).toBe(1);
  });

  it("promotes prod-us from staging in the plain arm and from dev in the BREAK arm, last", () => {
    const s = readScenario("pw-promote");
    const lines = dryRun(s).join("\n");
    expect(lines).toContain("run plywood-e2e promote prod-us shop-p1 staging");
    expect(lines).toContain("run plywood-e2e promote prod-us shop-p1 dev");
    expect(s.steps.map((x) => x.id)).toEqual(["promotion", "release", "dev", "staging", "applied"]);
  });
});
