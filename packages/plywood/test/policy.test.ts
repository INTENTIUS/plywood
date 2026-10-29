import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { packsForStack, policyPacksOf, setChantPolicySourceForTests } from "../src/config/policy";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { componentsFile, stepInput } from "../src/init/render";
import { refusalLine, refusalOf } from "../src/refusals";
import { crossGuardRuleId } from "../src/words";

const FIXTURES = join(import.meta.dirname, "fixtures/policy");
const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

describe("policy in plywood.yml", () => {
  it("turns rego into chant's ci.policy and packs into the pipeline", () => {
    const s = toChantSettings(parseConfig("policy:\n  rego: policy/\n  engine: opa\n  namespace: plywood\n  packs: [policy/aws-guard, { dir: ./policy/tags, config: policy/tags.json }]\n"));
    expect(s.ci.policy).toEqual({ engine: "opa", path: "policy", namespace: "plywood" });
    expect(s.pipeline.policyPacks).toEqual([{ dir: "policy/aws-guard" }, { dir: "policy/tags", config: "policy/tags.json" }]);
  });

  it("sets nothing when policy is absent, and only packs when only packs are listed", () => {
    expect(toChantSettings(parseConfig("")).ci.policy).toBeUndefined();
    const s = toChantSettings(parseConfig("policy: { packs: [guard] }"));
    expect(s.ci.policy).toBeUndefined();
    expect(s.pipeline.policyPacks).toEqual([{ dir: "guard" }]);
  });

  it("refuses an unattended outcome and an outcomes map, saying why", () => {
    for (const key of ["allow_unattended", "outcomes"]) {
      const found = errors(`policy: { rego: policy, ${key}: x }`);
      expect(found.map((p) => p.key)).toEqual([`policy.${key}`]);
      expect(found[0]!.message).toContain("is not a plywood key");
    }
  });

  it("refuses a git-ref source on a chant without chant#4613's ci.policy.source", () => {
    setChantPolicySourceForTests(false);
    const found = errors("policy: { source: { repo: https://git.acme.internal/policy.git, ref: v1 } }");
    expect(found.map((p) => p.key)).toEqual(["policy.source"]);
    expect(found[0]!.message).toContain("chant#4613");
    setChantPolicySourceForTests("reset");
  });

  it("refuses paths outside the repository, a command without {input}, an unknown engine and a pack listed twice", () => {
    expect(errors("policy: { rego: ../shared }")[0]!.key).toBe("policy.rego");
    expect(errors("policy: { rego: /etc/policy }")[0]!.key).toBe("policy.rego");
    expect(errors("policy: { packs: [--evil] }")[0]!.key).toBe("policy.packs.0");
    expect(errors("policy: { packs: [{ config: x.json }] }").map((p) => p.key)).toContain("policy.packs.0.dir");
    expect(errors('policy: { command: ["opa", "eval"] }')[0]!.key).toBe("policy.command");
    expect(errors("policy: { engine: sentinel }")[0]!.key).toBe("policy.engine");
    expect(errors("policy: { packs: [guard, ./guard/] }")[0]!.message).toContain("more than once");
    expect(errors('policy: { rego: policy, command: ["conftest", "test", "{input}"], packs: [guard] }')).toEqual([]);
  });
});

describe("packs in each stack's pulumi-up step", () => {
  it("makes each pack's path relative to the stack's directory, where the engine runs", () => {
    const packs = policyPacksOf(parseConfig("policy: { packs: [policy/guard, { dir: policy/tags, config: policy/tags.json }] }").doc);
    expect(packsForStack(packs, ".")).toEqual([{ dir: "policy/guard" }, { dir: "policy/tags", config: "policy/tags.json" }]);
    expect(packsForStack(packs, "infra/shop")).toEqual([{ dir: "../../policy/guard" }, { dir: "../../policy/tags", config: "../../policy/tags.json" }]);
    expect(packsForStack([{ dir: "-x" }], ".")).toEqual([{ dir: "./-x" }]);
  });

  it("writes policyPacks into the step input and the components file", () => {
    const stack = { key: "shop/dev", project: "shop", stack: "dev", dir: "infra", policyPacks: [{ dir: "../policy/guard" }] };
    expect(stepInput(stack)).toEqual({ dir: "infra", stack: "dev", member: "shop", policyPacks: [{ dir: "../policy/guard" }] });
    expect(componentsFile([stack])).toContain('"policyPacks":[{"dir":"../policy/guard"}]');
    expect(stepInput({ ...stack, policyPacks: [] })).not.toHaveProperty("policyPacks");
  });
});

describe("policy words", () => {
  it("names a CrossGuard rule as chant's gate does, and the denial line says both rule forms", () => {
    expect(crossGuardRuleId("aws-guard", "no-public-bucket")).toBe("crossguard.aws-guard.no-public-bucket");
    expect(refusalOf(FALLBACK_EXIT.denied, FALLBACK_EXIT)).toBe("denied");
    expect(refusalLine("denied")).toContain("crossguard.<pack>.<policy>");
  });
});

/**
 * The fixture pack's preview stream, read by chant's pulumi lexicon: the
 * mandatory rule denies and the advisory one is a warning (a note line).
 * Skipped on a lexicon without `pulumiPolicyFindings` (an older chant).
 */
describe("the fixture pack's findings through chant", async () => {
  let lexicon: Record<string, unknown> | undefined;
  try {
    // @ts-ignore: the pinned lexicon may lack these exports (chant#4541).
    lexicon = (await import("@intentius/chant-lexicon-pulumi")) as Record<string, unknown>;
  } catch {
    lexicon = undefined;
  }
  const findings = lexicon?.pulumiPolicyFindings as ((v: unknown) => { denials: Array<{ rule: string }>; warnings: string[] }) | undefined;
  const events = lexicon?.pulumiPolicyEvents as ((s: string) => unknown) | undefined;

  it.skipIf(!findings || !events)("denies on the mandatory rule and keeps the advisory one as a note line", () => {
    const stream = readFileSync(join(FIXTURES, "preview-stream.jsonl"), "utf8");
    const f = findings!(events!(stream));
    expect(f.denials.map((d) => d.rule)).toEqual([crossGuardRuleId("aws-guard", "no-public-bucket")]);
    expect(f.warnings).toHaveLength(1);
    expect(f.warnings[0]).toContain(crossGuardRuleId("aws-guard", "tagged"));
  });

  it("the Rego fixture has a deny rule and a hold rule, the names chant's gate counts", () => {
    const rego = readFileSync(join(FIXTURES, "rego/plywood.rego"), "utf8");
    expect(rego).toMatch(/^deny_[a-z_]+ contains/m);
    expect(rego).toMatch(/^hold_[a-z_]+ contains/m);
  });
});
