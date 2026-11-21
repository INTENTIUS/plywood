/**
 * plywood.yml's `promotion` (plywood#154): the config's checks, the
 * component per project init writes from it, `plywood promote` on chant's
 * `components promote`, and one repository with a stack per environment
 * carried dev, staging, prod by the installed chant and the pulumi on PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CHANT_DEFAULTS } from "./chant-defaults";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { main } from "../src/cli";
import { checkConfig, parseConfig } from "../src/config/index";
import { environmentsOf } from "../src/config/jobs";
import { planEnvironment, promotionTargets, stageTargetsOf } from "../src/config/promotion";
import { EXIT } from "../src/exit-codes";
import { runInit } from "../src/init";
import { chantConfigTs, chantConfigWrittenByPlywood, promotionComponentsFile, RELEASE_GATE, type InitStack } from "../src/init/render";
import { promoteRelease, rollbackStack } from "../src/stack-ops";
import type { StageIo } from "../src/stages";
import { approveTarget, RELEASE_GATE_OP } from "../src/up";

const T = EXIT;

afterEach(() => setChantProductForTests("reset"));

function io(cwd: string, env: NodeJS.ProcessEnv = {}): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

const errors = (yml: string): string[] =>
  checkConfig(parseConfig(yml)).filter((p) => p.severity === "error").map((p) => `${p.key} ${p.message}`);

const STACKS = "stacks:\n  shop/dev: { dir: . }\n  shop/staging: { dir: . }\n  shop/prod: { dir: ., gate: always }\n";

describe("promotion in plywood.yml", () => {
  it("takes the environments in order, each project's stack found by name", () => {
    expect(errors(`${STACKS}promotion: [dev, staging, prod]\n`)).toEqual([]);
    expect(planEnvironment(parseConfig(`${STACKS}promotion: [dev, staging, prod]\n`).doc)).toBe("dev");
    expect(planEnvironment(parseConfig(STACKS).doc)).toBe("production");
  });

  it("refuses one environment, a name twice, a pattern and a pull request's name", () => {
    expect(errors(`${STACKS}promotion: [dev]\n`).join("\n")).toContain("at least two environments");
    expect(errors(`${STACKS}promotion: [dev, staging, dev]\n`).join("\n")).toContain("dev twice");
    expect(errors(`${STACKS}promotion: [dev, "prod-*"]\n`).join("\n")).toContain("not an environment name");
    expect(errors(`${STACKS}promotion: [dev, pr-7]\n`).join("\n")).toContain("pull request's environment");
  });

  it("refuses a stack no environment takes, and a project with two stacks in one", () => {
    expect(errors(`${STACKS}promotion: [dev, staging]\n`).join("\n")).toContain("shop/prod is no environment's stack");
    const two = "stacks:\n  shop/dev: {}\n  shop/prod-us: {}\n  shop/prod-eu: {}\npromotion: [dev, prod]\n";
    expect(errors(two).join("\n")).toContain("shop/prod-us and shop/prod-eu in environment prod");
    // Each region its own environment, or targets naming one stack, settles it.
    expect(errors("stacks:\n  shop/dev: {}\n  shop/prod-us: {}\n  shop/prod-eu: {}\npromotion: [dev, prod-us, prod-eu]\n")).toEqual([]);
  });

  it("reads environments.<name>.targets beside the stack globs, on Forgejo too", () => {
    const yml = "stacks:\n  shop/development: {}\n  shop/live: {}\npromotion: [dev, prod]\nforge: { kind: forgejo }\nenvironments:\n  dev: { targets: { shop: development } }\n  prod: { targets: { shop: shop/live } }\n";
    expect(errors(yml)).toEqual([]);
    expect(environmentsOf(parseConfig(yml).doc)).toEqual([]);
    expect(errors(`${STACKS}environments:\n  dev: { targets: { shop: dev } }\n`).join("\n")).toContain("has no promotion");
    expect(errors(`${STACKS}promotion: [dev, staging, prod]\nenvironments:\n  qa: { targets: { shop: dev } }\n`).join("\n")).toContain("promotion does not list qa");
    expect(errors(`${STACKS}promotion: [dev, staging, prod]\nenvironments:\n  dev: { targets: { shop: nope } }\n`).join("\n")).toContain("not a stack of shop");
    // A glob's forge environment on Forgejo is still refused.
    expect(errors(`${STACKS}forge: { kind: forgejo }\nenvironments: { "*/prod": production }\n`).join("\n")).toContain("Forgejo has no deployment environments");
  });

  it("reads a map of stage keys under environments as a stage, and a glob's name or { name, url } as forge_environments' earlier spelling", () => {
    const yml = `${STACKS}promotion: [dev, staging, prod]\nforge_environments: { "*/prod": production }\nenvironments:\n  dev: { targets: { shop: dev } }\n  staging: { targets: { shop: staging } }\n  prod: { targets: { shop: prod } }\n  "*/dev": { name: development, url: https://dev.example.com }\n`;
    expect(errors(yml)).toEqual([]);
    expect(environmentsOf(parseConfig(yml).doc)).toEqual([
      { glob: "*/prod", environment: { name: "production" } },
      { glob: "*/dev", environment: { name: "development", url: "https://dev.example.com" } },
    ]);
    expect(stageTargetsOf(parseConfig(yml).doc)).toEqual({ dev: { shop: "dev" }, staging: { shop: "staging" }, prod: { shop: "prod" } });
    expect(errors(`${STACKS}forge_environments: { "*/prod": production }\nenvironments: { "*/prod": live }\n`).join("\n")).toMatch(/names the same glob|are both set/);
  });

  it("settles each project's stack per environment", () => {
    const stacks = ["dev", "staging", "prod-east"].map((s) => ({ key: `shop/${s}`, project: "shop", stack: s }));
    expect(promotionTargets(["dev", "staging", "prod"], stacks)).toEqual({ projects: [{ project: "shop", byEnv: { dev: "shop/dev", staging: "shop/staging", prod: "shop/prod-east" } }], problems: [] });
  });
});

