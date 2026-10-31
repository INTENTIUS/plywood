/**
 * The provider allowlist preset (plywood#31) over the policy fixtures'
 * preview stream (fixtures/policy/preview-stream.jsonl, hand-written in
 * `pulumi preview --json` streaming shape): an aws bucket, the aws provider
 * and a random pet created, the stack unchanged. The stream's steps become
 * a change set through the pinned pulumi lexicon's pulumiPreviewPart, which
 * the Rego rule reads as input.changeSet. opa runs the rule when it is on
 * PATH; providerDenials is the same rule in TypeScript.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { pulumiPreviewPart } from "@intentius/chant-lexicon-pulumi/change-set";
import { checkConfig, parseConfig } from "../src/config/index";
import { policyProvidersOf } from "../src/config/policy";
import { runInit, type InitIo, type InitOptions } from "../src/init";
import { FALLBACK_EXIT } from "../src/exit-codes";
import {
  providerDenials,
  providerPackageOf,
  providersPackConfig,
  providersPackFiles,
  providersRego,
  PROVIDERS_PACK_CONFIG,
  PROVIDERS_PACK_DIR,
  PROVIDERS_POLICY,
} from "../src/policy-presets";

const STREAM = readFileSync(join(import.meta.dirname, "fixtures/policy/preview-stream.jsonl"), "utf8");

/** The stream's resource events as preview steps. */
function steps(stream: string): unknown[] {
  return stream
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { resourcePreEvent?: { metadata: { op: string; urn: string; new?: unknown; old?: unknown } } })
    .flatMap((e) => (e.resourcePreEvent ? [{ op: e.resourcePreEvent.metadata.op, urn: e.resourcePreEvent.metadata.urn, newState: e.resourcePreEvent.metadata.new }] : []));
}

const entries = pulumiPreviewPart({ member: "shop/dev", preview: { steps: steps(STREAM) } }).entries;
const BUCKET = "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::site";
const PET = "urn:pulumi:dev::shop::random:index/randomPet:RandomPet::suffix";

describe("a resource's provider package", () => {
  it("is the type's first segment, the provided package for a provider, and none for the engine's types", () => {
    expect(providerPackageOf("aws:s3/bucket:Bucket")).toBe("aws");
    expect(providerPackageOf("pulumi:providers:aws")).toBe("aws");
    expect(providerPackageOf("pulumi:pulumi:Stack")).toBeUndefined();
    expect(providerPackageOf("pulumi:pulumi:StackReference")).toBeUndefined();
    expect(providerPackageOf("unknown")).toBeUndefined();
  });
});

describe("over the fixture stream", () => {
  it("allowing aws denies the random pet alone", () => {
    expect(providerDenials(entries, ["aws"])).toEqual([`${PET} uses the provider package random, which policy.providers does not list`]);
  });

  it("allowing random denies the bucket and the aws provider", () => {
    const denied = providerDenials(entries, ["random"]);
    expect(denied).toHaveLength(2);
    expect(denied).toContain(`${BUCKET} uses the provider package aws, which policy.providers does not list`);
  });

  it("a delete never denies", () => {
    expect(providerDenials([{ lexicon: "pulumi", address: PET, type: "random:index/randomPet:RandomPet", action: "delete" }], ["aws"])).toEqual([]);
  });

  const opa = spawnSync("opa", ["version"]).status === 0;
  it.skipIf(!opa)("opa gives the Rego rule the same answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-providers-"));
    writeFileSync(join(dir, "rule.rego"), providersRego(["aws"]));
    writeFileSync(join(dir, "input.json"), JSON.stringify({ changeSet: { entries } }));
    const r = spawnSync("opa", ["eval", "--format", "json", "-d", join(dir, "rule.rego"), "-i", join(dir, "input.json"), "data.main.deny_provider_package"], { encoding: "utf8" });
    const value = (JSON.parse(r.stdout) as { result: Array<{ expressions: Array<{ value: string[] }> }> }).result[0]!.expressions[0]!.value;
    expect(value).toEqual(providerDenials(entries, ["aws"]));
  });
});

describe("the preset files", () => {
  it("the Rego rule carries the list, in the namespace, under a deny_ name chant's gate counts", () => {
    const rego = providersRego(["random", "aws", "aws"], "plywood");
    expect(rego).toMatch(/^package plywood$/m);
    expect(rego).toContain('allowed := {"aws", "random"}');
    expect(rego).toMatch(/^deny_provider_package contains msg if \{/m);
    expect(rego).toContain("input.changeSet.entries");
  });

  it("the pack is mandatory and reads its list from the config file", () => {
    const files = providersPackFiles();
    expect(Object.keys(files).sort()).toEqual(["PulumiPolicy.yaml", "index.ts", "package.json"]);
    expect(files["index.ts"]).toContain(`name: "${PROVIDERS_POLICY}"`);
    expect(files["index.ts"]).toContain('enforcementLevel: "mandatory"');
    expect(JSON.parse(providersPackConfig(["random", "aws"]))).toEqual({ [PROVIDERS_POLICY]: { allowed: ["aws", "random"] } });
  });
});

describe("policy.providers", () => {
  it("is a list of package names", () => {
    const errors = (t: string) => checkConfig(parseConfig(t)).filter((p) => p.severity === "error").map((p) => p.key);
    expect(errors("policy: { providers: [aws, random] }")).toEqual([]);
    expect(errors("policy: { providers: [] }")).toEqual(["policy.providers"]);
    expect(errors("policy: { providers: [AWS] }")).toEqual(["policy.providers.0"]);
    expect(policyProvidersOf(parseConfig("policy: { providers: [aws] }").doc)).toEqual(["aws"]);
  });

  it("plywood init writes the Rego rule into policy.rego and the pack with its config", async () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-init-providers-"));
    // A checkout as init reads one, with no git run (test/init.test.ts's repo()).
    mkdirSync(join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
    writeFileSync(join(root, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = https://github.com/acme/shop.git\n');
    writeFileSync(join(root, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n");
    mkdirSync(join(root, "infra"));
    writeFileSync(join(root, "infra/Pulumi.yaml"), "name: shop\nruntime: nodejs\n");
    writeFileSync(join(root, "infra/Pulumi.dev.yaml"), "config: {}\n");
    writeFileSync(join(root, "plywood.yml"), "stacks: { shop/dev: { dir: infra } }\npolicy: { rego: policy, providers: [aws] }\n");
    const io: InitIo = { out: () => {}, err: () => {}, cwd: root, env: {} };
    const opts: InitOptions = { env: "production", bucketCheck: false, dryRun: false, yes: true };
    const result = await runInit(opts, FALLBACK_EXIT, io);
    expect(readFileSync(join(root, "policy/plywood_providers.rego"), "utf8")).toContain('allowed := {"aws"}');
    expect(existsSync(join(root, PROVIDERS_PACK_DIR, "index.ts"))).toBe(true);
    expect(JSON.parse(readFileSync(join(root, PROVIDERS_PACK_CONFIG), "utf8"))).toEqual({ [PROVIDERS_POLICY]: { allowed: ["aws"] } });
    expect(result.notes.join("\n")).toContain(`add { dir: ${PROVIDERS_PACK_DIR}, config: ${PROVIDERS_PACK_CONFIG} } to policy.packs`);
  }, 60_000);
});
