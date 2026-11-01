import { execFile, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { conftestFindings } from "@intentius/chant/gate-policy";
import { webhookRequest } from "@intentius/chant/notify";
import { overlayFiles, readOverlay } from "../overlays";
import { BASE_OVERLAYS_DIR, readScenario } from "../scenarios";
import { checkConfig, parseConfig } from "../../packages/plywood/src/config/index";
import { MCP_JS, PLYWOOD_READ_TOOLS, RECEIVED_JS, RECEIVER_JS, RECEIVER_URL, ROWS_JS, WRITE_TOOLS } from "../probes";

const run = promisify(execFile);
const node = async (js: string, ...args: string[]): Promise<number> => {
  try {
    await run("node", ["-e", js, ...args]);
    return 0;
  } catch (e) {
    return (e as { code: number }).code;
  }
};
const tmp = () => mkdtempSync(join(tmpdir(), "plywood-probes-"));
const REPO = join(import.meta.dirname, "fixtures", "shop");
const base = (name: string) => overlayFiles(readOverlay(BASE_OVERLAYS_DIR, name), REPO);

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });

describe("the receiver", () => {
  it("keeps each request, and received verifies a signed event under the receiver's key and no other", async () => {
    const file = join(tmp(), "got.jsonl");
    const port = await freePort();
    const server = spawn("node", ["-e", RECEIVER_JS, file, String(port)], { stdio: "ignore" });
    try {
      const event = { schema: "chant.notify/v1", id: "1", event: "drift", at: "2026-11-01T00:00:00.000Z", source: "plywood", project: "shop", summary: "x", targets: [], drift: { changed: ["shop/prod-us"] } };
      const req = webhookRequest(event as never, "the-key", { prefix: "x-plywood" });
      for (let i = 0; i < 50; i++) {
        const sent = await fetch(`http://127.0.0.1:${port}/hook`, { method: "POST", headers: req.headers, body: req.body }).catch(() => undefined);
        if (sent?.ok) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(await node(RECEIVED_JS, file, "signed", "drift", "plywood", "shop/prod-us", "the-key")).toBe(0);
      expect(await node(RECEIVED_JS, file, "signed", "drift", "plywood", "shop/prod-us", "another-key")).toBe(1);
      expect(await node(RECEIVED_JS, file, "signed", "drift", "plywood", "shop/prod-eu", "the-key")).toBe(1);
      expect(await node(RECEIVED_JS, file, "signed", "waiting", "plywood", "shop/prod-us", "the-key")).toBe(1);
    } finally {
      server.kill();
    }
  });

  it("finds a trace by service and stack, and a gauge by name, and exits 1 on an empty file", async () => {
    const file = join(tmp(), "got.jsonl");
    const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
    const lines = [
      { path: "/v1/traces", headers: {}, body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [str("service.name", "plywood")] }, scopeSpans: [{ spans: [{ attributes: [str("plywood.stack", "shop/prod-us")] }] }] }] }) },
      { path: "/v1/metrics", headers: {}, body: JSON.stringify({ resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: "plywood_dora_deployments_per_week" }] }] }] }) },
    ];
    writeFileSync(file, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    expect(await node(RECEIVED_JS, file, "trace", "plywood", "prod-us")).toBe(0);
    expect(await node(RECEIVED_JS, file, "trace", "plywood", "prod-eu")).toBe(1);
    expect(await node(RECEIVED_JS, file, "trace", "other", "prod-us")).toBe(1);
    expect(await node(RECEIVED_JS, file, "metric", "plywood_dora_deployments_per_week")).toBe(0);
    expect(await node(RECEIVED_JS, file, "metric", "plywood_dora_restore_seconds")).toBe(1);
    expect(await node(RECEIVED_JS, join(tmp(), "none"), "trace", "plywood", "prod-us")).toBe(1);
  });

  it("is the URL the telemetry overlays name", () => {
    for (const name of ["telemetry-on", "telemetry-off", "telemetry-without-prod-us"]) expect(base(name)["plywood.yml"]).toContain(`endpoint: ${RECEIVER_URL}\n`);
    expect(base("telemetry-off")["plywood.yml"]).toMatch(/\n {2}traces: false\n/);
  });
});

describe("rows", () => {
  it("finds one row that holds every value, through dotted paths and arrays", async () => {
    const file = join(tmp(), "rows.json");
    writeFileSync(file, JSON.stringify({ table: "runs", rows: [{ op: "pulumi-up", status: "ok", wave: { applied: ["shop/prod-eu"] } }, { op: "pulumi-up", status: "fail", wave: { applied: ["shop/prod-us"] } }] }));
    expect(await node(ROWS_JS, file, "op=pulumi-up", "wave.applied=shop/prod-eu")).toBe(0);
    expect(await node(ROWS_JS, file, "status=ok", "wave.applied=shop/prod-us")).toBe(1);
    expect(await node(ROWS_JS, file, "no.such=x")).toBe(1);
  });
});