const stack = (s: string, more: Partial<InitStack> = {}): InitStack => ({ key: `shop/${s}`, project: "shop", stack: s, dir: "infra", ...more });

describe("the component per project", () => {
  const parse = (text: string) => JSON.parse(/= (\{.*\});$/m.exec(text)![1]!) as { name: string; deploy: Array<{ steps: Array<Record<string, unknown>> }> };

  it("keeps the shared inputs on the step and each environment's stack in its map", () => {
    const byEnv = { dev: stack("dev", { backend: "file:///a" }), prod: stack("prod", { backend: "file:///b" }) };
    const c = parse(promotionComponentsFile([{ project: "shop", byEnv, gates: { dev: "on-destructive", prod: "always" } }], ["dev", "prod"]));
    expect(c.name).toBe("shop");
    const [gate, step] = c.deploy[0]!.steps;
    expect(gate).toEqual({ kind: "gate", gate: RELEASE_GATE, description: "approve with plywood approve release --plan <digest>" });
    expect(step).toEqual({ kind: "pulumi-up", dir: "infra", member: "shop", environments: { dev: { stack: "dev", backend: "file:///a" }, prod: { stack: "prod", backend: "file:///b" } } });
  });

  it("names the gated environments on the gate when some do not gate, and writes none when none do", () => {
    const byEnv = { dev: stack("dev"), prod: stack("prod") };
    const some = parse(promotionComponentsFile([{ project: "shop", byEnv, gates: { dev: "never", prod: "always" } }], ["dev", "prod"]));
    expect(some.deploy[0]!.steps[0]).toMatchObject({ kind: "gate", environments: ["prod"] });
    const none = parse(promotionComponentsFile([{ project: "shop", byEnv, gates: { dev: "never", prod: "never" } }], ["dev", "prod"]));
    expect(none.deploy[0]!.steps.map((s) => s.kind)).toEqual(["pulumi-up"]);
  });

  it("lists the environments in chant.config.ts, and init writes it again only when it wrote it", () => {
    const text = chantConfigTs(["dev", "staging", "prod"]);
    expect(text).toContain('  environments: ["dev", "staging", "prod"],');
    expect(chantConfigWrittenByPlywood(text)).toBe(true);
    expect(chantConfigWrittenByPlywood(chantConfigTs())).toBe(true);
    expect(chantConfigTs()).not.toContain("environments");
    expect(chantConfigWrittenByPlywood(text.replace('lexicons: ["pulumi"],', 'lexicons: ["pulumi", "aws"],'))).toBe(false);
  });
});

function fakeChant(code = 0) {
  const calls: string[][] = [];
  const api = {
    assertProductWords: (w: unknown) => w,
    productPipelineJobs: () => ({}),
    approveLine: () => "",
    ...CHANT_DEFAULTS,
    runChantInProcess: async (argv: string[]) => {
      calls.push(argv);
      return code;
    },
  } as unknown as ChantProduct;
  return { api, calls };
}

function repo(yml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-promote-"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  return dir;
}

