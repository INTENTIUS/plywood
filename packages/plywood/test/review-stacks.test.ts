import { afterEach, describe, expect, it } from "vitest";
import type { ChantProduct } from "../src/chant-product";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { reviewStackName } from "../src/config/review-stacks";
import { chantReviewStacks, REVIEW_GATE, reviewSuffixOf, setChantReviewStacksForTests } from "../src/review-stacks";
import { componentsFile } from "../src/init/render";
import { workflowPlan } from "../src/stages";
import { approveTarget } from "../src/up";
import type { PRODUCT_WORDS } from "../src/words";

const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

/** A fake chant product: the jobs chant would name for the words, nothing generated. */
const chant = {
  assertProductWords: (w: unknown) => w,
  productPipelineJobs: (_f: string, _e: string, o: { words: typeof PRODUCT_WORDS }) => ({
    words: { ...o.words },
    plan: { jobName: "plan", command: "npx --no-install plywood components pr-plan --gate up" },
    post: { command: "npx --no-install plywood components pr-post" },
    comments: {},
  }),
  approveLine: () => "",
  runChantInProcess: async () => 0,
} as unknown as ChantProduct;

afterEach(() => setChantReviewStacksForTests("reset"));

describe("review_stacks", () => {
  it("names each review stack pr-{number}, with an optional suffix, and refuses any other pattern", () => {
    expect(errors("review_stacks: { template: shop/dev }")).toEqual([]);
    expect(errors("review_stacks: { template: shop/dev, name: pr-{number}-shop, ttl: 72h }")).toEqual([]);
    for (const name of ["review-{number}", "{number}", "pr-{number}/x", "prod", "pr-{number}-Shop"]) {
      expect(errors(`review_stacks: { template: shop/dev, name: "${name}" }`).map((p) => p.key), name).toEqual(["review_stacks.name"]);
    }
    expect(reviewStackName("pr-{number}-shop", 42)).toBe("pr-42-shop");
  });

  it("needs the template as project/stack, and warns when stacks does not list it", () => {
    expect(errors("review_stacks: { template: dev }")[0]!.key).toBe("review_stacks.template");
    const problems = checkConfig(parseConfig("stacks:\n  shop/dev: { dir: infra }\nreview_stacks: { template: shop/staging }\n"));
    expect(problems).toEqual([expect.objectContaining({ key: "review_stacks.template", severity: "warning" })]);
  });

  it("becomes chant's ci.prEnvironment with the TTL", () => {
    const s = toChantSettings(parseConfig("review_stacks: { template: shop/dev, ttl: 7d }"));
    expect(s.ci.prEnvironment).toEqual({ template: "shop/dev", ttl: "7d" });
    expect(s.pipeline.reviewStackName).toBe("pr-{number}");
  });
});

describe("plywood approve review", () => {
  it("is chant's pr-env gate under the pull request's op", () => {
    expect(approveTarget("review", { pr: "12" })).toEqual({ op: "pr-12", gate: REVIEW_GATE });
    expect(approveTarget("pr-env", { pr: "12" })).toEqual({ op: "pr-12", gate: "pr-env" });
    expect(approveTarget("review", {})).toEqual({ error: expect.stringContaining("--pr <n>") });
  });
});

describe("the review stack jobs", () => {
  const doc = parseConfig("review_stacks: { template: shop/dev }").doc;

  it("go on chant's build with --pr-env once the pulumi lexicon can remove a review stack", async () => {
    setChantReviewStacksForTests(true);
    expect(workflowPlan(chant, doc, "github", "production", undefined, [], { reviewStacks: await chantReviewStacks() }).argv).toContain("--pr-env");
  });

  it("stay off on a lexicon without the review stack argv, and with no review_stacks", async () => {
    setChantReviewStacksForTests(false);
    expect(workflowPlan(chant, doc, "github", "production", undefined, [], { reviewStacks: await chantReviewStacks() }).argv).not.toContain("--pr-env");
    expect(workflowPlan(chant, {}, "github", "production", undefined, [], { reviewStacks: true }).argv).not.toContain("--pr-env");
  });
});

describe("review stacks end to end (chant#4609)", () => {
  it("takes review_stacks.name's suffix as the step's reviewSuffix", () => {
    expect(reviewSuffixOf("pr-{number}-shop")).toBe("shop");
    expect(reviewSuffixOf("pr-{number}")).toBeUndefined();
    expect(reviewSuffixOf(undefined)).toBeUndefined();
  });

  it("writes reviewSuffix on each pulumi-up step only when asked", () => {
    const stacks = [{ key: "shop/dev", project: "shop", stack: "dev", dir: "infra" }] as never;
    expect(componentsFile(stacks, {}, { reviewSuffix: "shop" })).toContain('"reviewSuffix":"shop"');
    expect(componentsFile(stacks)).not.toContain("reviewSuffix");
  });
});
