/**
 * What the scenarios for plywood#60 run inside the bench's containers, each a
 * plain Node program so it needs nothing but the job image and a unit test
 * can run it as it is (e2e/test/probes.test.ts).
 *
 *   receiver  an HTTP listener on the bench's network, in a job image
 *             container of its own: every request goes to a JSON Lines file.
 *             OTLP traces and metrics, and notify's webhook, land on it. The
 *             harness's stack has no such service. Nothing here runs a real
 *             collector or checks OTLP beyond the fields named below.
 *   received  reads that file for one thing a scenario claims, and exits 0
 *             when it is there
 *   rows      reads `plywood audit --json` and exits 0 when a row holds
 *             every field=value
 *   mcp       a stdio MCP client for `plywood mcp`, which lists the tools,
 *             refuses a tool that writes, and calls plywood:stacks
 */
import { PROJECT } from "./bench";

export const RECEIVER = `${PROJECT}-receiver`;
export const RECEIVER_PORT = 4318;
/** The receiver as a job on the bench's network sees it. telemetry-on's plywood.yml names this URL. */
export const RECEIVER_URL = `http://${RECEIVER}:${RECEIVER_PORT}`;
export const RECEIVED_FILE = "/tmp/plywood-e2e-received.jsonl";

export const RECEIVER_JS = `
const fs = require("fs");
const file = process.argv[1];
require("http").createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    fs.appendFileSync(file, JSON.stringify({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString("utf8") }) + "\\n");
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
}).listen(Number(process.argv[2]), "0.0.0.0");
`;

/** `received <file> <kind> <args>...`; kind is trace, metric or signed. */
export const RECEIVED_JS = `
const fs = require("fs");
const crypto = require("crypto");
const [file, kind, ...args] = process.argv.slice(1);
const seen = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const attr = (list, key) => (list || []).find((a) => a.key === key)?.value?.stringValue;
const say = (ok, line) => { console.log(line); process.exit(ok ? 0 : 1); };
if (kind === "trace") {
  const [service, stack] = args;
  const hit = seen.filter((r) => r.path === "/v1/traces").flatMap((r) => JSON.parse(r.body).resourceSpans || []).find((rs) =>
    attr(rs.resource?.attributes, "service.name") === service &&
    (rs.scopeSpans || []).some((s) => (s.spans || []).some((x) => (attr(x.attributes, "plywood.stack") || "").endsWith(stack))));
  say(!!hit, hit ? "a trace of " + service + " has a span with plywood.stack " + stack : "no trace of " + service + " has a span with plywood.stack ending in " + stack + " (" + seen.length + " requests)");
}
if (kind === "metric") {
  const [name] = args;
  const hit = seen.filter((r) => r.path === "/v1/metrics").flatMap((r) => JSON.parse(r.body).resourceMetrics || []).flatMap((m) => m.scopeMetrics || []).flatMap((s) => s.metrics || []).find((m) => m.name === name);
  say(!!hit, hit ? "the gauge " + name + " arrived" : "no gauge " + name + " (" + seen.length + " requests)");
}
if (kind === "signed") {
  const [event, source, target, key] = args;
  const ok = seen.filter((r) => r.path === "/hook").filter((r) => {
    const ts = r.headers["x-plywood-timestamp"];
    const want = "sha256=" + crypto.createHmac("sha256", key).update(ts + "." + r.body, "utf8").digest("hex");
    const got = r.headers["x-plywood-signature"] || "";
    if (want.length !== got.length || !crypto.timingSafeEqual(Buffer.from(want), Buffer.from(got))) return false;
    const e = JSON.parse(r.body);
    return e.schema === "chant.notify/v1" && e.event === event && e.source === source && (e.drift?.changed || []).includes(target);
  });
  say(ok.length > 0, ok.length ? ok.length + " signed " + event + " event(s) from " + source + " naming " + target : "no " + event + " event from " + source + " naming " + target + " verifies under the receiver's key (" + seen.length + " requests)");
}
say(false, "received takes trace, metric or signed, not " + kind);
`;

/** `rows <file> <path=value>...`: a dotted path into a row; an array holds the value when one element equals it. */
export const ROWS_JS = `
const doc = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const wants = process.argv.slice(2).map((w) => { const i = w.indexOf("="); return [w.slice(0, i), w.slice(i + 1)]; });
const at = (o, path) => path.split(".").reduce((v, k) => (v === null || v === undefined ? undefined : v[k]), o);
const holds = (v, want) => Array.isArray(v) ? v.map(String).includes(want) : v !== undefined && v !== null && String(v) === want;
const rows = doc.rows || [];
const hit = rows.find((r) => wants.every(([p, v]) => holds(at(r, p), v)));
console.log(hit ? "a row of " + doc.table + " holds " + wants.map((w) => w.join("=")).join(", ") : "no row of " + rows.length + " in " + doc.table + " holds " + wants.map((w) => w.join("=")).join(", "));
process.exit(hit ? 0 : 1);
`;

/** The tools a read-only server never serves: chant's MUTATING_CORE_TOOLS (read-only.ts) and plywood's own forgeWrite tool. */
export const WRITE_TOOLS = [
  "import",
  "scaffold",
  "lifecycle-snapshot",
  "op-run",
  "op-approve",
  "records-new",
  "records-amend",
  "records-review",
  "records-close",
  "points-answer",
  "points-retract",
  "points-withdraw",
  "plywood:request_from_template",
] as const;

/** The tools plywood adds (src/agents.ts plywoodMcpTools), as chant names them on the server. */
export const PLYWOOD_READ_TOOLS = ["plywood:stacks", "plywood:settings", "plywood:tips", "plywood:verbs"] as const;

/** `mcp <stack key> <server program> <server args>...`: newline-delimited JSON-RPC over the server's stdio (chant's cli/mcp/server.ts). */
export const MCP_JS = `
const { spawn } = require("child_process");
const WRITE = ${JSON.stringify(WRITE_TOOLS)};
const READ = ${JSON.stringify(PLYWOOD_READ_TOOLS)};
const [stack, program, ...args] = process.argv.slice(1);
const child = spawn(program, args, { stdio: ["pipe", "pipe", "inherit"] });
const fail = (line) => { console.log(line); child.kill(); process.exit(1); };
setTimeout(() => fail("the server gave no answer within 60s"), 60000).unref();
const waiting = new Map();
let buffer = "";
child.stdout.on("data", (b) => {
  buffer += b;
  for (let i = buffer.indexOf("\\n"); i >= 0; i = buffer.indexOf("\\n")) {
    const line = buffer.slice(0, i).trim();
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id); }
  }
});
let id = 0;
const call = (method, params) => new Promise((resolve) => {
  id += 1;
  waiting.set(id, resolve);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\\n");
});
(async () => {
  await call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "plywood-e2e", version: "1" } });
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\\n");
  const names = ((await call("tools/list", {})).result?.tools || []).map((t) => t.name);
  const writes = names.filter((n) => WRITE.includes(n));
  if (writes.length) fail("the server serves tools that write: " + writes.join(", "));
  const missing = READ.filter((n) => !names.includes(n));
  if (missing.length) fail("the server lacks " + missing.join(", ") + " among " + names.join(", "));
  const r = await call("tools/call", { name: "plywood:stacks", arguments: {} });
  const text = (r.result?.content || []).map((c) => c.text || "").join("");
  if (r.result?.isError || !text.includes(stack)) fail("plywood:stacks did not name " + stack + ": " + text.slice(0, 300));
  console.log(names.length + " tools, none writes; plywood:stacks names " + stack);
  child.kill();
  process.exit(0);
})();
`;
