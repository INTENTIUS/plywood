/**
 * plywood#124: plywood.yml `evidence` switches on chant's signed checks
 * (chant#4867 to #4870). The key becomes chant's `evidence` option on the
 * productPipelineJobs call and in the waves spec's options, and `plywood
 * init` writes `.chant/trust.json` from it. Without the key nothing changes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chantProduct, setChantProductForTests, type ChantProduct, type ProductPipelineOptions } from "../src/chant-product";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { evidenceOf } from "../src/config/evidence";
import { EXIT } from "../src/exit-codes";
import { runInit, type InitOptions } from "../src/init";
import { repoName, repositoryOfRemote } from "../src/init/detect";
import { refGateChecks, TRUST_FILE, trustText } from "../src/init/trust";
import { workflowPlan } from "../src/stages";
import { wavesEngine, wavesSpecText } from "../src/waves-workflow";
import { CHANT_DEFAULTS } from "./chant-defaults";
import { PRODUCT_WORDS } from "../src/words";

afterEach(() => setChantProductForTests("reset"));

const errors = (yml: string) => checkConfig(parseConfig(yml)).filter((p) => p.severity === "error");

describe("plywood.yml evidence: the config", () => {
  it("translates identity oidc, its audience and runner_key_secret into chant's evidence option", () => {
    expect(toChantSettings(parseConfig("evidence: { identity: oidc }\n")).pipeline.evidence).toEqual({ identity: "oidc" });
    expect(toChantSettings(parseConfig("evidence: { identity: oidc, audience: sigstore }\n")).pipeline.evidence).toEqual({ identity: "oidc", audience: "sigstore" });
    expect(toChantSettings(parseConfig("evidence: { runner_key_secret: CHANT_RUNNER_KEY_PEM }\n")).pipeline.evidence).toEqual({ runnerKeySecret: "CHANT_RUNNER_KEY_PEM" });
    expect(evidenceOf(parseConfig("evidence: { identity: oidc, local: true }\n").doc)).toEqual({ chant: { identity: "oidc" }, local: true });
  });

  it("without the key there is no evidence setting", () => {
    expect("evidence" in toChantSettings(parseConfig("gate: always\n")).pipeline).toBe(false);
    expect(evidenceOf(parseConfig("gate: always\n").doc)).toBeUndefined();
  });

  it("refuses both identities, neither, another identity, a bad secret name, an audience without oidc and an unknown key", () => {
    expect(errors("evidence: { identity: oidc }\n")).toEqual([]);
    expect(errors("evidence: { identity: oidc, runner_key_secret: K }\n").map((p) => p.key)).toEqual(["evidence"]);
    expect(errors("evidence: { local: true }\n").map((p) => p.message)).toEqual([expect.stringContaining("neither identity nor runner_key_secret")]);
    expect(errors("evidence: { identity: github }\n").map((p) => p.key)).toEqual(["evidence.identity"]);
    expect(errors("evidence: { runner_key_secret: \"1 bad\" }\n").map((p) => p.key)).toEqual(["evidence.runner_key_secret"]);
    expect(errors("evidence: { runner_key_secret: K, audience: sigstore }\n").map((p) => p.key)).toEqual(["evidence.audience"]);
    expect(errors("evidence: { identity: oidc, local: yes please }\n").map((p) => p.key)).toEqual(["evidence.local"]);
    expect(errors("evidence: { identity: oidc, sign: all }\n").map((p) => p.key)).toEqual(["evidence.sign"]);
    expect(errors("evidence: oidc\n").map((p) => p.key)).toEqual(["evidence"]);
  });

  it("the waves spec's options carry the runner identity, and a spec without the key is the bare spec as before", () => {
    const spec = { name: "pulumi-up", waves: [] };
    expect(wavesSpecText(spec, {})).toBe(JSON.stringify(spec, null, 2) + "\n");
    expect(wavesSpecText(spec, wavesEngine({}))).toBe(JSON.stringify(spec, null, 2) + "\n");
    expect(JSON.parse(wavesSpecText(spec, wavesEngine({ evidence: { identity: "oidc" } })))).toEqual({ waves: spec, options: { evidence: { identity: "oidc" } } });
    // With the engine install lines plywood hands chant, the key adds evidence beside them and changes nothing else.
    const plain = JSON.parse(wavesSpecText(spec, wavesEngine(toChantSettings(parseConfig("gate: always\n")).pipeline)));
    const keyed = JSON.parse(wavesSpecText(spec, wavesEngine(toChantSettings(parseConfig("gate: always\nevidence: { identity: oidc }\n")).pipeline)));
    expect(keyed).toEqual({ ...plain, waves: spec, options: { ...(plain.options ?? {}), evidence: { identity: "oidc" } } });
  });

  it("the productPipelineJobs call gets the evidence option only with the key", () => {
    const seen: ProductPipelineOptions[] = [];
    const chant = {
      ...CHANT_DEFAULTS,
      assertProductWords: (w: unknown) => w,
      productPipelineJobs: (_f: string, _e: string, options: ProductPipelineOptions) => {
        seen.push(options);
        return { words: { ...PRODUCT_WORDS, prGate: "up" }, plan: { jobName: "plan", command: "plan" }, post: { command: "post" }, comments: {} };
      },
    } as unknown as ChantProduct;
    workflowPlan(chant, parseConfig("gate: always\n").doc, "github", "production", undefined);
    workflowPlan(chant, parseConfig("evidence: { runner_key_secret: RUNNER_PEM }\n").doc, "github", "production", undefined);
    expect("evidence" in seen[0]!).toBe(false);
    expect("checkJob" in seen[0]! || "refGateStatus" in seen[0]!).toBe(false);
    expect(seen[1]!).toMatchObject({ evidence: { runnerKeySecret: "RUNNER_PEM" }, checkJob: true, refGateStatus: true });
  });

  it("chant build --pr-loop gets the runner identity, the check job and the ref gate's status job only with the key (chant#4964)", () => {
    const argv = (yml: string) => workflowPlan(fakeChant(() => tmpdir()), parseConfig(yml).doc, "github", "production", undefined).argv;
    const plain = argv("gate: always\n");
    for (const flag of ["--check-job", "--ref-gate-status", "--evidence-identity", "--evidence-runner-key-secret"]) expect(plain).not.toContain(flag);
    expect(argv("evidence: { runner_key_secret: RUNNER_PEM }\n").slice(plain.length)).toEqual(["--evidence-runner-key-secret", "RUNNER_PEM", "--check-job", "--ref-gate-status"]);
    expect(argv("evidence: { identity: oidc, audience: chant }\n").slice(plain.length)).toEqual(["--evidence-identity", "oidc", "--evidence-audience", "chant", "--check-job", "--ref-gate-status"]);
  });

  it("the ref gate's rule names the check hooks, plan and policy, and no hook that takes local evidence", () => {
    expect(refGateChecks(["pre-commit"], false).map((c) => c.check)).toEqual(["pre-commit", "plan", "policy"]);
    expect(refGateChecks(["pre-commit"], true).map((c) => c.check)).toEqual(["plan", "policy"]);
    // A workspace member's pull request pipeline signs plan and policy under its name (chant#4964).
    expect(refGateChecks(["pre-commit"], false, "shop").map((c) => c.check)).toEqual(["pre-commit", "plan:shop", "policy:shop"]);
  });
});

describe("plywood init's .chant/trust.json", () => {
  it("reads the repository path from the origin remote", () => {
    expect(repositoryOfRemote("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(repositoryOfRemote("https://gitlab.acme.internal/infra/team/shop.git")).toBe("infra/team/shop");
    expect(repositoryOfRemote("ssh://git@codeberg.org:22/acme/shop")).toBe("acme/shop");
    expect(repositoryOfRemote("/srv/git/shop.git")).toBeUndefined();
  });

  it("on GitLab the identity is the CI config on the default branch of a self-hosted server", () => {
    const { text } = trustText(undefined, { forge: "gitlab", repository: "infra/shop", server: "https://gitlab.acme.internal", branch: "main", evidence: { chant: { identity: "oidc" }, local: false }, hooks: [] });
    const t = JSON.parse(text);
    expect(t.keyless.identities).toEqual([{ principal: "ci", class: "runner", issuer: "https://gitlab.acme.internal", subject: "https://gitlab.acme.internal/infra/shop//.gitlab-ci.yml@refs/heads/main" }]);
    // The ref gate's rule is chant's (refGateInitPlan, chant#4913).
    expect(t.refs).toBeUndefined();
  });

  it("keeps what a file already there says: its identities, its local checks and its rule for the branch", () => {
    const existing = JSON.stringify({ schema: 1, local: { checks: [{ check: "lint", from: ["agent"] }] }, refs: [{ ref: "refs/heads/main", checks: [{ check: "lint", command: "npm run lint" }] }] });
    const once = trustText(existing, { forge: "github", repository: "acme/shop", branch: "main", evidence: { chant: { identity: "oidc" }, local: true }, hooks: ["pre-commit", "lint"] }).text;
    const t = JSON.parse(once);
    expect(t.local.checks).toEqual([{ check: "lint", from: ["agent"] }, { check: "pre-commit" }]);
    expect(t.refs).toEqual([{ ref: "refs/heads/main", checks: [{ check: "lint", command: "npm run lint" }] }]);
    // Run again: the same file.
    expect(trustText(once, { forge: "github", repository: "acme/shop", branch: "main", evidence: { chant: { identity: "oidc" }, local: true }, hooks: ["pre-commit", "lint"] }).text).toBe(once);
  });
});

/** A fake chant whose generators write a file, so init runs every step without the real build. */
function fakeChant(root: () => string): ChantProduct {
  return {
    ...CHANT_DEFAULTS,
    assertProductWords: (w) => w as never,
    productPipelineJobs: (_forge, _env, options) => {
      const spec = options.waves as Record<string, unknown> | undefined;
      return {
        words: { ...(options.words as typeof PRODUCT_WORDS), prGate: "up" },
        plan: { jobName: "plan", command: "plan" },
        post: { command: "post" },
        comments: {},
        ...(spec ? { waves: { spec, specFile: ".chant/op-waves/pulumi-up.spec.json", jobs: [{ command: ["plywood", "run", "wave"] }] } } : {}),
      } as never;
    },
    approveLine: () => "",
    productWavesSpec: (spec) => ({ ...spec, gateName: "wave-{k}" }),
    runChantInProcess: async (argv) => {
      const out = argv[argv.indexOf("--output") + 1]!;
      const file = argv[0] === "run" ? join(root(), out, "pulumi-up.yml") : out;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, argv[0] === "run" ? `# chant run --generate --spec ${argv[argv.indexOf("--spec") + 1]}\njobs: {}\n` : "jobs: {}\n");
      return 0;
    },
  } as ChantProduct;
}