describe("plywood promote", () => {
  const YML = `${STACKS}promotion: [dev, staging, prod]\n`;

  it("runs chant's components promote with the flags it passes on", async () => {
    const chant = fakeChant(T.waiting);
    setChantProductForTests(chant.api);
    const out = io(repo(YML));
    expect(await promoteRelease(["--to", "staging", "--release", "r1", "--actor", "ana", "--dry-run"], false, T, out)).toBe(T.waiting);
    expect(chant.calls).toEqual([["components", "promote", "--to", "staging", "--release", "r1", "--actor", "ana", "--dry-run"]]);
    expect(out.stderr.join("\n")).toContain("plywood approve release --plan <digest>");
    expect(await promoteRelease(["--to", "prod", "--from", "dev", "--allow-skip"], true, T, io(repo(YML)))).toBe(T.waiting);
    expect(chant.calls[1]).toEqual(["components", "promote", "--to", "prod", "--from", "dev", "--allow-skip", "--json"]);
  });

  it("refuses with no promotion, an environment it does not list, the first one, and no --to", async () => {
    const chant = fakeChant(0);
    setChantProductForTests(chant.api);
    const cases: Array<[string, string[], string]> = [
      [STACKS, ["--to", "staging"], "sets no promotion"],
      [YML, ["--to", "qa"], "--to qa is not an environment of promotion"],
      [YML, ["--to", "prod", "--from", "qa"], "--from qa is not an environment of promotion"],
      [YML, ["--to", "dev"], "first environment of promotion"],
      [YML, [], "needs the environment it deploys to"],
      [YML, ["staging"], "names its environment with --to"],
    ];
    for (const [yml, args, message] of cases) {
      const out = io(repo(yml));
      expect(await promoteRelease(args, false, T, out)).toBe(T.failed);
      expect(out.stderr.join("\n")).toContain(message);
    }
    expect(chant.calls).toEqual([]);
  });

  it("rolls a stack back as its project's component, in the environment that takes it", async () => {
    const chant = fakeChant(0);
    setChantProductForTests(chant.api);
    const dir = repo("stacks:\n  shop/dev: {}\n  shop/live: {}\npromotion: [dev, prod]\nenvironments:\n  dev: {}\n  prod: { targets: { shop: live } }\n");
    expect(await rollbackStack(["shop/live"], false, T, io(dir))).toBe(T.done);
    expect(chant.calls).toEqual([["components", "rollback", "prod", "--component", "shop"]]);
  });

  it("approves the release gate under chant's release op", () => {
    expect(approveTarget(RELEASE_GATE, {})).toEqual({ op: RELEASE_GATE_OP, gate: RELEASE_GATE });
  });
});

const hasPulumi = spawnSync("pulumi", ["version"], { encoding: "utf8" }).status === 0;

/**
 * One repository with a stack per environment, carried by the installed
 * chant and the pulumi on PATH, over a file backend in a temp directory.
 * plywood init writes the component, the merge's stand-in deploys dev under
 * release r1, and `plywood promote` carries it to staging and then prod.
 */
