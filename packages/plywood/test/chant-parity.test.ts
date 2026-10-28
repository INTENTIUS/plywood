/**
 * plywood on chant's parity features (chant#4624 to #4636), each behind its
 * feature-detect: the chant path with the feature stood in, and the
 * fallback without it.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli";
import { setChantAuditForTests, setChantNextForTests, type ChantAudit } from "../src/chant-next";
import { setChantProductForTests, type ChantProduct, type ProductPipelineOptions } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { toChantSettings } from "../src/chant-config";
import { attributeStack, driftCloudFields, driftOpSpec, DRIFT_SPEC_FILE, specHasUpdate } from "../src/drift";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { APPLY_MERGE_NEEDS_CHANT, APPROVAL_STATUS_NOTE, DECIDE_LEFT_OFF, ci, preview, respondArgv, writtenNotes, type StageIo } from "../src/stages";
import { up } from "../src/up";
import { driftIssueBody, PRODUCT_WORDS } from "../src/words";

function fakeChant(extra: Partial<ChantProduct> = {}, file = "jobs:\n  plan:\n    steps:\n      - run: npx --no-install plywood components pr-plan\n") {
  const calls: string[][] = [];
  const pipelines: ProductPipelineOptions[] = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: (_forge, _env, options) => {
      pipelines.push(options);
      const words = options.words as typeof PRODUCT_WORDS;
      return {
        words: { ...words, stages: { ...words.stages } },
        plan: { jobName: "plan", command: "npx --no-install plywood components pr-plan --gate up" },
        post: { command: "npx --no-install plywood components pr-post" },
        comments: {},
        ...(options.staleNotes ? { stale: { command: "npx --no-install plywood components pr-post --stale", env: {} } } : {}),
      };
    },
    approveLine: () => "",
    runChantInProcess: async (argv) => {
      calls.push(argv);
      const out = argv.indexOf("--output");
      if (argv[0] === "build" && out >= 0) {
        mkdirSync(dirname(argv[out + 1]!), { recursive: true });
        writeFileSync(argv[out + 1]!, file);
      }
      return 0;
    },
    ...extra,
  };
  return { api, calls, pipelines };
}

function io(cwd: string, env: NodeJS.ProcessEnv = {}): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

function repo(yml = "stacks:\n  shop/dev: {}\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-parity-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  return dir;
}

const problems = (yml: string) => checkConfig(parseConfig(yml)).map((p) => `${p.severity} ${p.key}`);

beforeEach(() => setChantNextForTests({}));
afterEach(() => {
  setChantProductForTests("reset");
  setChantNextForTests("reset");
  setChantAuditForTests("reset");
});

describe("plywood preview --refresh and --target-dependents (chant#4627)", () => {
  it("passes both to pr-plan on a chant with chant#4627", async () => {
    setChantNextForTests({ planFlags: true });
    const chant = fakeChant({ prCommentPreviewJob: () => undefined, PR_PREVIEW_FLOOR: "0.124.55" });
    setChantProductForTests(chant.api);
    expect(await preview(["shop/dev", "--base", "a", "--pr", "1", "--refresh", "--target", "urn:x", "--target-dependents"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls[0]).toEqual(expect.arrayContaining(["components", "pr-plan", "--member", "shop/dev", "--refresh", "--target", "urn:x", "--target-dependents"]));
  });

  it("refuses them on a chant without it, and --target-dependents without a --target", async () => {
    const chant = fakeChant({ prCommentPreviewJob: () => undefined, PR_PREVIEW_FLOOR: "0.124.55" });
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await preview(["--base", "a", "--pr", "1", "--target", "urn:x", "--target-dependents"], false, FALLBACK_EXIT, o)).toBe(1);
    expect(o.stderr.join("\n")).toContain("--target-dependents needs a chant whose pr-plan passes it to the pulumi-up step (chant#4627)");
    setChantNextForTests({ planFlags: true });
    const p = io(repo());
    expect(await preview(["--base", "a", "--pr", "1", "--target-dependents"], false, FALLBACK_EXIT, p)).toBe(1);
    expect(p.stderr.join("\n")).toContain("give a --target");
    expect(chant.calls).toEqual([]);
  });
});

describe("plywood ci on the parity features", () => {
  it("turns on the stale marking with chant#4628, and not before", async () => {
    setChantNextForTests({ staleNotes: true });
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.pipelines[0]!.staleNotes).toBe(true);
    expect(chant.calls[0]).toContain("--stale-notes");
    expect(o.stderr.join("\n")).toContain("stale     npx --no-install plywood components pr-post --stale");
    setChantNextForTests({});
    const old = fakeChant();
    setChantProductForTests(old.api);
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(old.pipelines[0]!.staleNotes).toBeUndefined();
    expect(old.calls[0]).not.toContain("--stale-notes");
  });

  it("hands chant the responses and the decide service with chant#4629, and says the pull request jobs keep chant's defaults", async () => {
    const yml = "stacks:\n  shop/dev: {}\nrespond:\n  wave_refused: off\n  description: check\ndecide:\n  backend: laya\n  model: m-1\n";
    const chant = fakeChant({ CI_RESPOND_FLOOR: "0.124.56" });
    setChantProductForTests(chant.api);
    const o = io(repo(yml));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.pipelines[0]).toMatchObject({ respond: { "wave-refused": "off", description: "check" }, decide: { backend: "laya", model: "m-1" } });
    expect(o.stderr.join("\n")).toContain("respond.description reaches no pull request job yet");
    const old = fakeChant();
    setChantProductForTests(old.api);
    const p = io(repo(yml));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, p)).toBe(0);
    expect(old.pipelines[0]!.respond).toBeUndefined();
    expect(p.stderr.join("\n")).toContain("respond.wave_refused, respond.description need chant's responses to pipeline events (chant#4629)");
  });

  it("puts the responses and the decide service on the build line with PR_LOOP_BUILD_FLAGS_FLOOR", async () => {
    const yml = "stacks:\n  shop/dev: {}\nrespond:\n  wave_refused: off\n  description: check\ndecide:\n  backend: laya\n  model: m-1\n";
    const chant = fakeChant({ CI_RESPOND_FLOOR: "0.124.56", PR_LOOP_BUILD_FLAGS_FLOOR: "0.124.56" });
    setChantProductForTests(chant.api);
    const o = io(repo(yml));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.pipelines[0]).toMatchObject({ respond: { "wave-refused": "off", description: "check" }, decide: { backend: "laya", model: "m-1" } });
    const build = chant.calls[0]!;
    expect(build.slice(build.indexOf("--respond"), build.indexOf("--respond") + 6)).toEqual(["--respond", "wave-refused=off,description=check", "--decide-backend", "laya", "--decide-model", "m-1"]);
    expect(o.stderr.join("\n")).not.toContain("reaches no pull request job yet");
  });

  it("leaves the decide service off the build line and the jobs unless respond.description is check", async () => {
    const yml = "stacks:\n  shop/dev: {}\nrespond:\n  apply_failed: off\ndecide:\n  backend: laya\n  model: m-1\n";
    expect(problems(yml)).toContain("warning decide");
    const chant = fakeChant({ CI_RESPOND_FLOOR: "0.124.56", PR_LOOP_BUILD_FLAGS_FLOOR: "0.124.56" });
    setChantProductForTests(chant.api);
    const o = io(repo(yml));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.pipelines[0]!.decide).toBeUndefined();
    expect(chant.calls[0]).toEqual(expect.arrayContaining(["--respond", "apply-failed=off"]));
    expect(chant.calls[0]).not.toContain("--decide-backend");
    expect(chant.calls[0]).not.toContain("--decide-model");
    expect(o.stderr.join("\n")).toContain(DECIDE_LEFT_OFF);
  });

  it("writes no --respond when every response is chant's default, and no flags on a chant before the floor", async () => {
    expect(respondArgv({ "wave-refused": "diff", "apply-failed": "triage", description: "off" }, undefined)).toEqual([]);
    expect(respondArgv({ description: "check" }, undefined)).toEqual(["--respond", "description=check"]);
    expect(respondArgv({ description: "off" }, { backend: "laya", model: "m" })).toEqual([]);
    const yml = "stacks:\n  shop/dev: {}\nrespond:\n  description: check\ndecide:\n  backend: laya\n  model: m-1\n";
    const old = fakeChant({ CI_RESPOND_FLOOR: "0.124.56" });
    setChantProductForTests(old.api);
    const o = io(repo(yml));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(old.calls[0]).not.toContain("--respond");
    expect(old.calls[0]).not.toContain("--decide-backend");
    expect(o.stderr.join("\n")).toContain("respond.description reaches no pull request job yet");
  });

  it("asks for the merge after an update before merge with chant#4636, and says when the file lacks it", async () => {
    const yml = "stacks:\n  shop/dev: {}\napply:\n  when: pull-request\n  merge: auto\n  merge_token_env: PLYWOOD_MERGE_TOKEN\n  merge_method: squash\n";
    setChantNextForTests({ applyMerge: true });
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo(yml));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.pipelines[0]!.applyMerge).toEqual({ tokenEnv: "PLYWOOD_MERGE_TOKEN", method: "squash" });
    expect(chant.calls[0]).toEqual(expect.arrayContaining(["--apply-before-merge", "--merge", "auto", "--merge-token-env", "PLYWOOD_MERGE_TOKEN", "--merge-method", "squash"]));
    expect(o.stderr.join("\n")).toContain("wrote the update before merge without the merge");
    expect(writtenNotes({ applyMerge: { tokenEnv: "X" } }, join(repo(), "none.yml"))).toEqual([]);
    setChantNextForTests({});
    const old = fakeChant();
    setChantProductForTests(old.api);
    const p = io(repo(yml));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, p)).toBe(0);
    expect(old.calls[0]).not.toContain("--merge");
    expect(p.stderr.join("\n")).toContain(APPLY_MERGE_NEEDS_CHANT);
  });

  it("writes no merge note when chant's generator wrote the merge", async () => {
    setChantNextForTests({ applyMerge: true });
    const chant = fakeChant({}, "jobs:\n  apply:\n    steps:\n      - run: npx --no-install plywood ci run apply --merge auto --merge-token-env T\n");
    setChantProductForTests(chant.api);
    const o = io(repo("stacks:\n  shop/dev: {}\napply:\n  when: pull-request\n  merge: auto\n  merge_token_env: T\n"));
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(o.stderr.join("\n")).not.toContain("without the merge");
  });

  it("says no approval status is posted under approval: pr-review (chant#4630)", async () => {
    const dir = repo("stacks:\n  shop/dev: {}\napproval: pr-review\n");
    mkdirSync(join(dir, ".chant/op-waves"), { recursive: true });
    writeFileSync(join(dir, ".chant/op-waves/pulumi-up.spec.json"), JSON.stringify({ name: "pulumi-up", waves: [{ name: "dev", runs: [{ target: "shop/dev" }] }] }));
    setChantProductForTests(fakeChant({ APPROVAL_STATUS_FLOOR: "0.124.56" }).api);
    const o = io(dir);
    expect(await ci(["--forge", "github", "--dry-run"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(o.stderr.join("\n")).toContain(APPROVAL_STATUS_NOTE);
  });
});

describe("plywood.yml's parity keys", () => {
  it("checks respond, decide and apply.merge", () => {
    expect(problems("respond:\n  description: check\n")).toContain("error respond.description");
    expect(problems("respond:\n  wave_refused: loud\n")).toContain("error respond.wave_refused");
    expect(problems("decide:\n  backend: laya\n  model: m\n")).toContain("warning decide");
    expect(problems("respond:\n  description: check\ndecide:\n  backend: laya\n  model: m\n")).toEqual([]);
    expect(problems("apply:\n  merge: auto\n  merge_token_env: T\n")).toContain("error apply.merge");
    expect(problems("apply:\n  when: pull-request\n  merge: auto\n")).toContain("error apply.merge_token_env");
    expect(problems("apply:\n  when: pull-request\n  merge_method: squash\n")).toContain("error apply.merge_method");
    expect(problems("apply:\n  when: pull-request\n  merge: auto\n  merge_token_env: T\n")).toEqual([]);
    expect(problems("drift:\n  schedule: \"0 6 * * *\"\n  audit_log: gcp\n")).toContain("error drift.audit_log");
    expect(problems("drift:\n  schedule: \"0 6 * * *\"\n  audit_log: { \"shop/*\": aws:eu-west-1 }\n")).toEqual([]);
  });

  it("translates them to chant's names", () => {
    const p = toChantSettings(parseConfig("apply:\n  when: pull-request\n  merge: auto\n  merge_token_env: T\nrespond:\n  apply_failed: off\n")).pipeline;
    expect(p.applyMerge).toEqual({ tokenEnv: "T" });
    expect(p.respond).toEqual({ "apply-failed": "off" });
    expect(p.drift).toBeUndefined();
  });
});

describe("plywood up --pr and apply.merge (chant#4636)", () => {
  const yml = "stacks:\n  shop/dev: {}\napply:\n  when: pull-request\n  merge: auto\n  merge_token_env: T\nforge:\n  kind: forgejo\n";
  it("merges after the update on a chant with chant#4636", async () => {
    setChantNextForTests({ applyMerge: true });
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await up(["--pr", "4"], false, FALLBACK_EXIT, io(repo(yml), { BASE_SHA: "abc" }))).toBe(0);
    expect(chant.calls[0]).toEqual(expect.arrayContaining(["pr-apply", "--before-merge", "--merge", "auto", "--merge-token-env", "T"]));
  });

  it("leaves the merge to a person, and says so, on a chant without it", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo(yml), { BASE_SHA: "abc" });
    expect(await up(["--pr", "4"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.calls[0]).not.toContain("--merge");
    expect(o.stderr.join("\n")).toContain(APPLY_MERGE_NEEDS_CHANT);
  });
});

describe("the drift jobs' identities (chant#4631)", () => {
  const yml = [
    "stacks:\n  shop/dev: {}\n  shop/prod: {}",
    "waves:\n  - [shop/dev]\n  - [shop/prod]",
    "identity:\n  preview:\n    aws: arn:aws:iam::1:role/preview\n  up:\n    aws: arn:aws:iam::1:role/up\n  aws:\n    region: eu-west-1",
    "environments:\n  shop/prod: production",
    "respond:\n  drift: up",
    "",
  ].join("\n");

  it("trades the read for the preview identity, and moves respond.drift up into an update job with the up identity", () => {
    const doc = parseConfig(yml).doc;
    const fields = driftCloudFields(doc, "github", "shop/prod", "up", "production") as { cloud: { aws: { role: string } }; update: { command: string; cloud: { aws: { role: string } }; environment: { name: string } } };
    expect(fields.cloud.aws.role).toBe("arn:aws:iam::1:role/preview");
    expect(fields.update.command).toBe("npx --no-install plywood up --wave 2");
    expect(fields.update.cloud.aws.role).toBe("arn:aws:iam::1:role/up");
    expect(fields.update.environment.name).toBe("production");
    expect(driftCloudFields(doc, "github", "shop/dev", "issue", "production")).not.toHaveProperty("update");
  });

  it("puts them on the spec only on a chant with chant#4631", () => {
    const doc = parseConfig(yml).doc;
    expect(driftOpSpec(doc, "github", ["shop/dev"], "0 6 * * *").ops[0]).not.toHaveProperty("cloud");
    expect(driftOpSpec(doc, "github", ["shop/dev"], "0 6 * * *", undefined, { cloud: true, env: "production" }).ops[0]).toHaveProperty("update");
  });

  it("leaves the update to the update job when the spec has one", () => {
    const dir = repo(yml);
    mkdirSync(join(dir, ".chant/ops"), { recursive: true });
    writeFileSync(join(dir, DRIFT_SPEC_FILE), JSON.stringify({ ops: [{ name: "plywood-drift-shop-dev", update: { command: "x" } }] }));
    expect(specHasUpdate(dir, "plywood-drift-shop-dev")).toBe(true);
    expect(specHasUpdate(dir, "plywood-drift-shop-prod")).toBe(false);
    expect(specHasUpdate(repo(), "plywood-drift-shop-dev")).toBe(false);
  });
});

describe("drift attribution (chant#4632)", () => {
  const audit: ChantAudit = {
    parseAuditLogSetting: (t) => (t.startsWith("aws") ? { cloud: "aws", ...(t.includes(":") ? { region: t.split(":")[1]! } : {}) } : { error: "not aws" }),
    attributeDrift: async (doc, o) => ({
      attributions: (doc.records as Array<{ address: string }>).map((r) => ({ member: "shop/dev", address: r.address, path: "tags", actor: "human", source: "audit", detail: `PutTags by alice in ${JSON.stringify(o?.auditLogs)}` })),
      notes: [],
    }),
    routeAttributions: (a) => ({ lines: a.map((x) => `- human edit: \`${x.address}\` \`${x.path}\` (audit log: ${x.detail})`) }),
  };

  it("names who changed each attribute from the stack's audit log", async () => {
    const lines = await attributeStack({ audit, logs: { "shop/*": "aws:eu-west-1" } }, "shop/dev", { records: [{ address: "urn:b", status: "drifted" }] });
    expect(lines).toEqual(['- human edit: `urn:b` `tags` (audit log: PutTags by alice in {"*":{"cloud":"aws","region":"eu-west-1"}})']);
    expect(await attributeStack({ audit, logs: { "web/*": "aws" } }, "shop/dev", { records: [] })).toBeUndefined();
    const body = driftIssueBody({ stack: "shop/dev", rows: [], observedAt: "t", fingerprint: "f", attribution: lines! });
    expect(body).toContain("Who changed each attribute");
    expect(body).toContain("PutTags by alice");
  });
});

describe("the bin passes chant's check-job and audit-log through (chant#4624, #4632)", () => {
  it("runs both with plywood's words", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const c: Io = { out: () => {}, err: () => {} };
    await main(["ci", "check-job"], c);
    await main(["audit-log", "unrecorded", "--audit-log", "aws", "--op", "pulumi-up", "--since", "2026-10-01T00:00:00Z"], c);
    expect(chant.calls).toEqual([
      ["ci", "check-job"],
      ["audit-log", "unrecorded", "--audit-log", "aws", "--op", "pulumi-up", "--since", "2026-10-01T00:00:00Z"],
    ]);
  });
});