/** A git repository with one project of two stacks, `origin` and `files`: chant's ref gate init needs a real checkout. */
function repo(origin: string, files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-evidence-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", origin], { cwd: dir });
  mkdirSync(join(dir, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(dir, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n");
  const all = { "Pulumi.yaml": "name: shop\nruntime: nodejs\n", "Pulumi.dev.yaml": "config: {}\n", "Pulumi.prod.yaml": "config: {}\n", "package.json": '{"name":"shop","private":true}\n', ...files };
  for (const [rel, text] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), text);
  }
  return dir;
}

const OPTS: InitOptions = { env: "production", bucketCheck: false, dryRun: false, yes: true };
const PRE_COMMIT = { ".pre-commit-config.yaml": "repos: []\n" };

async function initIn(dir: string, opts: Partial<InitOptions> = {}) {
  setChantProductForTests(fakeChant(() => dir));
  const r = await runInit({ ...OPTS, ...opts }, EXIT, { cwd: dir, env: {}, out: () => {}, err: () => {} });
  expect(r.ok, JSON.stringify([r.notes, r.files])).toBe(true);
  return r;
}

describe("plywood init with plywood.yml evidence", () => {
  it("identity oidc on GitHub: the waves workflow's identity, no local checks, and chant's ref rule naming the hooks, plan and policy, with its pre-push hook", async () => {
    const dir = repo("git@github.com:acme/shop.git", { ...PRE_COMMIT, "plywood.yml": "evidence:\n  identity: oidc\n" });
    const r = await initIn(dir);
    expect(r.files.find((f) => f.file === TRUST_FILE)?.status).toBe("written");
    const t = JSON.parse(readFileSync(join(dir, TRUST_FILE), "utf8"));
    expect(t).toEqual({
      schema: 1,
      roles: { runner: ["ci"] },
      keyless: {
        trustedRoot: ".chant/trusted_root.json",
        identities: [{ principal: "ci", class: "runner", issuer: "https://token.actions.githubusercontent.com", subject: "https://github.com/acme/shop/.github/workflows/pulumi-up.yml@refs/heads/main" }],
      },
      refs: [
        {
          ref: "refs/heads/main",
          checks: [
            { check: "pre-commit", command: "plywood check" },
            { check: "plan:shop", command: "/plywood preview on the pull request" },
            { check: "policy:shop", command: "/plywood preview on the pull request" },
          ],
        },
      ],
    });
    // chant's pre-push hook, executable, in this clone's hooks directory, running chant through npx.
    const hook = join(realpathSync(dir), ".git", "hooks", "pre-push");
    expect(r.files.find((f) => f.file === hook)).toMatchObject({ status: "written" });
    expect(statSync(hook).mode & 0o111).not.toBe(0);
    expect(readFileSync(hook, "utf8")).toContain("npx chant workspace ref-gate");
    expect(r.todo.some((t) => t.includes("trusted_root.json"))).toBe(true);
    // A keyless identity is listed, so chant gives no runner key hint.
    expect(r.todo.some((t) => t.includes("no runner key or keyless identity"))).toBe(false);
    // The ref gate's status decides the update, so it is the required one.
    expect(r.todo).toContain("Make chant/ref-gate a required status on main");
    expect(r.todo).not.toContain("Make plywood/preview a required status on main");
    // Run again: nothing changes.
    const again = await initIn(dir);
    expect(again.files.find((f) => f.file === TRUST_FILE)?.status).toBe("unchanged");
    expect(again.files.find((f) => f.file === hook)?.status).toBe("unchanged");
  });

  it("--dry-run plans chant's pieces and writes none of them", async () => {
    const dir = repo("git@github.com:acme/shop.git", { ...PRE_COMMIT, "plywood.yml": "evidence:\n  identity: oidc\n" });
    const r = await initIn(dir, { dryRun: true });
    expect(r.files.find((f) => f.file === join(realpathSync(dir), ".git", "hooks", "pre-push"))).toMatchObject({ status: "written" });
    expect(existsSync(join(dir, ".git", "hooks", "pre-push"))).toBe(false);
    expect(existsSync(join(dir, TRUST_FILE))).toBe(false);
  });

  it("local: true names the check hooks under local.checks and leaves them out of the ref rule", async () => {
    const dir = repo("git@github.com:acme/shop.git", { ...PRE_COMMIT, "plywood.yml": "evidence: { identity: oidc, local: true }\n" });
    await initIn(dir);
    const t = JSON.parse(readFileSync(join(dir, TRUST_FILE), "utf8"));
    expect(t.local).toEqual({ checks: [{ check: "pre-commit" }] });
    expect(t.refs[0].checks.map((c: { check: string }) => c.check)).toEqual(["plan:shop", "policy:shop"]);
  });

  it("runner_key_secret writes no identity and says where the key goes", async () => {
    const dir = repo("git@github.com:acme/shop.git", { "plywood.yml": "evidence: { runner_key_secret: CHANT_RUNNER_KEY_PEM }\n" });
    const r = await initIn(dir);
    const t = JSON.parse(readFileSync(join(dir, TRUST_FILE), "utf8"));
    expect(t.keyless).toBeUndefined();
    expect(t.refs[0].checks.map((c: { check: string }) => c.check)).toEqual(["plan:shop", "policy:shop"]);
    expect(r.todo.some((l) => l.includes("CHANT_RUNNER_KEY_PEM secret"))).toBe(true);
  });

  it("on Forgejo, identity oidc leaves the identity to the person, since the authority is theirs", async () => {
    const dir = repo("https://codeberg.org/acme/shop.git", { "plywood.yml": "evidence: { identity: oidc }\n" });
    const r = await initIn(dir);
    const t = JSON.parse(readFileSync(join(dir, TRUST_FILE), "utf8"));
    expect(t.keyless).toBeUndefined();
    expect(r.todo.some((l) => l.includes("Forgejo job's certificate"))).toBe(true);
  });

  it("without the key init writes no trust file and prints no ref gate line", async () => {
    const dir = repo("git@github.com:acme/shop.git", PRE_COMMIT);
    const r = await initIn(dir);
    expect(existsSync(join(dir, TRUST_FILE))).toBe(false);
    expect(r.files.some((f) => f.file === TRUST_FILE)).toBe(false);
    expect(r.todo.some((l) => l.includes("ref-gate"))).toBe(false);
    expect(r.todo).toContain("Make plywood/preview a required status on main");
  });
});

const real = await chantProduct();

/** `plywood init --forge` against the installed chant; the text of every file it wrote. */
async function generated(forge: "github" | "forgejo" | "gitlab", yml: string | undefined): Promise<Record<string, string>> {
  setChantProductForTests("reset");
  const origin = forge === "github" ? "git@github.com:acme/shop.git" : forge === "gitlab" ? "git@gitlab.com:acme/shop.git" : "https://codeberg.org/acme/shop.git";
  const dir = repo(origin, yml === undefined ? {} : { "plywood.yml": yml });
  const was = process.cwd();
  process.chdir(dir);
  const r = await runInit({ ...OPTS, forge }, EXIT, { cwd: dir, env: {}, out: () => {}, err: () => {} }).finally(() => process.chdir(was));
  expect(r.ok, JSON.stringify([r.notes, r.files])).toBe(true);
  const out: Record<string, string> = {};
  const walk = (rel: string): void => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.name === ".git" || e.name === "node_modules") continue;
      if (e.isDirectory()) walk(p);
      // The header's regenerate line names the temporary directory, which differs from run to run.
      else out[p] = readFileSync(join(dir, p), "utf8").split(basename(dir)).join("<repo>").split(repoName(dir)).join("<repo>");
    }
  };
  walk("");
  return out;
}

