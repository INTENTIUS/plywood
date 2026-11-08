import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { mcp, plywoodMcpHook, plywoodProposeTools, plywoodMcpTools, REVIEW_OP, REVIEW_SPEC_FILE, reviewOpFile, reviewOpSpec, writeReviewJobs } from "../src/agents";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { EXIT } from "../src/exit-codes";
import { guard } from "../src/guard";
import type { StageIo } from "../src/stages";
import { PRODUCT_WORDS, TEMPLATE_REQUEST_WORDS } from "../src/words";

function fakeChant(hookFloor = true) {
  const calls: Array<{ argv: string[]; options?: { mcp?: unknown } }> = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: () => {
      throw new Error("not used");
    },
    approveLine: () => "",
    pendingGatesByPlan: async () => [],
    parseRequiresList: (values) => ({ checks: values.flatMap((v) => v.split(",")) }),
    runChantInProcess: async (argv, _words, options) => {
      calls.push({ argv, ...(options ? { options } : {}) });
      return 0;
    },
    ...(hookFloor ? { PRODUCT_MCP_HOOK_FLOOR: "0.125.0" } : {}),
    PRODUCT_TOOL_PROPOSE_WORDS: ["request", "propose"],
  };
  return { api, calls };
}

function io(cwd: string): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env: {}, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

function repo(yml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-agents-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  return dir;
}

afterEach(() => setChantProductForTests("reset"));

describe("plywood mcp", () => {
  it("starts chant's read-only server with plywood's read tools through the hook", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const out = io(repo("stacks:\n  shop/dev: {}\n"));
    expect(await mcp([], false, EXIT, out)).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["serve", "mcp", "--read-only"]);
    const hook = chant.calls[0]!.options!.mcp as ReturnType<typeof plywoodMcpHook>;
    expect(hook.product).toBe("plywood");
    expect(hook.readOnly).toBe(true);
    expect(out.stdout).toEqual([]);
  });

  it("declares every tool read-only and names none as a write", async () => {
    const dir = repo("stacks:\n  shop/dev: { dir: shop }\n");
    const tools = plywoodMcpTools({ cwd: dir });
    expect(tools.map((t) => t.name)).toEqual(["stacks", "settings", "tips", "verbs"]);
    expect(tools.every((t) => t.readOnly === true)).toBe(true);
    const write = /^(approve|apply|override|unlock|lock|merge|write|delete|push|commit|update|create|exec|init|generate|respond)/;
    expect(tools.filter((t) => write.test(t.name))).toEqual([]);
    expect(await tools[0]!.handler({})).toMatchObject({ stacks: { "shop/dev": { dir: "shop" } } });
  });

  it("says so when the installed chant has no product tool hook", async () => {
    setChantProductForTests(fakeChant(false).api);
    const out = io(repo("{}\n"));
    await mcp([], false, EXIT, out);
    expect(out.stderr.join("\n")).toContain("chant#4555");
  });
});

/**
 * The tools a server lists, served the way chant#4655's productToolsServed
 * serves them: a read-only server keeps the read tools and refuses to start
 * with a forgeWrite tool; the propose tier keeps both.
 */
function listed(hook: ReturnType<typeof plywoodMcpHook>, cwd: string, propose: boolean): string[] {
  const tools = hook.tools({ cwd, readOnly: true, propose });
  for (const t of tools) if (t.forgeWrite === true && !propose) throw new Error(`${t.name} is forgeWrite on a server without --propose`);
  return tools.map((t) => `${hook.product}:${t.name}`);
}

describe("plywood mcp --propose", () => {
  it("starts chant's propose tier, which lists request_from_template beside the read tools", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const dir = repo("stacks:\n  shop/dev: {}\n");
    const out = io(dir);
    expect(await mcp(["--propose"], false, EXIT, out)).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["serve", "mcp", "--read-only", "--propose"]);
    const hook = chant.calls[0]!.options!.mcp as ReturnType<typeof plywoodMcpHook>;
    expect(hook.readOnly).toBe(true);
    expect(hook.propose).toBe(true);
    expect(listed(hook, dir, true)).toEqual(["plywood:stacks", "plywood:settings", "plywood:tips", "plywood:verbs", "plywood:request_from_template"]);
    expect(hook.instructions).toContain("refuses every call");
    expect(out.stdout).toEqual([]);
  });

  it("lists no request tool on plain plywood mcp", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const dir = repo("{}\n");
    await mcp([], false, EXIT, io(dir));
    const hook = chant.calls[0]!.options!.mcp as ReturnType<typeof plywoodMcpHook>;
    expect(hook.propose).toBeUndefined();
    expect(listed(hook, dir, false)).not.toContain("plywood:request_from_template");
    // The propose hook on a server that did not take the tier (a chant that drops `propose`) still lists only read tools.
    expect(listed(plywoodMcpHook(undefined, true), dir, false)).not.toContain("plywood:request_from_template");
  });

  it("declares request_from_template forgeWrite, named with request as its only write word", () => {
    const [tool] = plywoodProposeTools();
    expect(tool!.name).toBe("request_from_template");
    expect(tool!.forgeWrite).toBe(true);
    expect(tool!.readOnly).toBeUndefined();
    expect(tool!.inputSchema.required).toEqual(["template", "name", "inputs"]);
    expect(Object.keys(tool!.inputSchema.properties)).toEqual(["template", "version", "name", "app", "inputs"]);
    const write = /^(approve|apply|override|unlock|lock|merge|write|delete|push|commit|update|create|exec|init|generate|respond)/;
    expect(tool!.name.split("_").filter((p) => write.test(p))).toEqual([]);
  });

  it("refuses every call, saying Pulumi templates are not available yet and naming no issue", async () => {
    const [tool] = plywoodProposeTools();
    await expect(tool!.handler({ template: "bucket", name: "orders", inputs: {} })).rejects.toThrow(TEMPLATE_REQUEST_WORDS.refusal);
    expect(TEMPLATE_REQUEST_WORDS.refusal).toMatch(/^Pulumi templates are not available yet/);
    expect(TEMPLATE_REQUEST_WORDS.refusal).toContain("template registry and catalog");
    expect(TEMPLATE_REQUEST_WORDS.refusal).not.toMatch(/#\d/);
  });

  it("takes --propose with --report-url in either order", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await mcp(["--propose", "--report-url", "file:///r"], false, EXIT, io(repo("{}\n")))).toBe(0);
    expect(await mcp(["--report-url", "file:///r", "--propose"], false, EXIT, io(repo("{}\n")))).toBe(0);
    for (const c of chant.calls) expect((c.options!.mcp as ReturnType<typeof plywoodMcpHook>).reportUrl).toBe("file:///r");
  });
});