describe("the mcp client", () => {
  const server = (tools: readonly string[]) =>
    `const r=require("readline").createInterface({input:process.stdin});r.on("line",(l)=>{const m=JSON.parse(l);if(m.id===undefined)return;const result=m.method==="tools/list"?{tools:${JSON.stringify(tools.map((name) => ({ name })))}}:m.method==="tools/call"?{content:[{type:"text",text:"shop/prod-us"}]}:{};console.log(JSON.stringify({jsonrpc:"2.0",id:m.id,result}))})`;

  it("passes on plywood's read tools alone, and fails on a tool that writes or a missing one", async () => {
    expect(await node(MCP_JS, "shop/prod-us", "node", "-e", server(["op-status", ...PLYWOOD_READ_TOOLS]))).toBe(0);
    expect(await node(MCP_JS, "shop/prod-us", "node", "-e", server([...PLYWOOD_READ_TOOLS, "plywood:request_from_template"]))).toBe(1);
    expect(await node(MCP_JS, "shop/prod-eu", "node", "-e", server([...PLYWOOD_READ_TOOLS]))).toBe(1);
    expect(await node(MCP_JS, "shop/prod-us", "node", "-e", server(["plywood:stacks"]))).toBe(1);
  });

  it("refuses every tool chant keeps off a read-only server", async () => {
    // A path in a variable: tsc stays out of chant's sources, which vitest loads as they are.
    const file = join(import.meta.dirname, "..", "..", "node_modules", "@intentius", "chant", "src", "cli", "mcp", "read-only.ts");
    const { MUTATING_CORE_TOOLS } = (await import(file)) as { MUTATING_CORE_TOOLS: ReadonlySet<string> };
    expect([...MUTATING_CORE_TOOLS].filter((t) => !(WRITE_TOOLS as readonly string[]).includes(t))).toEqual([]);
  });
});

describe("the policy overlays", () => {
  const verdict = (overlay: string, entries: unknown[]) => {
    const dir = tmp();
    const files = base(overlay);
    writeFileSync(join(dir, "check.mjs"), files["policy/check.mjs"]!);
    writeFileSync(join(dir, "denied.json"), files["policy/denied.json"]!);
    writeFileSync(join(dir, "input.json"), JSON.stringify({ changeSet: { entries } }));
    const r = spawnSync("node", [join(dir, "check.mjs"), join(dir, "input.json")], { encoding: "utf8" });
    return { status: r.status, found: conftestFindings(r.stdout) };
  };
  const events = { address: "urn:pulumi:prod-us::shop::aws:sqs/queue:Queue::events", type: "aws:sqs/queue:Queue", action: "update" };

  it("deny the events queue's update under the rule id the scenarios name, in the shape chant reads", () => {
    const r = verdict("policy-frozen-events", [events]);
    expect(r.status).toBe(1);
    expect(r.found!.denials.map((d) => d.rule)).toEqual(["main.deny_frozen"]);
    expect(readScenario("pw-policy-deny").steps.find((s) => s.id === "denied")).toMatchObject({ command: expect.arrayContaining(["policy.rules=main.deny_frozen"]) });
  });

  it("deny nothing in the BREAK arm's overlay, and nothing that only creates", () => {
    expect(verdict("policy-frozen-nothing", [events])).toMatchObject({ status: 0, found: { denials: [] } });
    expect(verdict("policy-frozen-events", [{ ...events, action: "create" }])).toMatchObject({ status: 0, found: { denials: [] } });
  });

  it("list reviewer as the one overrider, and pass plywood's config check", () => {
    expect(base("policy-frozen-events")[".chant/overriders"]).toBe("reviewer\n");
    expect(readFileSync(join(BASE_OVERLAYS_DIR, "policy-frozen-events.json"), "utf8")).toContain("requires: [approved, mergeable, undiverged]");
    const yml = readFileSync(join(import.meta.dirname, "..", "scenarios", "base", "plywood.yml"), "utf8");
    for (const name of ["policy-frozen-events", "comment-up", "notify-drift", "telemetry-on", "stock-without-prod-us"]) {
      const spec = readOverlay(BASE_OVERLAYS_DIR, name);
      expect(checkConfig(parseConfig(yml + spec.append!["plywood.yml"]!)).filter((p) => p.severity === "error"), name).toEqual([]);
    }
  });
});
