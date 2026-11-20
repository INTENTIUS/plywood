/**
 * plywood#36: hooks before and after a preview and an update, on chant's
 * stage hooks. The pull request jobs read `ci.hooks` at base themselves;
 * `plywood ci` and `plywood init` copy them into the waves spec, which the
 * wave job reads at the merge's first parent. Every hook command here is a
 * fake exec, and every git repository a temp one.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readOpWavePolicy, runStageHooks, type OpWaveHook, type OpWaveHookMoment } from "@intentius/chant/op";
import { prLoopHooksAt } from "@intentius/chant/components/pr-hooks";
import { chantProduct, setChantProductForTests } from "../src/chant-product";
import { EXIT } from "../src/exit-codes";
import { runInit } from "../src/init";
import { ci, type StageIo } from "../src/stages";
import { readDeclarationText, rootHooksOf, specHooksOf, withDeclarationHooks } from "../src/stage-hooks";
import { unwrapWavesSpec } from "../src/waves-workflow";
import { writingChant } from "./chant-defaults";

afterEach(() => setChantProductForTests("reset"));

const SPEC_FILE = ".chant/op-waves/pulumi-up.spec.json";

/** A hook that writes nothing: the fake exec decides its exit. */
function hook(name: string, extra: Partial<OpWaveHook> = {}): OpWaveHook {
  return { name, command: ["true", name], perRun: true, ...extra };
}

/** `ci.hooks` with one hook at every moment, and a check hook that stays out of the waves. */
const CI_HOOKS = {
  check: [{ name: "lint", command: ["true", "lint"] }],
  before: { observe: [hook("creds")], plan: [hook("config")], apply: [hook("freeze")] },
  after: { plan: [hook("scan", { onFailure: "approve" })], gate: [hook("tell")], apply: [hook("smoke")] },
};

/** A declaration's text with `ci.hooks` and the given members. */
function declaration(hooks: unknown, members: unknown[] = [{ name: "shop", dir: ".", kind: "pulumi" }]): string {
  return JSON.stringify({ name: "shop", schema: 1, members, ci: { hooks } }, null, 2) + "\n";
}

const SPEC = {
  name: "pulumi-up",
  op: "pulumi-up",
  step: { kind: "pulumi-up" },
  waves: [
    { name: "dev", runs: [{ target: "shop/dev" }, { target: "web/dev" }] },
    { name: "prod", runs: [{ target: "shop/prod" }] },
  ],
};

/** A fake exec that records each hook's name and moment, and fails the names in `failing`. */
function fakeExec(failing: string[] = []) {
  const ran: string[] = [];
  const exec = (argv: string[], _cwd: string, env?: Record<string, string>) => {
    ran.push(`${env?.CHANT_HOOK ?? "?"} ${argv[1]}${env?.CHANT_TARGET ? ` ${env.CHANT_TARGET}` : ""}`);
    return failing.includes(argv[1]!) ? 1 : 0;
  };
  return { ran, exec };
}

/** A temp git repository, never the checkout's. */
function gitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" });
  git("init", "-q", "-b", "main");
  return dir;
}

function commit(dir: string): string {
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: dir, stdio: "pipe" }).toString().trim();
  git("add", "-A");
  git("commit", "-q", "-m", "base");
  return git("rev-parse", "HEAD");
}

const MOMENTS: OpWaveHookMoment[] = ["before-observe", "before-plan", "after-plan", "after-gate", "before-apply", "after-apply"];

describe("the waves spec's hooks from ci.hooks", () => {
  it("puts each moment where a waves spec takes it, and leaves the check hooks out", () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    const spec = withDeclarationHooks(SPEC, { text: declaration(CI_HOOKS), file: "chant.workspace.json" }, root) as Record<string, unknown>;
    expect(spec.hooks).toEqual({ before: CI_HOOKS.before, after: CI_HOOKS.after });
    expect(Object.keys(spec)).toEqual(["name", "op", "step", "hooks", "waves"]);
  });

  it("adds the hooks of the member at the root after the top level's, and not another member's", () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    const members = [
      { name: "shop", dir: ".", kind: "pulumi", ci: { hooks: { before: { plan: [hook("root-member")] } } } },
      { name: "web", dir: "web", kind: "pulumi", ci: { hooks: { before: { plan: [hook("web-member")] } } } },
    ];
    const hooks = rootHooksOf({ text: declaration({ before: { plan: [hook("top")] } }, members), file: "chant.workspace.json" }, root);
    expect(hooks["before-plan"]!.map((h) => h.name)).toEqual(["top", "root-member"]);
  });

  it("names the stacks whose component a hook's targets match, and leaves out a hook that matches none", () => {
    const out = specHooksOf(
      { "before-plan": [hook("prod-only", { targets: ["*-prod"] }), hook("shop", { targets: ["shop-*"] }), hook("stack-keys", { targets: ["shop/*"] })] },
      SPEC,
    );
    expect(out).toEqual({ before: { plan: [hook("prod-only", { targets: ["shop/prod"] }), hook("shop", { targets: ["shop/dev", "shop/prod"] })] } });
  });

  it("keeps the spec's hooks.apply.runBy, drops hooks no longer declared, and leaves a spec alone without a declaration", () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    const old = { ...SPEC, hooks: { before: { plan: [hook("gone")] }, apply: { runBy: "apply" } } };
    expect(withDeclarationHooks(old, { text: declaration({ check: [] }), file: "chant.workspace.json" }, root)).toEqual({ ...SPEC, hooks: { apply: { runBy: "apply" } } });
    expect(withDeclarationHooks({ ...SPEC, hooks: { before: { plan: [hook("gone")] } } }, { text: declaration({}), file: "chant.workspace.json" }, root)).toEqual(SPEC);
    expect(withDeclarationHooks(old, undefined, root)).toBe(old);
  });

  it("refuses with chant's message a hook chant could not run", () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    const bad = { text: declaration({ after: { apply: [hook("late", { onFailure: "approve" })] } }), file: "chant.workspace.json" };
    expect(() => withDeclarationHooks(SPEC, bad, root)).toThrow(/after the apply there is nothing left to hold/);
  });
});