describe.runIf(hasPulumi)("a release carried dev, staging, prod on the installed chant", () => {
  it("updates the staging stack only on promote --to staging, refuses a skip, and waits at each environment's gate until another person approves", async () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-promote-real-"));
    const dir = join(root, "repo");
    const state = join(root, "state");
    mkdirSync(dir);
    mkdirSync(state);
    const saved = { ...process.env };
    const was = process.cwd();
    Object.assign(process.env, {
      PULUMI_CONFIG_PASSPHRASE: "plywood-test",
      PULUMI_SKIP_UPDATE_CHECK: "1",
      PULUMI_HOME: join(root, "pulumi-home"),
      GIT_AUTHOR_NAME: "ana", GIT_AUTHOR_EMAIL: "ana@example.com", GIT_COMMITTER_NAME: "ana", GIT_COMMITTER_EMAIL: "ana@example.com",
    });
    delete process.env.GIT_DIR;
    delete process.env.CHANT_ENV;
    const git = (...args: string[]) => {
      const r = spawnSync("git", args, { cwd: dir, encoding: "utf8" });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
      return r.stdout.trim();
    };
    // chant prints to stderr in process, so the run's text is plywood's lines and whatever reached stderr.
    const plywood = async (...args: string[]) => {
      const out: string[] = [];
      const write = process.stderr.write.bind(process.stderr);
      const { error, log, warn } = console;
      const keep = (...a: unknown[]) => void out.push(a.map(String).join(" "));
      process.stderr.write = ((chunk: string | Uint8Array) => (out.push(String(chunk)), true)) as typeof process.stderr.write;
      Object.assign(console, { error: keep, log: keep, warn: keep });
      try {
        const code = await main(args, { out: (s) => out.push(s), err: (s) => out.push(s) });
        return { code, text: out.join("\n") };
      } finally {
        process.stderr.write = write;
        Object.assign(console, { error, log, warn });
      }
    };
    const updated = () => (existsSync(join(state, ".pulumi", "history", "shop")) ? readdirSync(join(state, ".pulumi", "history", "shop")).sort() : []);
    try {
      spawnSync("git", ["init", "-q", "--bare", join(root, "origin.git")]);
      git("init", "-q", "-b", "main");
      git("remote", "add", "origin", join(root, "origin.git"));
      writeFileSync(join(dir, "Pulumi.yaml"), `name: shop\nruntime: yaml\nbackend:\n  url: file://${state}\noutputs:\n  where: \${pulumi.stack}\n`);
      for (const s of ["dev", "staging", "prod"]) {
        writeFileSync(join(dir, `Pulumi.${s}.yaml`), "config: {}\n");
        const made = spawnSync("pulumi", ["stack", "init", s, "--non-interactive"], { cwd: dir, encoding: "utf8" });
        expect(made.status, made.stderr).toBe(0);
      }
      // Every environment's gate asks, so each deploy waits at the release gate until someone other than its author approves.
      writeFileSync(join(dir, "plywood.yml"), "stacks:\n  shop/dev: { dir: . }\n  shop/staging: { dir: . }\n  shop/prod: { dir: . }\npromotion: [dev, staging, prod]\nforge: { kind: forgejo }\n");
      process.chdir(dir);
      const init = await runInit({ bucketCheck: false, dryRun: false, yes: true }, T, { cwd: dir, env: {}, out: () => {}, err: () => {} });
      expect(init.ok, init.notes.join("\n")).toBe(true);
      expect(init.waves).toEqual([{ name: "dev", stacks: ["shop/dev"] }]);
      git("add", "-A");
      git("commit", "-qm", "plywood init");
      git("push", "-q", "origin", "main");
      git("tag", "-a", `ci/green/${git("rev-parse", "HEAD")}`, "-m", "green");

      /** Runs `args` as ana: it waits at the release gate, bo approves the change set it names, and the same command runs. */
      const approved = async (env: string, ...args: string[]) => {
        const waiting = await plywood(...args, "--actor", "ana");
        expect(waiting.code, waiting.text).toBe(T.waiting);
        const digest = new RegExp(`release gate: change set (\\S+) for "${env}"`).exec(waiting.text)?.[1];
        expect(digest, waiting.text).toBeDefined();
        const ok = await plywood("approve", RELEASE_GATE, "--plan", digest!, "--approver", "bo", "--yes");
        expect(ok.code, ok.text).toBe(0);
        const ran = await plywood(...args, "--actor", "ana");
        expect(ran.code, ran.text).toBe(0);
      };

      // The merge's stand-in: release r1 cut from main, and dev runs it.
      const release = spawnSync(process.execPath, [join(was, "node_modules", ".bin", "chant"), "release", "cut", "r1", "--yes"], { cwd: dir, encoding: "utf8", env: process.env });
      expect(release.status, release.stderr).toBe(0);
      git("push", "-q", "origin", "--tags");
      // chant run waits at the component's gate in dev too; bo approves it with chant's own line, as the merge's stand-in.
      const deploy = ["run", "--components", "all", "--env", "dev", "--release", "r1", "--yes", "--actor", "ana"];
      expect((await plywood(...deploy)).code).toBe(T.waiting);
      const devApproval = spawnSync(process.execPath, [join(was, "node_modules", ".bin", "chant"), "approve", "shop", RELEASE_GATE, "--env", "dev", "--approver", "bo", "--yes"], { cwd: dir, encoding: "utf8", env: process.env });
      expect(devApproval.status, devApproval.stderr).toBe(0);
      const dev = await plywood(...deploy);
      expect(dev.code, dev.text).toBe(0);
      expect(updated()).toEqual(["dev"]);

      const skip = await plywood("promote", "--to", "prod", "--from", "dev", "--release", "r1");
      expect(skip.code).toBe(T.failed);
      expect(skip.text).toContain("skips staging");
      expect(updated()).toEqual(["dev"]);

      await approved("staging", "promote", "--to", "staging", "--release", "r1");
      expect(updated()).toEqual(["dev", "staging"]);
      await approved("prod", "promote", "--to", "prod", "--release", "r1");
      expect(updated()).toEqual(["dev", "prod", "staging"]);
    } finally {
      process.chdir(was);
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
    }
  }, 480_000);
});
