import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setChantProductForTests, type ChantProduct, type ProductPipelineOptions } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { initLines, parseInitArgs, runInit, type InitIo, type InitOptions } from "../src/init";
import { bucketTarget, setBucketCheckForTests, type BucketReport } from "../src/init/backend";
import { detect, environmentOf, forgeOfRemote, stackNames } from "../src/init/detect";
import { jobBlocks, keepOwnJobs, OWN_JOBS_LINE } from "../src/init/own-jobs";
import { componentsFile, plywoodYml, wavesOf, wavesSpec, workspaceDeclaration } from "../src/init/render";
import { template } from "../src/templates";
import { PRODUCT_WORDS } from "../src/words";
import { setupPrompt } from "../../../site/src/prompts";

const GENERATED = [
  "name: plywood",
  "on:",
  "  pull_request: {}",
  "jobs:",
  "  plan:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npx --no-install plywood components pr-plan --gate up",
  "  post:",
  "    runs-on: ubuntu-latest",
  "    steps:",
  "      - run: npx --no-install plywood components pr-post",
  "",
].join("\n");

const GENERATED_GITLAB = [
  "stages: [plan]",
  "plan:",
  "  script:",
  "    - npx --no-install plywood components pr-plan --gate up",
  "",
].join("\n");

/** The repository the fake chant's relative paths resolve against, as process.cwd() does for the real one. */
let fakeRoot = "";

/**
 * A fake chant: its build writes GENERATED (or the GitLab file) to
 * --output, its op-waves generator writes one waves workflow naming the
 * spec, and its productWavesSpec and productPipelineJobs fill the names.
 */
function fakeChant(code = 0) {
  const calls: Array<{ argv: string[] }> = [];
  const pipelines: ProductPipelineOptions[] = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: (_forge, _env, options) => {
      pipelines.push(options);
      const words = options.words as typeof PRODUCT_WORDS;
      const spec = options.waves as Record<string, unknown> | undefined;
      return {
        words: { ...words, stages: { ...words.stages } },
        plan: { jobName: "plan", command: "npx --no-install plywood components pr-plan --gate up" },
        post: { command: "npx --no-install plywood components pr-post" },
        comments: {},
        ...(spec ? { waves: { spec, specFile: ".chant/op-waves/pulumi-up.spec.json", jobs: [{ command: ["npx", "--no-install", "plywood", "run", "wave"] }] } } : {}),
      };
    },
    approveLine: () => "",
    runChantInProcess: async (argv) => {
      calls.push({ argv });
      const out = argv.indexOf("--output");
      if (code === 0 && argv[0] === "run") {
        const spec = argv[argv.indexOf("--spec") + 1]!;
        const file = join(fakeRoot, argv[out + 1]!, "pulumi-up-waves.yml");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `# chant run --generate --spec ${spec}\njobs: {}\n`);
        return code;
      }
      if (code === 0 && out >= 0) {
        mkdirSync(dirname(argv[out + 1]!), { recursive: true });
        writeFileSync(argv[out + 1]!, argv.includes("gitlab") ? GENERATED_GITLAB : GENERATED);
      }
      return code;
    },
    productWavesSpec: (spec) => ({ ...spec, gateName: "wave-{k}", approvals: { ...((spec.approvals as object) ?? {}), pullRequest: { gate: "up" } } }),
  };
  return { api, calls, pipelines };
}

function io(cwd: string, env: NodeJS.ProcessEnv = {}): InitIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

const OPTS: InitOptions = { env: "production", bucketCheck: true, dryRun: false, yes: true };

