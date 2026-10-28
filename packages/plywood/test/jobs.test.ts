/**
 * env, pass, parallelism and environments (plywood#29): the checks, and the
 * translation onto the waves spec, the drift Ops, the pull request jobs and
 * the forge check. No chant runs; chant#4625 is stood in either way.
 */
import { afterEach, describe, expect, it } from "vitest";
import { toChantSettings, type ChantRunner } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { driftJobFields } from "../src/drift";
import { contractPipelines } from "../src/identities";
import {
  environmentFor,
  jobVariables,
  prJobsFor,
  prLoopJobFlags,
  prLoopJobOptions,
  secretReference,
  setChant4625ForTests,
  withJobSettings,
} from "../src/jobs";

const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error").map((p) => `${p.key}: ${p.message}`);
const jobsOf = (text: string) => toChantSettings(parseConfig(text)).pipeline.jobs!;

const YML = [
  "stacks: { shop/dev: { dir: infra }, shop/prod-us: { dir: infra }, shop/prod-eu: { dir: infra } }",
  "env: { AWS_REGION: us-east-1, RETRIES: 3 }",
  "pass: [DATADOG_API_KEY]",
  "parallelism: 2",
  "environments: { 'shop/prod-us': { name: production-us, url: https://us.example.com }, 'shop/prod-*': production }",
  "",
].join("\n");

const spec = () => ({
  name: "pulumi-up",
  step: { kind: "pulumi-up" },
  waves: [
    { name: "dev", runs: [{ target: "shop/dev" }] },
    { name: "prod", runs: [{ target: "shop/prod-us" }, { target: "shop/prod-eu" }] },
  ],
});

afterEach(() => setChant4625ForTests("reset"));

describe("the checks", () => {
  it("takes the four keys, which no longer read as later", () => {
    expect(errors(YML)).toEqual([]);
    const s = jobsOf(YML);
    expect(s).toEqual({
      variables: { AWS_REGION: "us-east-1", RETRIES: "3" },
      secrets: { DATADOG_API_KEY: "DATADOG_API_KEY" },
      parallelism: 2,
      environments: [
        { glob: "shop/prod-us", environment: { name: "production-us", url: "https://us.example.com" } },
        { glob: "shop/prod-*", environment: { name: "production" } },
      ],
    });
  });

  it("refuses a bad name, a forge token, a value under pass, a bad parallelism and environments on Forgejo", () => {
    expect(errors("env: { 1BAD: x }\n")).toEqual([expect.stringContaining("env.1BAD: \"1BAD\" is not a variable name")]);
    expect(errors("pass: { GITHUB_TOKEN: MY_PAT }\n")).toEqual([expect.stringContaining("pass.GITHUB_TOKEN: GITHUB_TOKEN is a name the jobs set or drop themselves")]);
    expect(errors("pass: { API_KEY: 'sk-live 123' }\n")).toEqual([expect.stringContaining("is not a secret name")]);
    expect(errors("env: { API_KEY: x }\npass: [API_KEY]\n")).toEqual([expect.stringContaining("a value or a passed secret, not both")]);
    expect(errors("parallelism: 0\n")).toEqual(["parallelism: must be a whole number of 1 or more"]);
    expect(errors("forge: { kind: forgejo }\nenvironments: { '*': production }\n")).toEqual([expect.stringContaining("Forgejo has no deployment environments")]);
  });

  it("warns on a glob that matches no stack", () => {
    const warnings = checkConfig(parseConfig("stacks: { shop/dev: {} }\nenvironments: { 'other/*': production }\n")).filter((p) => p.severity === "warning");
    expect(warnings.map((w) => w.key)).toEqual(["environments.other/*"]);
  });
});

describe("variables and secrets", () => {
  it("a passed secret is the forge's reference, never a value", () => {
    expect(secretReference("github", "DD")).toBe("${{ secrets.DD }}");
    expect(secretReference("gitlab", "DD")).toBe("$DD");
    const s = jobsOf("pass: { DD_KEY: DATADOG_API_KEY, TOKEN: TOKEN }\n");
    expect(jobVariables("forgejo", s)).toEqual({ DD_KEY: "${{ secrets.DATADOG_API_KEY }}", TOKEN: "${{ secrets.TOKEN }}" });
    // GitLab jobs have every CI/CD variable already, so one under its own name needs no line.
    expect(jobVariables("gitlab", s)).toEqual({ DD_KEY: "$DATADOG_API_KEY" });
  });
});

