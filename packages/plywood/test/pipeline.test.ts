/**
 * The stage pipeline (plywood#156): the stage keys under
 * `environments.<name>` and their top-level companions, checked in
 * plywood.yml and handed to chant's `pipelineFromConfig` as written; each
 * stage's waves over its environment's stacks; `.chant/pipeline.ts` through
 * chant's `pipelineSource` and `checkPipelineFile`; approval rule groups and
 * `proven`; `agent.verify-failed`; and the stage commands' argv.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { toChantSettings } from "../src/chant-config";
import { agentOf } from "../src/config/agents";
import { quorumOf } from "../src/config/approval";
import { checkConfig, parseConfig, plywoodSchema } from "../src/config/index";
import { environmentsOf } from "../src/config/jobs";
import { isStageEntry } from "../src/config/promotion";
import { ciRiskOf, environmentSetsOf } from "../src/config/stage";
import { EXIT } from "../src/exit-codes";
import { canaryWhereItHolds, chantEnvironment, pipelineFile, pipelineInput, stagesByEnv, stageWaves, withCanaryWave, type SpecWave } from "../src/pipeline";
import { pipelineGenerateOptions } from "../src/pipeline-jobs";
import { stageCommand } from "../src/stage-commands";
import { publishedImage } from "./published-image";
import { promoteRelease } from "../src/stack-ops";
import { check, type StageIo } from "../src/stages";
import { execFileSync } from "node:child_process";
import { wavesApprovalOf } from "../src/config/approval";
import { runInit } from "../src/init";
import { factTriggersOn, triggerSpec, TRIGGER_OPS, verifyFailedFacts } from "../src/agent-triggers";
import { PRODUCT_WORDS } from "../src/words";

afterEach(() => setChantProductForTests("reset"));

function io(cwd: string): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env: {}, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

const errors = (yml: string): string[] =>
  checkConfig(parseConfig(yml)).filter((p) => p.severity === "error").map((p) => `${p.key} ${p.message}`);

const STACKS = "stacks:\n  shop/dev: { dir: . }\n  shop/staging: { dir: . }\n  shop/prod: { dir: ., gate: always }\n";
const PROMOTION = `${STACKS}promotion: [dev, staging, prod]\n`;

const STAGED = `${PROMOTION}waves:
  canary: [shop/dev]
risk:
  approve_above: 0.6
  questions:
    - { id: blast, text: How many users does it reach?, weight: 0.5 }
replan_dependents: [shop/dev]
release: { cut: true, label: auto }
recheck: { schedule: "*/15 * * * *" }
config_sets:
  common:
    config: { LOG_LEVEL: info }
    secrets: { SENTRY_DSN: SENTRY_DSN }
environments:
  dev: { targets: { shop: dev } }
  staging:
    imports: [common]
    config: { REGION: us-east-2 }
    secrets:
      API_KEY: { aws_secrets_manager: "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/api", json_key: key }
    soak:
      duration: 30m
      checks:
        - { kind: http, url: "https://staging.example/health", on_fail: hold }
    on_verify_fail: rollback
    publish:
      endpoint: { member: shop, output: url }
  prod:
    gate: always
    approval_rules:
      "*": { count: 2, proven: true }
    hold: { reason: launch week, until: "2026-12-01T00:00:00Z", description: ask the release manager }
    freeze:
      - { from: "2026-12-20T00:00:00Z", until: "2027-01-04T00:00:00Z", reason: year-end }
    urgent: { role: sre }
    pause_after_rollback: true
    failure_tolerance: 10%
    queue: replace
    reads:
      API_URL: { stage: staging, artifact: endpoint }
    risk:
      approve_above: 0.4
      approval_rules:
        "*": { roles: [sre] }
    replan_dependents: [shop/prod]
    forge_environment: production