function write(root: string, files: Record<string, string>): void {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

/** A repository with `remote` as origin and `files`. */
function repo(remote: string | undefined, files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plywood-init-"));
  mkdirSync(join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), remote ? `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${remote}\n` : "[core]\n");
  writeFileSync(join(root, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n");
  write(root, files);
  fakeRoot = root;
  return root;
}

/** One project with three stacks. */
const ONE_PROJECT = {
  "infra/Pulumi.yaml": "name: shop\nruntime: nodejs\n",
  "infra/Pulumi.dev.yaml": "config: {}\n",
  "infra/Pulumi.staging.yaml": "config: {}\n",
  "infra/Pulumi.prod.yaml": "config: {}\n",
};

/** Two projects, one with a stackConfigDir. */
const TWO_PROJECTS = {
  "network/Pulumi.yaml": "name: network\nruntime: go\n",
  "network/Pulumi.dev.yaml": "",
  "network/Pulumi.prod.yaml": "",
  "app/Pulumi.yaml": "name: app\nruntime: python\nstackConfigDir: stacks\n",
  "app/stacks/Pulumi.dev.yaml": "",
  "app/stacks/Pulumi.prod.yaml": "",
  "node_modules/dep/Pulumi.yaml": "name: ignored\nruntime: nodejs\n",
};

afterEach(() => {
  setChantProductForTests("reset");
  setBucketCheckForTests("reset");
});

describe("detection", () => {
  it("finds each Pulumi.yaml and its stacks, dev before staging before prod, and skips node_modules", () => {
    const root = repo("https://github.com/acme/shop.git", { ...ONE_PROJECT, ...TWO_PROJECTS });
    const d = detect(root);
    expect(d.projects.map((p) => [p.name, p.dir, p.stacks])).toEqual([
      ["app", "app", ["dev", "prod"]],
      ["shop", "infra", ["dev", "staging", "prod"]],
      ["network", "network", ["dev", "prod"]],
    ]);
    expect(d.stacks.map((s) => s.key)).toEqual(["app/dev", "network/dev", "shop/dev", "shop/staging", "app/prod", "network/prod", "shop/prod"]);
    expect(d.defaultBranch).toBe("main");
  });

  it("reads the forge from the origin remote", () => {
    expect(forgeOfRemote("git@github.com:acme/shop.git")?.kind).toBe("github");
    expect(forgeOfRemote("https://gitlab.com/acme/shop.git")).toEqual({ kind: "gitlab", because: "origin is on gitlab.com" });
    expect(forgeOfRemote("ssh://git@gitlab.acme.internal:2222/acme/shop.git")).toMatchObject({ kind: "gitlab", url: "https://gitlab.acme.internal" });
    expect(forgeOfRemote("https://codeberg.org/acme/shop.git")?.kind).toBe("forgejo");
    expect(forgeOfRemote("http://forgejo.localhost:3000/acme/shop.git")).toMatchObject({ kind: "forgejo", url: "https://forgejo.localhost" });
    expect(forgeOfRemote("https://git.example.com/acme/shop.git")).toBeUndefined();
  });

  it("names a stack's environment from its first segment", () => {
    expect(environmentOf("prod-east")).toBe("prod");
    expect(environmentOf("dev")).toBe("dev");
    expect(environmentOf("blue")).toBe("blue");
    const dir = mkdtempSync(join(tmpdir(), "plywood-stacks-"));
    write(dir, { "Pulumi.prod.yaml": "", "Pulumi.dev.yaml": "", "Pulumi.blue.yaml": "", "Pulumi.yaml": "" });
    expect(stackNames(dir)).toEqual(["dev", "blue", "prod"]);
  });

  it("names a pulumi/actions workflow and a pre-commit config", () => {
    const root = repo("git@github.com:acme/shop.git", {
      ...ONE_PROJECT,
      ".github/workflows/pulumi.yml": "jobs:\n  up:\n    steps:\n      - uses: pulumi/actions@v6\n",
      ".github/workflows/lint.yml": "jobs:\n  lint:\n    steps:\n      - run: npm run lint\n",
      ".pre-commit-config.yaml": "repos: []\n",
    });
    const d = detect(root);
    expect(d.pulumiActions).toEqual([".github/workflows/pulumi.yml"]);
    expect(d.preCommit).toBe(".pre-commit-config.yaml");
  });
});

describe("golden files", () => {
  it("one project with three stacks: an empty plywood.yml, a wave per environment, a component per stack", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const root = repo("git@github.com:acme/shop.git", ONE_PROJECT);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(r.ok).toBe(true);
    expect(r.waves).toEqual([
      { name: "dev", stacks: ["shop/dev"] },
      { name: "staging", stacks: ["shop/staging"] },
      { name: "prod", stacks: ["shop/prod"] },
    ]);
    expect(readFileSync(join(root, "plywood.yml"), "utf8")).toBe(plywoodYml({}));
    expect(checkConfig(parseConfig(readFileSync(join(root, "plywood.yml"), "utf8"))).filter((p) => p.severity === "error")).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, ".chant/op-waves/pulumi-up.spec.json"), "utf8"))).toEqual({
      name: "pulumi-up",
      op: "pulumi-up",
      gate: "up",
      gateName: "wave-{k}",
      branches: ["main"],
      step: { kind: "pulumi-up" },
      approvals: { pullRequest: { gate: "up" } },
      waves: [
        { name: "dev", gate: "on-destructive", runs: [{ target: "shop/dev", input: { dir: "infra", stack: "dev", member: "shop" } }] },
        { name: "staging", gate: "on-destructive", runs: [{ target: "shop/staging", input: { dir: "infra", stack: "staging", member: "shop" } }] },
        { name: "prod", gate: "on-destructive", runs: [{ target: "shop/prod", input: { dir: "infra", stack: "prod", member: "shop" } }] },
      ],
    });
    expect(JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8"))).toEqual({
      name: expect.any(String),
      schema: 1,
      members: [{ name: "shop", dir: "infra", kind: "pulumi" }],
      pins: [{ package: "@intentius/chant-lexicon-pulumi", version: "0.124.54" }],
      ci: { workflow: "trunk-curated+apply-on-merge", locks: "plan" },
    });
    const components = readFileSync(join(root, "plywood.component.ts"), "utf8");
    expect(components).toContain('export const shop_dev = {"name":"shop-dev","dependsOn":[],"deploy":[{"phase":"up","steps":[{"kind":"pulumi-up","dir":"infra","stack":"dev","member":"shop"}]}]};');
    expect(components.split("\n").filter((l) => l.startsWith("export const"))).toHaveLength(3);
    expect(readFileSync(join(root, "chant.config.ts"), "utf8")).toContain('lexicons: ["pulumi"]');
  });

  it("two projects: a member each, and their stacks share a wave per environment", async () => {
    setChantProductForTests(fakeChant().api);
    const root = repo("git@github.com:acme/estate.git", TWO_PROJECTS);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(r.waves).toEqual([
      { name: "dev", stacks: ["app/dev", "network/dev"] },
      { name: "prod", stacks: ["app/prod", "network/prod"] },
    ]);
    const decl = JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8"));
    expect(decl.members).toEqual([
      { name: "app", dir: "app", kind: "pulumi" },
      { name: "network", dir: "network", kind: "pulumi" },
    ]);
  });

  it("writes the pipeline for the forge origin names", async () => {
    for (const [remote, file, forge] of [
      ["git@github.com:acme/shop.git", ".github/workflows/plywood.yml", "github"],
      ["https://gitlab.com/acme/shop.git", ".gitlab-ci.yml", "gitlab"],
      ["https://codeberg.org/acme/shop.git", ".forgejo/workflows/plywood.yml", "forgejo"],
    ] as const) {
      const chant = fakeChant();
      setChantProductForTests(chant.api);
      const root = repo(remote, ONE_PROJECT);
      const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
      expect(r.forge.kind).toBe(forge);
      expect(r.files.find((f) => f.file === file)?.status).toBe("written");
      // The pipeline is chant's generator output, unchanged: plywood holds no job YAML.
      expect(readFileSync(join(root, file), "utf8")).toBe(forge === "gitlab" ? GENERATED_GITLAB : GENERATED);
      expect(chant.calls[0]!.argv.slice(0, 6)).toEqual(["build", root, "--components", "--generate", forge, "--pr-loop"]);
      expect(chant.calls[0]!.argv).toContain("--before-script");
      expect(chant.pipelines[0]!.waves).toMatchObject({ name: "pulumi-up" });
    }
  });

  it("writes the forge and a self-hosted URL only when the remote does not settle them", async () => {
    setChantProductForTests(fakeChant().api);
    const hosted = repo("ssh://git@gitlab.acme.internal/acme/shop.git", ONE_PROJECT);
    await runInit(OPTS, FALLBACK_EXIT, io(hosted));
    expect(readFileSync(join(hosted, "plywood.yml"), "utf8")).toContain("forge:\n  kind: gitlab\n  url: https://gitlab.acme.internal");
    const unknown = repo("https://git.example.com/acme/shop.git", ONE_PROJECT);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(unknown));
    expect(r.forge.kind).toBe("github");
    expect(readFileSync(join(unknown, "plywood.yml"), "utf8")).toContain("forge:\n  kind: github");
  });

  it("writes a preset's keys, the gate flag and a backend only the environment names", async () => {
    setChantProductForTests(fakeChant().api);
    const root = repo("git@github.com:acme/shop.git", ONE_PROJECT);
    await runInit({ ...OPTS, preset: "before-merge", gate: "always", bucketCheck: false }, FALLBACK_EXIT, io(root, { PULUMI_BACKEND_URL: "file:///tmp/state" }));
    const yml = readFileSync(join(root, "plywood.yml"), "utf8");
    expect(yml).toContain("apply:\n  when: pull-request");
    expect(yml).toContain("gate: always");
    expect(yml).toContain("backend: file:///tmp/state");
    const spec = JSON.parse(readFileSync(join(root, ".chant/op-waves/pulumi-up.spec.json"), "utf8"));
    expect(spec.waves.every((w: { gate: string }) => w.gate === "always")).toBe(true);
  });
});