/** The waves workflow files chant writes for the spec. */
const WAVES_FILE = /pulumi-up(\.gitlab-ci)?\.ya?ml$/;
/** The pull request workflow, by forge. */
const PR_FILE = { github: ".github/workflows/plywood.yml", gitlab: ".gitlab-ci.yml", forgejo: ".forgejo/workflows/plywood.yml" } as const;
/** The files the key may change: plywood.yml itself, the waves spec, the waves workflows, the pull request workflow, chant's record of the files it generated, and the trust file. */
const KEYED = (f: string) => f === "plywood.yml" || f === TRUST_FILE || f === ".chant/generated.json" || f.startsWith(".chant/op-waves/") || WAVES_FILE.test(f) || (Object.values(PR_FILE) as string[]).includes(f);

describe.runIf(real !== undefined)("the pipelines chant generates with plywood.yml evidence", () => {
  const cases = [
    ["github", "CHANT_RUNNER_IDENTITY: oidc", /^\s+id-token: write$/m],
    ["gitlab", "CHANT_RUNNER_IDENTITY: oidc", /CHANT_ID_TOKEN_SIGSTORE:/],
    ["forgejo", "CHANT_RUNNER_IDENTITY: oidc", /enable-openid-connect: true/],
  ] as const;
  for (const [forge, env, token] of cases) {
    it(`on ${forge}: each deciding wave job signs keyless, and every other file is as without the key`, async () => {
      const plain = await generated(forge, "gate: on-destructive\n");
      const keyed = await generated(forge, "gate: on-destructive\nevidence:\n  identity: oidc\n");
      const waves = Object.entries(keyed).filter(([f]) => WAVES_FILE.test(f));
      expect(waves.length, Object.keys(keyed).join(", ")).toBeGreaterThan(0);
      for (const [f, text] of waves) {
        expect(text, f).toContain(env);
        expect(text, f).toMatch(token);
        expect(plain[f], f).not.toContain("CHANT_RUNNER_IDENTITY");
      }
      expect(JSON.parse(keyed[".chant/op-waves/pulumi-up.spec.json"]!).options.evidence).toEqual({ identity: "oidc" });
      // chant#4964: the pull request workflow signs plan:shop and policy:shop, runs the check job and sets the ref gate's status.
      const pr = keyed[PR_FILE[forge]]!;
      expect(pr, PR_FILE[forge]).toContain("ci evidence sign");
      expect(pr).toContain("--member shop");
      expect(pr).toContain("ci check");
      expect(pr).toContain("workspace ref-gate status");
      expect(plain[PR_FILE[forge]]).not.toContain("workspace ref-gate status");
      expect(plain[PR_FILE[forge]]).not.toContain("ci evidence sign");
      expect(Object.keys(keyed).filter((f) => !KEYED(f)).sort()).toEqual(Object.keys(plain).filter((f) => !KEYED(f)).sort());
      for (const f of Object.keys(plain).filter((f) => !KEYED(f))) expect(keyed[f], f).toBe(plain[f]);
    }, 120_000);
  }

  it("on github with runner_key_secret: the wave jobs read the runner key from the secret", async () => {
    const keyed = await generated("github", "evidence:\n  runner_key_secret: CHANT_RUNNER_KEY_PEM\n");
    const text = keyed[".github/workflows/pulumi-up.yml"]!;
    expect(text).toContain("CHANT_RUNNER_KEY:");
    expect(text).toContain("secrets.CHANT_RUNNER_KEY_PEM");
    expect(text).not.toContain("CHANT_RUNNER_IDENTITY");
  }, 120_000);
});