describe("the waves spec", () => {
  it("each wave takes the variables; one environment goes on the wave, two split it into groups; parallelism with chant#4625", () => {
    const out = withJobSettings(spec(), jobsOf(YML), "github", { parallelism: true }) as { parallelism?: number; waves: Array<Record<string, unknown>> };
    expect(out.parallelism).toBe(2);
    expect(out.waves[0]).toEqual({ name: "dev", runs: [{ target: "shop/dev" }], variables: { AWS_REGION: "us-east-1", RETRIES: "3", DATADOG_API_KEY: "${{ secrets.DATADOG_API_KEY }}" } });
    expect(out.waves[1]!.environment).toBeUndefined();
    expect(out.waves[1]!.groups).toEqual([
      { name: "production-us", runs: ["shop/prod-us"], environment: { name: "production-us", url: "https://us.example.com" } },
      { name: "production", runs: ["shop/prod-eu"], environment: { name: "production" } },
    ]);
  });

  it("stacks sharing an environment run in it, and a chant without chant#4625 gets no parallelism", () => {
    const s = jobsOf("environments: { 'shop/prod-*': production }\nparallelism: 3\n");
    const out = withJobSettings(spec(), s, "gitlab", { parallelism: false }) as { parallelism?: number; waves: Array<Record<string, unknown>> };
    expect(out.parallelism).toBeUndefined();
    expect(out.waves[1]).toMatchObject({ environment: { name: "production" } });
    expect(out.waves[1]!.groups).toBeUndefined();
    expect(out.waves[0]!.environment).toBeUndefined();
  });

  it("a wave split into shares cannot split by environment too", () => {
    const shared = spec();
    (shared.waves[1] as Record<string, unknown>).shares = 2;
    expect(() => withJobSettings(shared, jobsOf(YML), "github", { parallelism: true })).toThrow(/wave prod holds stacks in 2 environments and is split into 2 shares/);
  });

  it("the first glob that matches wins", () => {
    const s = jobsOf(YML);
    expect(environmentFor("shop/prod-us", s)?.name).toBe("production-us");
    expect(environmentFor("shop/prod-eu", s)?.name).toBe("production");
    expect(environmentFor("shop/dev", s)).toBeUndefined();
  });
});

describe("the drift Ops", () => {
  it("each stack's Op takes the variables and its environment, none on Forgejo", () => {
    const s = jobsOf(YML);
    expect(driftJobFields("github", s, "shop/prod-eu")).toEqual({
      variables: { AWS_REGION: "us-east-1", RETRIES: "3", DATADOG_API_KEY: "${{ secrets.DATADOG_API_KEY }}" },
      environment: { name: "production" },
    });
    expect(driftJobFields("forgejo", s, "shop/prod-eu")).not.toHaveProperty("environment");
    expect(driftJobFields("github", undefined, "shop/dev")).toEqual({});
  });
});

describe("the pull request jobs (chant#4625)", () => {
  const runner: ChantRunner = { default: "self-hosted", preview: ["self-hosted", "small"], up: { group: "deployers" } };

  it("maps preview to plan and up to apply, and writes the build flags", () => {
    const s = jobsOf(YML);
    expect(prLoopJobOptions(s, runner)).toEqual({
      runners: { plan: ["self-hosted", "small"], apply: { group: "deployers" }, default: "self-hosted" },
      variables: { AWS_REGION: "us-east-1", RETRIES: "3" },
      secrets: { DATADOG_API_KEY: "DATADOG_API_KEY" },
      parallelism: 2,
    });
    const { flags, notes } = prLoopJobFlags(s, runner);
    expect(flags).toEqual([
      "--pr-runner", "plan=self-hosted,small",
      "--pr-runner", "default=self-hosted",
      "--pr-variable", "AWS_REGION=us-east-1",
      "--pr-variable", "RETRIES=3",
      "--pr-secret", "DATADOG_API_KEY=DATADOG_API_KEY",
      "--parallelism", "2",
    ]);
    expect(notes).toEqual([expect.stringContaining("runner group deployers is GitHub's")]);
  });

  it("with chant#4625 the options and flags go to chant; without it plywood says which keys wait", async () => {
    const pipeline = toChantSettings(parseConfig(YML)).pipeline;
    setChant4625ForTests(true);
    expect((await prJobsFor(pipeline)).flags).toContain("--parallelism");
    setChant4625ForTests(false);
    const without = await prJobsFor(pipeline);
    expect(without).toMatchObject({ options: {}, flags: [] });
    expect(without.notes).toEqual([expect.stringContaining("env, pass, parallelism on the pull request jobs needs chant's runners")]);
    expect(await prJobsFor({})).toEqual({ options: {}, flags: [], notes: [] });
  });
});

describe("the forge check", () => {
  it("each up job's forgeEnvironment, matched on <member>/<env>", () => {
    const fc = { resolveCloudIdentity: () => ({ aws: { apply: "arn:aws:iam::1:role/x" } }) };
    const s = jobsOf("environments: { 'shop/production': production, 'web/*': web-prod }\n");
    expect(contractPipelines(fc, {}, "production", ["shop", "web", "api"], undefined, s).map((p) => [p.name, p.forgeEnvironment])).toEqual([
      ["shop/production", "production"],
      ["web/production", "web-prod"],
      ["api/production", undefined],
    ]);
  });
});