describe("a second run", () => {
  it("is a no-op and keeps the team's own job", async () => {
    setChantProductForTests(fakeChant().api);
    const root = repo("git@github.com:acme/shop.git", ONE_PROJECT);
    await runInit(OPTS, FALLBACK_EXIT, io(root));
    const wf = join(root, ".github/workflows/plywood.yml");
    const own = "  smoke:\n    runs-on: ubuntu-latest\n    # our own check\n    steps:\n      - run: ./scripts/smoke.sh\n";
    writeFileSync(wf, readFileSync(wf, "utf8") + own);
    const before = Object.fromEntries(["plywood.yml", "chant.workspace.json", "plywood.component.ts", ".chant/op-waves/pulumi-up.spec.json"].map((f) => [f, readFileSync(join(root, f), "utf8")]));

    const r = await runInit({ ...OPTS, gate: "never" }, FALLBACK_EXIT, io(root));
    for (const [f, text] of Object.entries(before)) expect(readFileSync(join(root, f), "utf8")).toBe(text);
    expect(r.files.find((f) => f.file === "plywood.yml")?.status).toBe("kept");
    // Only the workflow changes: the own job moves under the line that says it is kept.
    expect(r.files.filter((f) => f.status === "written").map((f) => f.file)).toEqual([".github/workflows/plywood.yml"]);
    const after = readFileSync(wf, "utf8");
    expect(after).toContain(OWN_JOBS_LINE);
    expect(after).toContain("# our own check\n    steps:\n      - run: ./scripts/smoke.sh");
    expect(jobBlocks(after, "github").has("smoke")).toBe(true);
    expect(r.notes.join("\n")).toContain("--gate changed nothing");

    // A third run changes nothing at all.
    const third = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(third.files.filter((f) => f.status === "written")).toEqual([]);
    expect(readFileSync(wf, "utf8")).toBe(after);
  });

  it("merges into a workspace declaration that is already there, keeping its keys", () => {
    const doc = workspaceDeclaration(
      { name: "estate", schema: 1, members: [{ name: "web", dir: "web", kind: "chant" }], ci: { reportUrl: "s3://reports" }, "x-team": "infra" },
      { name: "ignored", projects: [{ name: "shop", dir: "infra", stacks: ["dev"] }], ci: { workflow: "apply-before-merge" }, lexiconVersion: "0.124.54" },
    );
    expect(doc).toEqual({
      name: "estate",
      schema: 1,
      members: [{ name: "web", dir: "web", kind: "chant" }, { name: "shop", dir: "infra", kind: "pulumi" }],
      ci: { reportUrl: "s3://reports", workflow: "apply-before-merge" },
      "x-team": "infra",
      pins: [{ package: "@intentius/chant-lexicon-pulumi", version: "0.124.54" }],
    });
  });

  it("puts the old workflow back when chant's generator fails", async () => {
    setChantProductForTests(fakeChant(1).api);
    const root = repo("git@github.com:acme/shop.git", { ...ONE_PROJECT, ".github/workflows/plywood.yml": "old: true\n" });
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(r.ok).toBe(false);
    expect(r.exitCode).toBe(1);
    expect(readFileSync(join(root, ".github/workflows/plywood.yml"), "utf8")).toBe("old: true\n");
  });
});

