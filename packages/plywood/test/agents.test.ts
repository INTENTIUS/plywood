import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { mcp, plywoodMcpHook, plywoodMcpTools, REVIEW_OP, REVIEW_SPEC_FILE, reviewOpFile, reviewOpSpec, writeReviewJobs } from "../src/agents";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { guard, guardVerdict, withGuardHook } from "../src/guard";
import type { StageIo } from "../src/stages";
import { PRODUCT_WORDS } from "../src/words";
// @ts-ignore: the hook template is plain JS, shipped as it is.
import { verdict } from "../templates/agent-guard/plywood-guard.mjs";

const TEMPLATE_HOOK = fileURLToPath(new URL("../templates/agent-guard/plywood-guard.mjs", import.meta.url));

function fakeChant(hookFloor = true) {
  const calls: Array<{ argv: string[]; options?: { mcp?: unknown } }> = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: () => {
      throw new Error("not used");
    },
    approveLine: () => "",
    runChantInProcess: async (argv, _words, options) => {
      calls.push({ argv, ...(options ? { options } : {}) });
      return 0;
    },
    ...(hookFloor ? { PRODUCT_MCP_HOOK_FLOOR: "0.125.0" } : {}),
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
    expect(await mcp([], false, FALLBACK_EXIT, out)).toBe(0);
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
    await mcp([], false, FALLBACK_EXIT, out);
    expect(out.stderr.join("\n")).toContain("chant#4555");
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
    await writeReviewJobs(chant.api, "forgejo", parseConfig("review: true\n").doc, PRODUCT_WORDS, FALLBACK_EXIT, io(dir));
    expect(chant.calls[0]!.argv).toEqual(["run", "--generate", "forgejo", "--spec", REVIEW_SPEC_FILE, "--output", ".forgejo/workflows"]);
  });
});

describe("the agent guard", () => {
  const refused = ["pulumi up", "pulumi up --yes --stack dev", "cd shop && pulumi -C infra up", "npx plunge up", "FOO=1 pulumi destroy -y", "/usr/local/bin/pulumi update", "env -i pulumi up"];
  const allowed = ["pulumi preview", "pulumi stack ls", "plunge drift --resource urn:x", "git commit -m 'pulumi up later'", "plywood preview", "echo pulumi"];

  it("refuses an update or destroy, and lets every read through", () => {
    for (const line of refused) expect(guardVerdict(line), line).toBeDefined();
    for (const line of allowed) expect(guardVerdict(line), line).toBeUndefined();
  });

  it("gives the same answers in the hook template", () => {
    for (const line of [...refused, ...allowed]) expect(Boolean(verdict(line)), line).toBe(Boolean(guardVerdict(line)));
  });

  it("blocks pulumi up in a fixture Claude Code session (exit 2)", () => {
    const call = (command: string) => spawnSync(process.execPath, [TEMPLATE_HOOK], { input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }) });
    const blocked = call("pulumi up --yes");
    expect(blocked.status).toBe(2);
    expect(blocked.stderr.toString()).toContain("pull request");
    expect(call("pulumi preview").status).toBe(0);
  });

  it("installs the hook once into .claude/settings.json and keeps the rest", async () => {
    const dir = repo("{}\n");
    mkdirSync(join(dir, ".claude"));
    writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }));
    expect(await guard(["install"], false, FALLBACK_EXIT, io(dir))).toBe(0);
    await guard(["install"], false, FALLBACK_EXIT, io(dir));
    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    expect(settings.permissions).toEqual({ allow: ["Bash(ls)"] });
    expect(settings.hooks.PreToolUse).toHaveLength(1);
    expect(withGuardHook(settings)).toEqual(settings);
    expect(await guard(["check", "pulumi", "up"], false, FALLBACK_EXIT, io(dir))).toBe(FALLBACK_EXIT.denied);
  });
});
