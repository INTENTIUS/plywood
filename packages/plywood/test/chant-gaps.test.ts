/**
 * plywood on chant#4608 (forge check), #4610 and #4611 (notify words and
 * relay), #4612 (estate) and #4613 (policy source and packs at base). Each
 * runs against a fake of chant's entry and against its absence, the
 * fallback the 0.124.54 pin takes. A last block runs the real entries and
 * skips on a chant without them. Nothing reaches a forge, a cloud or Pulumi
 * Cloud.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { toChantSettings } from "../src/chant-config";
import { chantNotifyOf, notifyForChant } from "../src/config/observe";
import { chantPolicyOf, setChantPolicySourceForTests, stepPolicyPacksOf } from "../src/config/policy";
import { checkConfig, parseConfig } from "../src/config/index";
import { estate, estateSchedules, setChantEstateForTests, type ChantEstate } from "../src/estate";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { contractPipelines, forgeCheck, setChantForgeCheckForTests, upRunner, type ChantForgeCheck } from "../src/identities";
import { notify } from "../src/notify";
import type { StageIo } from "../src/stages";
import { NOTIFY_WORDS, PRODUCT_WORDS } from "../src/words";

const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

function io(cwd: string, env: NodeJS.ProcessEnv = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const stageIo: StageIo = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env };
  return { stageIo, out, err };
}

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-gaps-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

afterEach(() => {
  setChantForgeCheckForTests("reset");
  setChantEstateForTests("reset");
  setChantProductForTests("reset");
  setChantPolicySourceForTests("reset");
});

const IDENTITY_YML = [
  "pulumi_cloud: { org: acme, api_url: http://127.0.0.1:1/ }",
  "stacks:",
  "  shop/dev: { dir: infra }",
  "identity:",
  "  preview: { pulumi: team:previewers }",
  "  up: { pulumi: team:deployers }",
  "runners: { default: ubuntu-latest, up: [self-hosted, deploy] }",
  "",
].join("\n");

/** A chant forge check that records what plywood passed it. */
function fakeForgeCheck() {
  const calls: { contract?: unknown; words?: unknown; file?: string; target?: unknown; resolved: Array<[unknown, string, string | undefined]> } = { resolved: [] };
  const fc: ChantForgeCheck = {
    forgeCheckTarget: (_env, opts) => ({ kind: opts?.kind ?? "github", host: "github.com", repo: opts?.repo ?? "acme/infra" }),
    resolveCloudIdentity: (decl, env, member) => {
      calls.resolved.push([decl, env, member]);
      return { plan: { pulumi: { token: "team:previewers" } }, apply: { pulumi: { token: "team:deployers" } } };
    },
    pipelineContract: (input) => ({ contract: input }),
    forgeCheck: async (input) => {
      calls.target = input.target;
      calls.words = input.words;
      calls.file = input.file;
      calls.contract = input.contract({ defaultBranch: "trunk", path: "acme/infra" });
      return { ok: false, rows: [{ status: "mismatch", where: "pulumi" }] };
    },
    forgeCheckExit: (r) => (r.ok ? 0 : 1),
    describeForgeCheck: () => "plywood forge check: 1 mismatch",
  };
  return { fc, calls };
}