describe("own jobs", () => {
  it("keeps a GitLab job and drops a plywood one the new file no longer has", () => {
    const previous = [
      "stages: [plan, test]",
      "plan:",
      "  script:",
      "    - npx --no-install plywood components pr-plan",
      "old-plywood-job:",
      "  script:",
      "    - npx --no-install plywood ci run plan",
      "unit-tests:",
      "  stage: test",
      "  script:",
      "    - npm test",
      "",
    ].join("\n");
    const { text, kept } = keepOwnJobs(previous, GENERATED_GITLAB, "gitlab");
    expect(kept).toEqual(["unit-tests"]);
    expect(text).toBe(`${GENERATED_GITLAB}${OWN_JOBS_LINE}\nunit-tests:\n  stage: test\n  script:\n    - npm test\n`);
  });

  it("puts GitHub jobs back inside jobs:, before a later top-level key", () => {
    const generated = "jobs:\n  plan:\n    steps: []\nconcurrency: x\n";
    const { text } = keepOwnJobs("jobs:\n  mine:\n    steps: []\n", generated, "github");
    expect(text).toBe(`jobs:\n  plan:\n    steps: []\n  ${OWN_JOBS_LINE}\n  mine:\n    steps: []\nconcurrency: x\n`);
  });
});

describe("the bucket check", () => {
  const report: BucketReport = {
    store: "s3",
    bucket: "state",
    namespaces: ["shop/.pulumi"],
    correct: false,
    settings: [
      { setting: "versioning", verdict: "ok", found: "versioning is Enabled", unwaivable: false },
      { setting: "lifecycle", verdict: "fail", found: "no rule expires noncurrent versions", unwaivable: false, fix: "aws s3api put-bucket-lifecycle-configuration --bucket state ..." },
      { setting: "public_access_block", verdict: "ok", found: "all four blocks are on", unwaivable: false },
    ],
  };

  it("takes floci's S3 from the backend URL and the emulator's keys from the environment", () => {
    const env = { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" };
    expect(bucketTarget("s3://state/shop?region=us-east-1&endpoint=localhost:4566&disableSSL=true&s3ForcePathStyle=true", env)).toEqual({
      ok: true,
      label: "s3://state/shop?region=us-east-1&endpoint=localhost:4566&disableSSL=true&s3ForcePathStyle=true",
      namespaces: ["shop/.pulumi"],
      target: { store: "s3", bucket: "state", region: "us-east-1", endpoint: "http://localhost:4566", credentials: { accessKeyId: "test", secretAccessKey: "test" } },
    });
    expect(bucketTarget("plunge+s3://state", env)).toMatchObject({ ok: true, namespaces: [".pulumi"] });
    expect(bucketTarget("s3://state?endpoint=http://localhost:4566", {})).toMatchObject({ ok: false });
    expect(bucketTarget("gs://state/p", { STORAGE_EMULATOR_HOST: "localhost:4443" })).toMatchObject({ ok: true, target: { store: "gcs", endpoint: "http://localhost:4443", token: null } });
    expect(bucketTarget("azblob://state", {})).toMatchObject({ ok: false });
    expect(bucketTarget("file:///tmp/state", {})).toBeUndefined();
  });

  it("prints the fix for a bucket with no noncurrent-version rule", async () => {
    setChantProductForTests(fakeChant().api);
    const asked: Array<{ target: Record<string, unknown>; namespaces?: readonly string[] }> = [];
    setBucketCheckForTests({ checkBucket: async (target, o) => (asked.push({ target, namespaces: o?.namespaces }), report) });
    const root = repo("git@github.com:acme/shop.git", {
      ...ONE_PROJECT,
      "infra/Pulumi.yaml": "name: shop\nruntime: nodejs\nbackend:\n  url: s3://state/shop?region=us-east-1&endpoint=http://localhost:4566\n",
    });
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root, { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" }));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.target).toMatchObject({ store: "s3", bucket: "state", endpoint: "http://localhost:4566" });
    const text = initLines(r).join("\n");
    expect(text).toContain("lifecycle: no rule expires noncurrent versions");
    expect(text).toContain("aws s3api put-bucket-lifecycle-configuration --bucket state");
    expect(r.ok).toBe(true);
  });

  it("says the bucket was not checked on a chant without the check", async () => {
    setChantProductForTests(fakeChant().api);
    setBucketCheckForTests(undefined);
    const root = repo("git@github.com:acme/shop.git", ONE_PROJECT);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root, { PULUMI_BACKEND_URL: "s3://state" }));
    expect(r.notes.join("\n")).toContain("@intentius/chant/bucket-check (chant#4558)");
  });
});