describe("the hooks around a preview", () => {
  it("are chant's pull request hooks read at base, so a change cannot remove its own hook", () => {
    const dir = gitRepo();
    writeFileSync(join(dir, "chant.workspace.json"), declaration(CI_HOOKS));
    const base = commit(dir);
    writeFileSync(join(dir, "chant.workspace.json"), declaration({}));
    const read = prLoopHooksAt(dir, base);
    expect(read.hooks["before-plan"]!.map((h) => h.name)).toEqual(["config"]);
    expect(read.hooks["after-plan"]!.map((h) => h.name)).toEqual(["scan"]);
  });

  it("run before the observe, before the plan and after it, once for each stack", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    const hooks = rootHooksOf({ text: declaration(CI_HOOKS), file: "chant.workspace.json" }, dir);
    const { ran, exec } = fakeExec();
    const runs = [{ target: "shop-dev", op: "pulumi-up" }];
    for (const moment of ["before-observe", "before-plan", "after-plan"] as const) {
      const r = runStageHooks(moment, hooks[moment], { name: "pr-7", op: "pr-7", wave: "production", runs, runsFile: "runs.json", holdFile: "hold.json", cwd: dir, exec, log: () => {} });
      expect(r.failed, moment).toBeUndefined();
    }
    expect(ran).toEqual(["before-observe creds shop-dev", "before-plan config shop-dev", "after-plan scan shop-dev"]);
  });
});

describe("a failing hook", () => {
  const runs = [{ target: "shop/dev", op: "pulumi-up" }];
  const options = (dir: string, exec: ReturnType<typeof fakeExec>["exec"]) => ({ name: "pulumi-up", op: "pulumi-up", wave: "dev", runs, runsFile: "runs.json", holdFile: "hold.json", cwd: dir, exec, log: () => {} });

  it("with onFailure fail, the default, stops the stage and the hooks after it do not run", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    const { ran, exec } = fakeExec(["config"]);
    const r = runStageHooks("before-plan", [hook("config"), hook("after-config")], options(dir, exec));
    expect(r.failed).toBeDefined();
    expect(r.holds).toEqual([]);
    expect(ran).toEqual(["before-plan config shop/dev"]);
  });

  it("with onFailure approve, holds the wave for an approval and the hooks after it still run", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    const { ran, exec } = fakeExec(["scan"]);
    const r = runStageHooks("after-plan", [hook("scan", { onFailure: "approve" }), hook("report")], options(dir, exec));
    expect(r.failed).toBeUndefined();
    expect(r.holds).toEqual([expect.stringContaining("scan")]);
    expect(ran).toEqual(["after-plan scan shop/dev", "after-plan report shop/dev"]);
  });
});

function stageIo(cwd: string): StageIo & { stderr: string[] } {
  const stderr: string[] = [];
  return { stderr, cwd, env: {}, out: () => {}, err: (s) => stderr.push(s) };
}