describe("plywood forge check on chant#4608", () => {
  it("builds the contract from plywood.yml's rendered ci.identity, per workspace member, in plywood's words", async () => {
    const dir = repo({ "plywood.yml": IDENTITY_YML, "chant.workspace.json": JSON.stringify({ name: "infra", members: [{ name: "shop", dir: "infra", kind: "pulumi" }] }) });
    const { fc, calls } = fakeForgeCheck();
    setChantForgeCheckForTests(fc);
    const t = io(dir);
    expect(await forgeCheck(["check", "--forge", "github", "--repo", "acme/infra", "--env", "production"], false, FALLBACK_EXIT, t.stageIo)).toBe(1);
    expect(calls.words).toBe(PRODUCT_WORDS);
    expect(calls.resolved).toEqual([[toChantSettings(parseConfig(IDENTITY_YML)).ci.identity!.cloud, "production", "shop"]]);
    const contract = (calls.contract as { contract: Record<string, unknown> }).contract;
    expect(contract).toMatchObject({
      forge: "github",
      repository: { host: "github.com", path: "acme/infra", defaultBranch: "trunk" },
      pipelines: [{ name: "shop/production", member: "shop", applyRunner: { labels: ["self-hosted", "deploy"] } }],
      words: PRODUCT_WORDS,
    });
    expect(t.out).toEqual(["plywood forge check: 1 mismatch"]);
  });

  it("takes --branch over the forge's default branch, and prints chant's result with --json", async () => {
    const dir = repo({ "plywood.yml": IDENTITY_YML });
    const { fc, calls } = fakeForgeCheck();
    setChantForgeCheckForTests(fc);
    const t = io(dir);
    await forgeCheck(["check", "--forge", "github", "--branch", "main"], true, FALLBACK_EXIT, t.stageIo);
    const contract = (calls.contract as { contract: { repository: { defaultBranch: string }; pipelines: Array<{ name: string }> } }).contract;
    expect(contract.repository.defaultBranch).toBe("main");
    // No chant.workspace.json: one pipeline for the environment, as chant names a single project's.
    expect(contract.pipelines.map((p) => p.name)).toEqual(["production"]);
    expect(JSON.parse(t.out[0]!)).toEqual({ ok: false, rows: [{ status: "mismatch", where: "pulumi" }] });
  });

  it("refuses an unknown forge and an unknown flag before reading anything", async () => {
    const { fc, calls } = fakeForgeCheck();
    setChantForgeCheckForTests(fc);
    const dir = repo({ "plywood.yml": IDENTITY_YML });
    expect(await forgeCheck(["check", "--forge", "bitbucket"], false, FALLBACK_EXIT, io(dir).stageIo)).toBe(FALLBACK_EXIT.failed);
    expect(await forgeCheck(["check", "--wide"], false, FALLBACK_EXIT, io(dir).stageIo)).toBe(FALLBACK_EXIT.failed);
    expect(calls.contract).toBeUndefined();
  });

  it("maps plywood's runner onto the up jobs' runner", () => {
    expect(upRunner("ubuntu-latest")).toEqual({ labels: ["ubuntu-latest"] });
    expect(upRunner({ default: "a", up: { group: "deployers", labels: ["x"] } })).toEqual({ labels: ["x"], group: "deployers" });
    expect(upRunner({ preview: "a" })).toBeUndefined();
    expect(contractPipelines({ resolveCloudIdentity: () => undefined }, {}, "production", ["shop"])).toEqual([]);
  });
});

describe("notify words and the relay (chant#4610, #4611)", () => {
  it("gives chant plywood's source, wave label and header prefix", () => {
    expect(PRODUCT_WORDS.notify).toEqual({ source: "plywood", wave: "wave {k} ({name}) of {spec}", headers: "x-plywood" });
    expect(NOTIFY_WORDS.wave).toContain("{k}");
  });

  it("turns notify.relay into chant's relay setting, beside a chat channel", () => {
    expect(chantNotifyOf(parseConfig("notify: { slack: { webhook: SLACK_URL }, relay: RELAY_KEY }").doc)).toEqual({ slack: "SLACK_URL", relay: "RELAY_KEY" });
    expect(errors("notify: { slack: { webhook: S }, relay: https://relay.acme.internal }").map((p) => p.key)).toEqual(["notify.relay"]);
    expect(errors("notify: { webhook: { url: U, key: K }, relay: RELAY_KEY }").map((p) => p.key)).toEqual(["notify.relay"]);
  });

  it("leaves relay out of the waves spec on a chant without the relay", () => {
    const n = { slack: "SLACK_URL", relay: "RELAY_KEY" };
    expect(notifyForChant(n, { NOTIFY_RELAY_FLOOR: "0.125.0" })).toEqual(n);
    expect(notifyForChant(n, {})).toEqual({ slack: "SLACK_URL" });
    expect(notifyForChant(n, undefined)).toEqual({ slack: "SLACK_URL" });
  });

  it("runs chant's notify relay in process with plywood's words, and says so on a chant without it", async () => {
    const calls: Array<{ argv: string[]; words: unknown }> = [];
    const base = {
      assertProductWords: (w: unknown) => w,
      productPipelineJobs: () => ({}),
      approveLine: () => "",
      runChantInProcess: async (argv: string[], words: unknown) => (calls.push({ argv, words }), 0),
    } as unknown as ChantProduct;
    setChantProductForTests({ ...base, startRelayServer: () => undefined, NOTIFY_RELAY_FLOOR: "0.125.0" });
    expect(await notify(["relay"], false, FALLBACK_EXIT, io(tmpdir()).stageIo)).toBe(0);
    expect(calls).toEqual([{ argv: ["notify", "relay"], words: PRODUCT_WORDS }]);
    setChantProductForTests(base);
    const t = io(tmpdir());
    expect(await notify(["relay"], false, FALLBACK_EXIT, t.stageIo)).toBe(FALLBACK_EXIT.failed);
    expect(t.err.join("\n")).toContain("chant#4611");
    expect(await notify(["send"], false, FALLBACK_EXIT, io(tmpdir()).stageIo)).toBe(FALLBACK_EXIT.failed);
  });
});