describe("on a chant without the product pipeline", () => {
  it("writes the config files and says the spec and workflow need a newer chant", async () => {
    setChantProductForTests(undefined);
    const root = repo("git@github.com:acme/shop.git", ONE_PROJECT);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(r.ok).toBe(true);
    expect(r.files.find((f) => f.file === ".chant/op-waves/pulumi-up.spec.json")).toMatchObject({ status: "skipped" });
    expect(r.files.find((f) => f.file === ".github/workflows/plywood.yml")).toMatchObject({ status: "skipped" });
    expect(r.files.find((f) => f.file === "plywood.yml")).toMatchObject({ status: "written" });
  });
});

describe("flags, templates and pure parts", () => {
  it("parses init's flags", () => {
    expect(parseInitArgs(["--gate", "destroy", "--engine", "plunge"])).toMatchObject({ gate: "on-destructive", engine: "plunge", bucketCheck: true });
    expect(parseInitArgs(["--preset", "nope"])).toEqual({ error: expect.stringContaining("not one of merge, before-merge, approve-all") });
    expect(parseInitArgs(["--from", "x.yml"])).toEqual({ error: expect.stringContaining("not built yet") });
    expect(parseInitArgs(["--print-prompt"])).toEqual({ printPrompt: true });
    expect(parseInitArgs(["--no-bucket-check", "--dry-run"])).toMatchObject({ bucketCheck: false, dryRun: true });
  });

  it("writes nothing with --dry-run", async () => {
    setChantProductForTests(fakeChant().api);
    const root = repo("git@github.com:acme/shop.git", ONE_PROJECT);
    const r = await runInit({ ...OPTS, dryRun: true }, FALLBACK_EXIT, io(root));
    expect(r.files.find((f) => f.file === "plywood.yml")?.status).toBe("written");
    expect(() => readFileSync(join(root, "plywood.yml"))).toThrow();
  });

  it("refuses a repository with no Pulumi program", async () => {
    const r = await runInit(OPTS, FALLBACK_EXIT, io(repo(undefined, { "README.md": "" })));
    expect(r).toMatchObject({ ok: false, exitCode: 1 });
  });

  it("the agent prompt template is the site's setup prompt, word for word", () => {
    expect(template("agent-prompt.md").trimEnd()).toBe(setupPrompt);
  });

  it("plywood.yml from keys checks clean", () => {
    const text = plywoodYml({ gate: "always", forge: { kind: "gitlab", url: "https://gitlab.acme.internal" } });
    expect(checkConfig(parseConfig(text)).filter((p) => p.severity === "error")).toEqual([]);
  });

  it("waves follow plywood.yml when it lists them, and a wave's gate is its strictest stack's", () => {
    const stacks = [
      { key: "a/dev", project: "a", stack: "dev", dir: "a" },
      { key: "a/prod", project: "a", stack: "prod", dir: "a", gate: "always" as const },
      { key: "b/prod", project: "b", stack: "prod", dir: "b" },
    ];
    expect(wavesOf(stacks, [["a/prod"], ["a/dev", "b/prod"]]).map((w) => [w.name, w.stacks.map((s) => s.key)])).toEqual([
      ["wave-1", ["a/prod"]],
      ["wave-2", ["a/dev", "b/prod"]],
    ]);
    const spec = wavesSpec({ stacks, gate: "never", branch: "trunk", runner: "self-hosted" });
    expect(spec).toMatchObject({ branches: ["trunk"], runner: "self-hosted", waves: [{ name: "dev", gate: "never" }, { name: "prod", gate: "always" }] });
    expect(componentsFile(stacks)).toContain("export const a_prod = ");
  });
});