describe("plywood ci", () => {
  it("writes ci.hooks into the waves spec the merge's wave jobs read", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "plywood.yml"), "stacks:\n  shop/dev: {}\n  shop/prod: {}\n");
    writeFileSync(join(dir, "chant.workspace.json"), declaration(CI_HOOKS));
    mkdirSync(join(dir, ".chant/op-waves"), { recursive: true });
    writeFileSync(join(dir, SPEC_FILE), JSON.stringify(SPEC));
    setChantProductForTests(writingChant(() => dir));
    expect(await ci([], false, EXIT, stageIo(dir))).toBe(0);
    const spec = unwrapWavesSpec(JSON.parse(readFileSync(join(dir, SPEC_FILE), "utf8"))) as { hooks?: unknown };
    expect(spec.hooks).toEqual({ before: CI_HOOKS.before, after: CI_HOOKS.after });
  });

  it("fails and names the hook when chant.workspace.json has one chant could not run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-hooks-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "plywood.yml"), "stacks:\n  shop/dev: {}\n");
    writeFileSync(join(dir, "chant.workspace.json"), declaration({ before: { gate: [hook("x")] } }));
    mkdirSync(join(dir, ".chant/op-waves"), { recursive: true });
    writeFileSync(join(dir, SPEC_FILE), JSON.stringify(SPEC));
    setChantProductForTests(writingChant(() => dir));
    const out = stageIo(dir);
    expect(await ci([], false, EXIT, out)).toBe(EXIT.failed);
    expect(out.stderr.join("\n")).toMatch(/ci\.hooks: .*hooks\.before\.gate/);
  });
});

const real = await chantProduct();

/** `plywood init --forge` against the installed chant, in a temp git repository of two stacks with `ci.hooks` declared. */
async function initWithHooks(forge: "github" | "forgejo" | "gitlab"): Promise<string> {
  setChantProductForTests("reset");
  const dir = gitRepo();
  writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: nodejs\n");
  writeFileSync(join(dir, "Pulumi.dev.yaml"), "config: {}\n");
  writeFileSync(join(dir, "Pulumi.prod.yaml"), "config: {}\n");
  writeFileSync(join(dir, "package.json"), '{"name":"shop","private":true}\n');
  writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "shop", schema: 1, ci: { hooks: { ...CI_HOOKS, before: { ...CI_HOOKS.before, plan: [hook("config"), hook("prod-config", { targets: ["shop-prod"] })] } } } }, null, 2));
  const was = process.cwd();
  process.chdir(dir);
  const r = await runInit({ env: "production", bucketCheck: false, dryRun: false, yes: true, forge }, EXIT, { cwd: dir, env: {}, out: () => {}, err: () => {} }).finally(() => process.chdir(was));
  expect(r.ok, JSON.stringify([r.notes, r.files])).toBe(true);
  return dir;
}

describe.runIf(real !== undefined)("plywood init against the installed chant", () => {
  it("writes the hooks into the waves spec on GitHub, GitLab and Forgejo, with chant's generator writing the wave jobs", async () => {
    for (const forge of ["github", "forgejo", "gitlab"] as const) {
      const dir = await initWithHooks(forge);
      const spec = unwrapWavesSpec(JSON.parse(readFileSync(join(dir, SPEC_FILE), "utf8"))) as { hooks?: { before?: { plan?: OpWaveHook[] } } };
      expect(spec.hooks?.before?.plan, forge).toEqual([hook("config"), hook("prod-config", { targets: ["shop/prod"] })]);
      const out = forge === "github" ? ".github/workflows" : forge === "forgejo" ? ".forgejo/workflows" : ".";
      const waves = readdirSync(join(dir, out)).filter((f) => /pulumi-up.*\.ya?ml$/.test(f));
      expect(waves.length, forge).toBeGreaterThan(0);
      expect(existsSync(join(dir, out, waves[0]!)), forge).toBe(true);
    }
  }, 120_000);

  it("the wave job reads them at base, every moment, and runs each for the wave's stacks", async () => {
    const dir = await initWithHooks("github");
    const base = commit(dir);
    // A later change that drops every hook does not change what the wave runs: chant reads the spec at base.
    const spec = JSON.parse(readFileSync(join(dir, SPEC_FILE), "utf8"));
    delete (unwrapWavesSpec(spec) as { hooks?: unknown }).hooks;
    writeFileSync(join(dir, SPEC_FILE), JSON.stringify(spec));
    const waves = (unwrapWavesSpec(JSON.parse(execFileSync("git", ["show", `${base}:${SPEC_FILE}`], { cwd: dir }).toString())) as { waves: Array<{ name: string; runs: Array<{ target: string }> }> }).waves;
    const prod = waves.find((w) => w.runs.some((r) => r.target === "shop/prod"))!;
    const rules = readOpWavePolicy(SPEC_FILE, prod.name, base, dir);
    expect(rules.hooksRefused).toBeUndefined();
    const { ran, exec } = fakeExec();
    for (const moment of MOMENTS) {
      runStageHooks(moment, rules.hooks[moment], { name: "pulumi-up", op: "pulumi-up", wave: prod.name, runs: prod.runs.map((r) => ({ target: r.target, op: "pulumi-up" })), runsFile: "runs.json", holdFile: "hold.json", cwd: dir, exec, log: () => {} });
    }
    expect(ran).toEqual([
      "before-observe creds shop/prod",
      "before-plan config shop/prod",
      "before-plan prod-config shop/prod",
      "after-plan scan shop/prod",
      "after-gate tell shop/prod",
      "before-apply freeze shop/prod",
      "after-apply smoke shop/prod",
    ]);
  }, 60_000);
});