describe("plywood estate on chant#4612", () => {
  const DRIFT_YML = "stacks:\n  shop/dev: { dir: infra }\n  shop/prod: { dir: infra }\ndrift: { schedule: \"0 6 * * *\" }\nreports: { url: file:///tmp/plywood-reports }\n";

  function fakeEstate(overdue: Array<{ op: string; member: string; message: string }> = []) {
    const calls: { built?: Record<string, unknown>; written?: Record<string, unknown>; url?: string } = {};
    const fake: ChantEstate = {
      readEstateLedger: async () => ({ data: {} }),
      buildLedgerEstate: (input) => {
        calls.built = input as unknown as Record<string, unknown>;
        return { estate: { totals: { stacks: 2, overdue: overdue.length } }, dora: { schema: "plywood.dora/v1" }, overdue };
      },
      writeEstate: async (_e, options) => {
        calls.written = options as unknown as Record<string, unknown>;
        return { keys: ["estate/estate.json", "estate/estate.html", "estate/dora.json"] };
      },
      parseReportUrl: (raw) => {
        calls.url = raw;
        return raw.startsWith("file://") ? { kind: "file", dir: raw.slice(7) } : { error: `${raw} is not a report URL` };
      },
      reportPut: () => async () => undefined,
    };
    return { fake, calls };
  }

  it("judges plywood's drift Ops on drift.schedule", () => {
    expect(estateSchedules(parseConfig(DRIFT_YML))).toEqual({
      schedules: [
        { op: "plywood-drift-shop-dev", cron: "0 6 * * *" },
        { op: "plywood-drift-shop-prod", cron: "0 6 * * *" },
      ],
      driftOps: ["plywood-drift-shop-dev", "plywood-drift-shop-prod"],
    });
  });

  it("reads the ledger with plywood's words and writes the three files to reports.url", async () => {
    const { fake, calls } = fakeEstate();
    setChantEstateForTests(fake);
    setChantProductForTests(undefined);
    const t = io(repo({ "plywood.yml": DRIFT_YML }));
    expect(await estate([], false, FALLBACK_EXIT, t.stageIo)).toBe(0);
    expect(calls.built).toMatchObject({ words: PRODUCT_WORDS, driftOps: ["plywood-drift-shop-dev", "plywood-drift-shop-prod"] });
    expect(calls.url).toBe("file:///tmp/plywood-reports");
    expect(calls.written).toMatchObject({ words: PRODUCT_WORDS });
    expect(t.out.join("\n")).toContain("estate/dora.json");
  });

  it("exits failed on an overdue check only with --fail-overdue", async () => {
    const overdue = [{ op: "plywood-drift-shop-dev", member: "shop", message: "plywood drift checks of stack `shop` are overdue" }];
    const { fake } = fakeEstate(overdue);
    setChantEstateForTests(fake);
    setChantProductForTests(undefined);
    const dir = repo({ "plywood.yml": DRIFT_YML });
    expect(await estate([], false, FALLBACK_EXIT, io(dir).stageIo)).toBe(0);
    const t = io(dir);
    expect(await estate(["--fail-overdue"], true, FALLBACK_EXIT, t.stageIo)).toBe(FALLBACK_EXIT.failed);
    expect(JSON.parse(t.out[0]!).overdue).toEqual(overdue);
  });

  it("refuses a report URL chant cannot read, and says so on a chant without ci-estate", async () => {
    const { fake } = fakeEstate();
    setChantEstateForTests(fake);
    setChantProductForTests(undefined);
    expect(await estate(["--report-url", "ftp://x"], false, FALLBACK_EXIT, io(repo({ "plywood.yml": DRIFT_YML })).stageIo)).toBe(FALLBACK_EXIT.failed);
    setChantEstateForTests(undefined);
    const t = io(tmpdir());
    expect(await estate([], false, FALLBACK_EXIT, t.stageIo)).toBe(FALLBACK_EXIT.failed);
    expect(t.err.join("\n")).toContain("chant#4612");
  });
});