describe("the review agent", () => {
  it("checks the review and agent keys", () => {
    expect(checkConfig(parseConfig("review: true\n")).filter((p) => p.severity === "error")).toEqual([]);
    const keys = checkConfig(parseConfig("review: { key_env: 'sk-123' }\nagent: { max_runs: 0 }\n")).filter((p) => p.severity === "error").map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["review.key_env", "agent.max_runs"]));
  });

  it("writes a pull request Op with reviewAgent in handoff mode, and a spec chant generates two jobs from", async () => {
    const doc = parseConfig("review: { command: ./bin/fake-model, key_env: FAKE_KEY }\n").doc;
    const op = reviewOpFile(doc);
    expect(op).toContain('mode: "handoff"');
    expect(op).toContain('command: "./bin/fake-model"');
    expect(op).toContain("--no-status");
    expect(reviewOpSpec(doc).ops).toEqual([{ name: REVIEW_OP, trigger: { kind: "pull_request" }, reviewAgent: true }]);

    const chant = fakeChant();
    const dir = repo("review: true\n");
    await writeReviewJobs(chant.api, "forgejo", parseConfig("review: true\n").doc, PRODUCT_WORDS, EXIT, io(dir));
    expect(chant.calls[0]!.argv).toEqual(["run", "--generate", "forgejo", "--spec", REVIEW_SPEC_FILE, "--output", ".forgejo/workflows"]);
  });
});

describe("the agent guard (chant's, chant#4770)", () => {
  const refused = ["pulumi up", "pulumi up --yes --stack dev", "cd shop && pulumi -C infra up", "npx plunge up", "FOO=1 pulumi destroy -y", "/usr/local/bin/pulumi update", "env -i pulumi up", "bash -c 'pulumi up'", "plywood up --pr 3", "plywood approve up --plan sha256:x", "plywood drift --respond up"];
  const allowed = ["pulumi preview", "pulumi stack ls", "plunge drift --resource urn:x", "git commit -m 'pulumi up later'", "plywood preview", "plywood drift", "echo pulumi"];

  it("refuses an update, destroy or plywood's own applying verbs, and lets every read through", async () => {
    const dir = repo("{}\n");
    for (const line of refused) expect(await guard(["check", line], false, EXIT, io(dir)), line).toBe(EXIT.denied);
    for (const line of allowed) expect(await guard(["check", line], false, EXIT, io(dir)), line).toBe(EXIT.done);
    const o = io(dir);
    await guard(["check", "pulumi", "up"], true, EXIT, o);
    expect(JSON.parse(o.stdout[0]!).refused).toMatchObject({ engine: "pulumi", subcommand: "up", message: expect.stringContaining("plywood guard: ") });
  });

  it("installs the hook once into .claude/settings.json, keeps the rest, and the hook blocks pulumi up (exit 2)", async () => {
    const dir = repo("{}\n");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    const o = io(dir);
    expect(await guard(["install"], true, EXIT, o)).toBe(0);
    expect(JSON.parse(o.stdout[0]!).written).toEqual(expect.arrayContaining([".claude/hooks/plywood-guard.mjs", ".claude/settings.json", ".plywood/agent-bin/pulumi", ".plywood/agent-bin/plunge"]));
    await guard(["install"], false, EXIT, io(dir));
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    const hook = join(dir, ".claude/hooks/plywood-guard.mjs");
    const call = (command: string) => spawnSync(process.execPath, [hook, "hook"], { cwd: dir, input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: dir }) });
    const blocked = call("pulumi up --yes");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr.toString()).toContain("pull request");
    expect(call("pulumi preview").status).toBe(0);
  });
});
