import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_NEEDS_CHANT, AGENT_OP, AGENT_SPEC_FILE, agentGuarded, chantAgentOptions, driftOpFields, stageRunner, writeAgentJobs } from "../src/agent-jobs";
import { agentOf } from "../src/config/agents";
import type { ChantProduct, ProductPipelineOptions } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { driftOpSpec } from "../src/drift";
import { FALLBACK_EXIT } from "../src/exit-codes";
import type { StageIo } from "../src/stages";
import { PRODUCT_WORDS } from "../src/words";

/** A fake chant with the agent job (chant#4616), or without it. */
function fakeChant(agent = true) {
  const calls: Array<{ argv: string[] }> = [];
  const options: ProductPipelineOptions[] = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: (_forge, _env, o) => {
      options.push(o);
      const settings = typeof o.agent === "object" ? o.agent : {};
      const { name, ...rest } = settings as { name?: string };
      return {
        words: { product: "plywood", stages: {}, commands: {}, prGate: "up" },
        plan: { jobName: "plan", command: "" },
        post: { command: "" },
        comments: { agent: "/plywood agent" },
        agent: { comment: "/plywood agent", name: name ?? "plywood-agent", spec: { name: name ?? "plywood-agent", trigger: { kind: "pull_request" }, agent: { on: "comment", comment: "/plywood agent", ...rest } } },
      };
    },
    approveLine: () => "",
    runChantInProcess: async (argv) => (calls.push({ argv }), 0),
    ...(agent ? { CI_AGENT_FLOOR: "0.124.55", productDriftAgent: (_w, _op, o) => ({ on: "drift", ...(o ?? {}) }) } : {}),
  };
  return { api, calls, options };
}

function io(cwd: string): StageIo & { stderr: string[] } {
  const stderr: string[] = [];
  return { stderr, cwd, env: {}, out: () => {}, err: (s) => stderr.push(s) };
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-agent-jobs-"));
  mkdirSync(join(dir, ".git"));
  return dir;
}

const YML = "stacks: { shop/dev: { dir: infra } }\nagent: { comment: true, drift: true, key_env: FAKE_KEY, timeout: 20, max_runs: 3 }\nrespond: { drift: pull-request }\ndrift: { schedule: '0 6 * * *' }\nrunners: { default: self-hosted, drift: [self-hosted, drift] }\n";

describe("the comment agent on chant's agent job", () => {
  it("passes plywood's agent keys to productPipelineJobs and generates the spec it returns", async () => {
    const chant = fakeChant();
    const dir = repo();
    const code = await writeAgentJobs(chant.api, "github", "production", parseConfig(YML).doc, PRODUCT_WORDS, FALLBACK_EXIT, io(dir));
    expect(code).toBe(FALLBACK_EXIT.done);
    expect(chant.options[0]!.agent).toEqual({ name: AGENT_OP, keyEnv: "FAKE_KEY", timeout: 20, maxRuns: 3, guarded: ["plywood.yml", "plywood.yaml"] });
    const spec = JSON.parse(readFileSync(join(dir, AGENT_SPEC_FILE), "utf8"));
    expect(spec.ops[0]).toMatchObject({ name: AGENT_OP, agent: { on: "comment", comment: "/plywood agent", maxRuns: 3 }, runner: "self-hosted" });
    expect(chant.calls[0]!.argv).toEqual(["run", "--generate", "github", "--spec", AGENT_SPEC_FILE, "--output", ".github/workflows"]);
  });

  it("writes nothing on a chant without the agent job, and says so", async () => {
    const chant = fakeChant(false);
    const out = io(repo());
    await writeAgentJobs(chant.api, "github", "production", parseConfig(YML).doc, PRODUCT_WORDS, FALLBACK_EXIT, out);
    expect(chant.calls).toEqual([]);
    expect(out.stderr.join("\n")).toContain(AGENT_NEEDS_CHANT);
  });

  it("keeps the policy directory out of the agent's reach", () => {
    expect(agentGuarded(parseConfig("policy: { rego: policy/rego }\n").doc)).toEqual(expect.arrayContaining(["plywood.yml"]));
  });

  it("no longer warns that no job answers the agent", () => {
    const warnings = checkConfig(parseConfig("agent: { comment: true, max_runs: 2 }\n")).filter((p) => p.key === "agent");
    expect(warnings).toEqual([]);
  });
});

describe("the drift agent and the drift runner", () => {
  it("puts chant's drift agent and the drift runner on each drift Op, and keeps the issue", () => {
    const doc = parseConfig(YML).doc;
    const spec = driftOpSpec(doc, "github", ["shop/dev"], "0 6 * * *", fakeChant().api);
    expect(spec.ops[0]).toMatchObject({ findingMode: "issue", runner: ["self-hosted", "drift"], agent: { on: "drift", maxRuns: 3, keyEnv: "FAKE_KEY" } });
  });

  it("leaves the spec as it was on a chant without the agent job", () => {
    const doc = parseConfig(YML).doc;
    const spec = driftOpSpec(doc, "github", ["shop/dev"], "0 6 * * *", fakeChant(false).api);
    expect(spec.ops[0]).toEqual({ name: expect.any(String), trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "pull-request" });
    expect(driftOpFields(undefined, doc, "x", "pull-request")).toEqual({});
  });

  it("the runner is the stage's, else the default, else the one runner", () => {
    expect(stageRunner("ci", "drift")).toBe("ci");
    expect(stageRunner({ default: "a", drift: "b" }, "drift")).toBe("b");
    expect(stageRunner({ default: "a" }, "drift")).toBe("a");
    expect(stageRunner(undefined, "drift")).toBeUndefined();
  });
});

describe("agent.token_env (chant#4616's push token)", () => {
  it("maps onto chant's tokenEnv, and is left out when unset", () => {
    const doc = parseConfig("agent:\n  comment: true\n  max_runs: 5\n  token_env: PLYWOOD_AGENT_TOKEN\n").doc;
    expect(chantAgentOptions(agentOf(doc)!, doc)).toMatchObject({ tokenEnv: "PLYWOOD_AGENT_TOKEN" });
    const plain = parseConfig("agent:\n  comment: true\n  max_runs: 5\n").doc;
    expect(chantAgentOptions(agentOf(plain)!, plain)).not.toHaveProperty("tokenEnv");
  });

  it("names a variable, never the token", () => {
    const problems = checkConfig(parseConfig("agent:\n  comment: true\n  max_runs: 5\n  token_env: ghp_abc-123\n")).filter((p) => p.severity === "error");
    expect(problems.map((p) => p.key)).toContain("agent.token_env");
  });
});