describe("policy.source and ci.policy.packs on chant#4613", () => {
  const SHARED = "policy:\n  source: { repo: \"https://git.acme.internal/policy.git\", ref: v3, path: rego }\n  packs: [guard]\n";

  it("maps policy.source onto ci.policy.source, and the packs into ci.policy.packs read from it", () => {
    setChantPolicySourceForTests(true);
    expect(errors(SHARED)).toEqual([]);
    const s = toChantSettings(parseConfig(SHARED));
    expect(s.ci.policy).toEqual({ source: { repo: "https://git.acme.internal/policy.git", ref: "v3", path: "rego" }, packs: [{ dir: "guard" }] });
    // The packs are paths in the source; the step input carries none.
    expect(s.pipeline.policyPacks).toBeUndefined();
  });

  it("lists the repository's packs in ci.policy.packs too, so a pull request cannot drop them", () => {
    setChantPolicySourceForTests(true);
    const s = toChantSettings(parseConfig("policy:\n  rego: policy\n  packs: [policy/aws-guard, { dir: policy/tags, config: policy/tags.json }]\n"));
    expect(s.ci.policy).toEqual({ path: "policy", packs: [{ dir: "policy/aws-guard" }, { dir: "policy/tags", config: "policy/tags.json" }] });
    expect(s.pipeline.policyPacks).toEqual([{ dir: "policy/aws-guard" }, { dir: "policy/tags", config: "policy/tags.json" }]);
  });

  it("refuses a bad repo or ref, an unknown key, and rego beside a source", () => {
    setChantPolicySourceForTests(true);
    expect(errors("policy: { source: { repo: \"--upload-pack=x\", ref: v1 } }").map((p) => p.key)).toEqual(["policy.source.repo"]);
    expect(errors("policy: { source: { repo: \"git@git.acme.internal:policy.git\", ref: \"a..b\" } }").map((p) => p.key)).toEqual(["policy.source.ref"]);
    expect(errors("policy: { source: { repo: \"file:///srv/policy.git\", ref: main, depth: 1 } }").map((p) => p.key)).toContain("policy.source.depth");
    expect(errors("policy: { rego: policy, source: { repo: \"file:///srv/policy.git\", ref: main } }").map((p) => p.key)).toEqual(["policy.rego"]);
  });

  it("keeps today's translation on a chant without the policy source", () => {
    setChantPolicySourceForTests(false);
    const doc = parseConfig("policy: { rego: policy, packs: [guard] }").doc;
    expect(chantPolicyOf(doc)).toEqual({ path: "policy" });
    expect(stepPolicyPacksOf(doc)).toEqual([{ dir: "guard" }]);
    expect(errors(SHARED).map((p) => p.key)).toEqual(["policy.source"]);
  });
});

/** The real entries; each skips on a chant without it (the 0.124.54 pin). */
describe("against the installed chant", async () => {
  // @ts-ignore: newer than the pin (chant#4608, #4612, #4613).
  const fc = (await import("@intentius/chant/forge-check").catch(() => undefined)) as Record<string, unknown> | undefined;
  // @ts-ignore: newer than the pin (chant#4610).
  const product = (await import("@intentius/chant/ci-product").catch(() => undefined)) as Record<string, unknown> | undefined;

  it.skipIf(typeof fc?.pipelineContract !== "function")("chant's pipelineContract names plywood's jobs and its preview status", async () => {
    const id = (await import("@intentius/chant/ci-identity")) as Record<string, unknown>;
    const decl = toChantSettings(parseConfig(IDENTITY_YML)).ci.identity!.cloud;
    const pipelines = contractPipelines(id as unknown as Pick<ChantForgeCheck, "resolveCloudIdentity">, decl, "production", ["shop"]);
    const contract = (fc!.pipelineContract as ChantForgeCheck["pipelineContract"])({
      forge: "github",
      repository: { host: "github.com", path: "acme/infra", defaultBranch: "main" },
      pipelines,
      words: PRODUCT_WORDS,
    }) as { jobs: Array<{ name: string; pulumi?: { tokens: string[] } }>; requiredStatuses: string[] };
    expect(contract.jobs.map((j) => j.name)).toEqual(["shop/production preview", expect.stringMatching(/^shop\/production /), "shop/production up"]);
    expect(contract.jobs[2]!.pulumi?.tokens).toEqual(["team:deployers"]);
    expect(contract.requiredStatuses).toEqual(["plywood/preview/shop"]);
  });

  it.skipIf(typeof product?.notifyWaveLabel !== "function")("chant fills plywood's wave label and checks the notify words", () => {
    const words = (product!.assertProductWords as (w: unknown) => unknown)(PRODUCT_WORDS);
    expect((product!.notifyWaveLabel as (w: unknown, i: unknown) => string)(words, { k: 2, name: "prod", spec: "pulumi-up" })).toBe("wave 2 (prod) of pulumi-up");
  });
});