`;

describe("the stage keys in plywood.yml", () => {
  it("take every key of chant's vocabulary under environments.<name>, off until set", () => {
    expect(errors(STAGED)).toEqual([]);
    expect(errors(PROMOTION)).toEqual([]);
    expect(isStageEntry({ gate: "always" })).toBe(true);
    expect(isStageEntry({ name: "production", url: "https://x" })).toBe(false);
    // A glob's forge environment stays a glob's.
    expect(environmentsOf(parseConfig(`${STAGED}`).doc)).toEqual([]);
  });

  it("refuses a value outside the words and a stage key without promotion", () => {
    expect(errors(`${PROMOTION}environments:\n  prod: { on_verify_fail: retry }\n`).join("\n")).toContain("environments.prod.on_verify_fail");
    expect(errors(`${PROMOTION}environments:\n  prod: { queue: fifo }\n`).join("\n")).toContain("environments.prod.queue");
    expect(errors(`${PROMOTION}environments:\n  prod: { failure_tolerance: lots }\n`).join("\n")).toContain("environments.prod.failure_tolerance");
    expect(errors(`${PROMOTION}environments:\n  prod: { after: [qa] }\n`).join("\n")).toContain("names qa, which promotion does not list");
    expect(errors(`${PROMOTION}environments:\n  prod: { soak: { duration: 1h, checks: [{ kind: ping }] } }\n`).join("\n")).toContain("environments.prod.soak.checks[0].kind");
    expect(errors(`${PROMOTION}environments:\n  prod: { imports: [nope] }\n`).join("\n")).toContain("not under config_sets");
    expect(errors(`${PROMOTION}environments:\n  prod: { secrets: { K: { forge_secret: A, aws_secrets_manager: b } } }\n`).join("\n")).toContain("names one place a secret is kept");
    expect(errors(`${STACKS}environments:\n  prod: { gate: always }\n`).join("\n")).toContain("sets a stage, and plywood.yml has no promotion");
    expect(errors(`${STACKS}recheck: { schedule: "* * * * *" }\n`).join("\n")).toContain("plywood.yml has no promotion");
    expect(errors(`${PROMOTION}risk: { approve_above: 2 }\n`).join("\n")).toContain("risk.approve_above");
    // No canary key: the canary is waves.canary. A map under environments other than { name, url } is a stage, and the stage check names the key.
    expect(errors(`${PROMOTION}environments:\n  dev: { canary: true }\n`).join("\n")).toContain("environments.dev.canary is not a key");
    expect(errors(`${PROMOTION}environments:\n  dev: { gate: never, canary: true }\n`).join("\n")).toContain("environments.dev.canary is not a key");
  });

  it("put risk and the config and secret sets on chant's workspace settings", () => {
    const doc = parseConfig(STAGED).doc;
    expect(ciRiskOf(doc)).toEqual({ approveAbove: 0.6, questions: [{ id: "blast", text: "How many users does it reach?", weight: 0.5 }] });
    expect(environmentSetsOf(doc)).toEqual({
      environments: {
        staging: {
          imports: ["common"],
          config: { REGION: "us-east-2" },
          secrets: { API_KEY: { awsSecretsManager: "arn:aws:secretsmanager:us-east-2:111111111111:secret:staging/api", jsonKey: "key" } },
        },
      },
      configSets: { common: { config: { LOG_LEVEL: "info" }, secrets: { SENTRY_DSN: "SENTRY_DSN" } } },
    });
    const s = toChantSettings(parseConfig(STAGED));
    expect(s.ci.risk?.approveAbove).toBe(0.6);
    expect(s.ci.environmentSets?.configSets).toBeDefined();
    expect(toChantSettings(parseConfig(PROMOTION)).ci).not.toHaveProperty("risk");
  });

  it("describe each key in the schema", () => {
    const schema = plywoodSchema() as { properties: Record<string, { additionalProperties?: { anyOf?: Array<{ properties?: Record<string, unknown> }> } }>; $defs: Record<string, unknown> };
    const stage = schema.properties.environments!.additionalProperties!.anyOf!.find((s) => s.properties?.soak);
    for (const k of ["gate", "hold", "freeze", "urgent", "pause_after_rollback", "on_verify_fail", "failure_tolerance", "after", "queue", "soak", "risk", "replan_dependents", "publish", "reads", "agent_steps", "config", "secrets", "imports", "forge_environment"]) {
      expect(stage?.properties).toHaveProperty(k);
    }
    for (const k of ["risk", "replan_dependents", "release", "recheck", "config_sets"]) expect(schema.properties).toHaveProperty(k);
    expect(schema.$defs).toHaveProperty("approvalNode");
  });
});

describe("approval rules", () => {
  it("take count, proven and name, and all/any groups nested up to three deep", () => {
    const yml = `approval: sealed\napproval_rules:\n  release:\n    name: release\n    any:\n      "*": { count: 2, proven: true, name: two-approvers }\n      "shop/*": { roles: [release-manager], name: release-manager }\n`;
    expect(errors(yml)).toEqual([]);
    expect(quorumOf(parseConfig(yml).doc.approval_rules as never)).toEqual([
      {
        name: "release",
        any: [
          { name: "two-approvers", targets: ["*"], count: 2, notAuthor: true, proven: true },
          { name: "release-manager", targets: ["shop/*"], count: 1, roles: ["release-manager"], notAuthor: true },
        ],
      },
    ]);
    const deep = 'approval_rules:\n  a: { all: { b: { any: { c: { all: { d: { any: { "*": { count: 1 } } } } } } } } }\n';
    expect(errors(deep).join("\n")).toContain("nests groups more than 3 deep");
    expect(errors('approval_rules:\n  "*": { quorum: 2, count: 2 }\n').join("\n")).toMatch(/set (approval_rules\S*\.)?count alone/);
  });

  it("leave a rule no approver can prove to chant's finding, not a plywood warning", () => {
    const warnings = checkConfig(parseConfig('approval_rules:\n  "*": { role: sre }\n')).filter((p) => p.severity === "warning");
    expect(warnings.map((w) => w.key)).not.toContain("approval_rules");
  });
});

const wave = (name: string, targets: string[], extra: Record<string, unknown> = {}): SpecWave => ({
  name,
  gate: "on-destructive",
  runs: targets.map((t) => ({ target: t, input: { dir: ".", stack: t.split("/")[1], member: t.split("/")[0] } })),
  ...extra,
});

describe("each stage's waves", () => {
  const doc = parseConfig(`${STACKS}promotion: [dev, staging, prod]\nwaves:\n  canary: [shop/dev]\n`).doc;
  const stacks = ["shop/dev", "shop/staging", "shop/prod"].map((key) => ({ key, project: "shop", stack: key.split("/")[1]! }));
  const staged = stagesByEnv(doc, stacks, (key) => ({ dir: ".", stack: key.split("/")[1], member: "shop" }));

  it("are the waves spec's waves over the stage's stacks, the canary first in each", () => {
    expect(staged.problems).toEqual([]);
    const first = withCanaryWave([wave("canary", ["shop/dev"], { environment: { name: "dev" } })], doc);
    expect(first[0]!.canary).toBe(true);
    const { waves, problems } = stageWaves(first, ["dev", "staging", "prod"], staged.byEnv);
    expect(problems).toEqual([]);
    expect(waves.staging![0]!.runs[0]!.target).toBe("shop/staging");
    expect(waves.staging![0]!.runs[0]!.input).toMatchObject({ stack: "staging" });
    expect(waves.prod![0]!.canary).toBe(true);
    // stacks.shop/prod.gate is the prod wave's gate; a stage without one takes the stage's gate.
    expect(waves.prod![0]!.gate).toBe("always");
    expect(waves.staging![0]).not.toHaveProperty("gate");
    // The forge environment is worked out again for the stage's stacks.
    expect(waves.staging![0]).not.toHaveProperty("environment");
  });

  it("leave the canary unmarked without waves.canary", () => {
    expect(withCanaryWave([wave("canary", ["shop/dev"])], parseConfig(PROMOTION).doc)[0]!.canary).toBeUndefined();
  });

  it("keep the canary mark where a later wave waits on a soak with a check, as chant takes it", () => {
    const soaked = parseConfig(`${PROMOTION}environments:\n  prod:\n    soak: { duration: 30m, checks: [{ kind: http, url: "https://prod.example/health" }] }\n`).doc;
    const two = [wave("canary", ["shop/prod"], { canary: true }), wave("rest", ["shop/prod"])];
    const held = canaryWhereItHolds({ dev: [wave("canary", ["shop/dev"], { canary: true })], staging: two, prod: two }, soaked);
    // The stage's only wave, and a stage with no soak check: the wave stays first, unmarked.
    expect(held.dev![0]).not.toHaveProperty("canary");
    expect(held.staging![0]).not.toHaveProperty("canary");
    expect(held.prod![0]!.canary).toBe(true);
    expect(canaryWhereItHolds({ prod: [wave("canary", ["shop/prod"], { canary: true, soak: { duration: "5m", checks: [{ kind: "http" }] } }), wave("rest", ["shop/prod"])] }, {}).prod![0]!.canary).toBe(true);
  });
});

describe(".chant/pipeline.ts", () => {
  const doc = parseConfig(STAGED).doc;
  const spec = { name: "pulumi-up", op: "pulumi-up", step: { kind: "pulumi-up" }, approvals: { preview: true, quorum: [{ count: 1 }] }, waves: [] };
  const waves = { dev: [wave("canary", ["shop/dev"], { canary: true })], staging: [wave("canary", ["shop/staging"], { canary: true })], prod: [wave("canary", ["shop/prod"], { canary: true })] };

  it("hands chant the stage keys as written, approval rules in chant's shape", () => {
    expect(chantEnvironment({ targets: { shop: "prod" }, gate: "always", config: { A: "b" }, approval_rules: { "*": { count: 2 } } })).toEqual({ gate: "always", approval: "pr-review", approval_rules: [{ targets: ["*"], count: 2, notAuthor: true }] });
    expect(chantEnvironment({ approval: "ledger", approval_rules: { "*": { count: 1 } } })).toMatchObject({ approval: "ledger" });
    expect(chantEnvironment({ approval_rules: { "*": { count: 1 } } }, { approval: "sealed" })).not.toHaveProperty("approval");
    const input = pipelineInput({ doc, waves, spec });
    expect(input.name).toBe("plywood");
    expect(input.promotion).toEqual(["dev", "staging", "prod"]);
    expect(input.environments?.staging).toMatchObject({ on_verify_fail: "rollback", soak: { duration: "30m" } });
    expect(input.release).toEqual({ cut: true, label: "auto", bin: ["npx", "--no-install", "plywood"] });
    expect(input.recheck).toEqual({ schedule: "*/15 * * * *" });
    expect(input.defaults).toMatchObject({ op: "pulumi-up", approvals: { preview: true }, replanDependents: ["shop/dev"], holds: { risk: { approveAbove: 0.6 } } });
    expect(input.defaults).not.toHaveProperty("approvals.quorum");
  });

  it("hands chant each stage's risk and replan_dependents, and chant puts them on the declaration (chant#5425)", async () => {
    expect(pipelineInput({ doc, waves, spec }).environments?.prod).toMatchObject({ replan_dependents: ["shop/prod"], risk: { approve_above: 0.4, approval_rules: [{ targets: ["*"], roles: ["sre"], count: 1, notAuthor: true }] } });
    expect(chantEnvironment({ risk: { approval_rules: [{ count: 1 }] } }, { risk: { approve_above: 0.6 } })).toMatchObject({ risk: { approve_above: 0.6 }, approval: "pr-review" });
    const { declaration } = await pipelineFile({ doc, waves, spec });
    const prod = (declaration as unknown as { stages: Array<Record<string, unknown>> }).stages[2]!;
    expect(prod).toMatchObject({ replanDependents: ["shop/prod"], gate: { holds: { risk: { approveAbove: 0.4, quorum: [{ targets: ["*"], roles: ["sre"], count: 1, notAuthor: true }] } } } });
  });

  it("is chant's pipelineSource text, and --check finds it stale once plywood.yml changes", async () => {
    const { text, declaration } = await pipelineFile({ doc, waves, spec });
    expect(text).toContain("// Written by plywood from plywood.yml. Change the config and run `plywood ci`;");
    expect(text).toContain('import { pipeline } from "@intentius/chant/pipeline";');
    const stages = (declaration as unknown as { stages: Array<Record<string, unknown>> }).stages;
    expect(stages.map((s) => s.name)).toEqual(["dev", "staging", "prod"]);
    expect(stages[1]).toMatchObject({ onVerifyFail: "rollback", soak: { duration: "30m", checks: [{ kind: "http", onFail: "hold" }] } });
    expect(stages[2]).toMatchObject({ queue: "replace", pauseAfterRollback: true, failureTolerance: "10%", forgeEnvironment: { name: "production" }, gate: { urgent: { role: "sre" } } });

    const dir = mkdtempSync(join(tmpdir(), "plywood-pipeline-"));
    mkdirSync(join(dir, ".chant"));
    const { checkPipelineFile } = await import("@intentius/chant/pipeline");
    expect(checkPipelineFile(dir, text, { command: "plywood ci" }).status).toBe("missing");
    writeFileSync(join(dir, ".chant/pipeline.ts"), text);
    expect(checkPipelineFile(dir, text, { command: "plywood ci" }).status).toBe("current");
    const changed = await pipelineFile({ doc: parseConfig(STAGED.replace("queue: replace", "queue: replace\n    pause_after_rollback: false")).doc, waves, spec });
    expect(checkPipelineFile(dir, changed.text, { command: "plywood ci" }).status).toBe("stale");
  });

  it("refuses what chant refuses, in chant's words", async () => {
    const bad = parseConfig(`${PROMOTION}environments:\n  dev:\n    agent_steps:\n      read: { prompt: hi, schema: { type: object } }\n`).doc;
    await expect(pipelineFile({ doc: bad, waves, spec })).rejects.toThrow();
  });
});

describe("agent.verify-failed", () => {
  it("is off until set, and takes the window, the relay key and max_runs", () => {
    expect(agentOf(parseConfig("agent: { comment: true }").doc)?.verifyFailed).toBeUndefined();
    const doc = parseConfig(`${PROMOTION}agent:\n  verify-failed: { window: 30, relay_key_secret: PLYWOOD_RELAY_KEY }\n  max_runs: 4\n`).doc;
    expect(errors(`${PROMOTION}agent:\n  verify-failed: { window: 30, relay_key_secret: PLYWOOD_RELAY_KEY }\n  max_runs: 4\n`)).toEqual([]);
    const a = agentOf(doc)!;
    expect(a.verifyFailed).toEqual({ window: 30, relayKeyEnv: "PLYWOOD_RELAY_KEY" });
    expect(verifyFailedFacts(a)).toEqual({ relayKeyEnv: "PLYWOOD_RELAY_KEY" });
    expect(errors(`${PROMOTION}agent:\n  verify-failed: { window: 0 }\n`).join("\n")).toContain("agent.verify-failed.window");
  });

  it("is chant's failed-verify agent with plywood's max_runs cap", () => {
    let seen: Record<string, unknown> | undefined;
    const chant = { productVerifyFailedAgent: (_w: unknown, o: Record<string, unknown>) => ((seen = o), { name: o.name }) } as unknown as ChantProduct;
    const doc = parseConfig(`${PROMOTION}agent:\n  verify-failed: true\n  max_runs: 3\n`).doc;
    expect(factTriggersOn(agentOf(doc))).toEqual(["verify-failed"]);
    triggerSpec(chant, "verify-failed", agentOf(doc)!, doc, PRODUCT_WORDS);
    expect(seen).toMatchObject({ name: TRIGGER_OPS["verify-failed"].op, maxRuns: 3, keyEnv: "ANTHROPIC_API_KEY" });
  });
});

describe("the pipeline generator's options", () => {
  it("hands chant plywood's image and engine lines for the wave and promote jobs (chant#5425)", () => {
    const config = parseConfig(`${PROMOTION}`);
    const o = pipelineGenerateOptions({ doc: config.doc, settings: toChantSettings(config), words: PRODUCT_WORDS });
    expect(o.image).toBe(publishedImage("pulumi"));
    expect(o.beforeScript).toEqual(toChantSettings(config).pipeline.engineSetup);
    expect(o).not.toHaveProperty("agentFacts");
  });

  it("takes the plunge image under plunge, and the failed-verify facts with agent.verify-failed", () => {
    const config = parseConfig(`${PROMOTION}engine: plunge\nagent:\n  verify-failed: true\n`);
    const o = pipelineGenerateOptions({ doc: config.doc, settings: toChantSettings(config), words: PRODUCT_WORDS });
    expect(o.image).toBe(publishedImage("plunge"));
    expect(o.agentFacts).toEqual({ triggers: ["verify-failed"] });
  });
});

describe("the stage commands", () => {
  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), "plywood-stage-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "plywood.yml"), PROMOTION);
    return dir;
  }
  function fakeChant(): { chant: ChantProduct; argv: string[][] } {
    const argv: string[][] = [];
    return { argv, chant: { runChantInProcess: async (a: string[]) => (argv.push(a), EXIT.done) } as unknown as ChantProduct };
  }

  it("pause and resume an environment of promotion through chant's stage", async () => {
    const f = fakeChant();
    setChantProductForTests(f.chant);
    const dir = repo();
    expect(await stageCommand("pause", ["prod", "--reason", "incident"], false, EXIT, io(dir))).toBe(EXIT.done);
    expect(await stageCommand("resume", ["prod", "--reason", "closed"], false, EXIT, io(dir))).toBe(EXIT.done);
    expect(f.argv).toEqual([
      ["stage", "pause", "prod", "--reason", "incident"],
      ["stage", "resume", "prod", "--reason", "closed"],
    ]);
    expect(await stageCommand("pause", ["qa", "--reason", "x"], false, EXIT, io(dir))).toBe(EXIT.failed);
    expect(await stageCommand("pause", ["prod"], false, EXIT, io(dir))).toBe(EXIT.failed);
  });

  it("promote --urgent passes chant's urgent flags, with the release and a reason", async () => {
    const f = fakeChant();
    setChantProductForTests(f.chant);
    const dir = repo();
    expect(await promoteRelease(["--to", "prod", "--release", "v1", "--urgent", "--reason", "security fix"], false, EXIT, io(dir))).toBe(EXIT.done);
    expect(f.argv[0]).toEqual(["components", "promote", "--to", "prod", "--release", "v1", "--reason", "security fix", "--urgent"]);
    expect(await promoteRelease(["--to", "prod", "--urgent"], false, EXIT, io(dir))).toBe(EXIT.failed);
  });

  it("name plywood's reject line in the words", () => {
    expect(PRODUCT_WORDS.reject).toBe("plywood reject {op} {gate} --plan {digest} --reason {reason} {sign}");
  });
});

describe("the merge's waves under approval rules", () => {
  it("take pr-review with rules and no approval, and the pull request's approval otherwise", () => {
    expect(wavesApprovalOf(parseConfig('approval_rules: { "*": { count: 2 } }').doc)).toBe("pr-review");
    expect(wavesApprovalOf(parseConfig('approval: ledger\napproval_rules: { "*": { count: 2 } }').doc)).toBeUndefined();
    expect(wavesApprovalOf(parseConfig("gate: always").doc)).toBeUndefined();
  });

  /** A repository plywood init sets up on the installed chant, committed, and `plywood check --base HEAD`'s code and lines. */
  async function initAndCheck(yml: string): Promise<{ init: Awaited<ReturnType<typeof runInit>>; code: number; said: string; waves: Array<{ approval?: string }> }> {
    setChantProductForTests("reset");
    const dir = mkdtempSync(join(tmpdir(), "plywood-waves-rules-"));
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: dir });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: yaml\n");
    for (const s of ["dev", "prod"]) writeFileSync(join(dir, `Pulumi.${s}.yaml`), "config: {}\n");
    writeFileSync(join(dir, "plywood.yml"), `stacks:\n  shop/dev: { dir: . }\n  shop/prod: { dir: . }\nforge: { kind: github }\n${yml}`);
    // chant's check step runs `pulumi install` for each member; a stand-in keeps the test off the runner's installed tools.
    const bin = mkdtempSync(join(tmpdir(), "plywood-fake-pulumi-"));
    writeFileSync(join(bin, "pulumi"), "#!/bin/sh\necho '{}'\n", { mode: 0o755 });
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path ?? ""}`;
    const was = process.cwd();
    process.chdir(dir);
    try {
      const init = await runInit({ bucketCheck: false, dryRun: false, yes: true }, EXIT, { cwd: dir, env: {}, out: () => {}, err: () => {} });
      git("add", "-A");
      git("commit", "-qm", "plywood init");
      const out = io(dir);
      const code = await check(["--base", "HEAD"], false, EXIT, out);
      const spec = JSON.parse(readFileSync(join(dir, ".chant/op-waves/pulumi-up.spec.json"), "utf8")) as { waves: { waves: Array<{ approval?: string }> } | Array<{ approval?: string }> };
      const waves = Array.isArray(spec.waves) ? spec.waves : spec.waves.waves;
      return { init, code, said: out.stderr.join("\n"), waves };
    } finally {
      process.chdir(was);
      if (path === undefined) delete process.env.PATH;
      else process.env.PATH = path;
    }
  }

  it("pass plywood check with rules and no signers, the merged pull request's reviews proving the approvers", async () => {
    const r = await initAndCheck('approval_rules: { "shop/*": { count: 2 } }\n');
    expect(r.init.ok, JSON.stringify([r.init.notes, r.init.files])).toBe(true);
    expect(r.waves.map((w) => w.approval)).toEqual(r.waves.map(() => "pr-review"));
    expect(r.said).not.toContain("nothing can prove one");
    expect(r.code, r.said).toBe(EXIT.done);
  }, 120_000);

  it("keep an explicit approval, where chant refuses a rule nothing can prove", async () => {
    const r = await initAndCheck('approval: ledger\napproval_rules: { "shop/*": { count: 2 } }\n');
    // chant's waves generator refuses the rule too, so init names the waves workflow as failed.
    expect(r.init.files).toContainEqual(expect.objectContaining({ file: ".github/workflows", status: "failed" }));
    expect(r.waves.map((w) => w.approval)).toEqual(r.waves.map(() => "pull-request"));
    expect(r.said).toContain("nothing can prove one");
    expect(r.code).toBe(EXIT.failed);
  }, 120_000);
});
