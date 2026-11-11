import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { CHANT_DEFAULTS } from "./chant-defaults";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AGENT_OP, AGENT_OP_FILE, AGENT_SPEC_FILE, agentGuarded, agentOpFile, agentWords, chantAgentOptions, driftOpFields, stageRunner, writeAgentJobs } from "../src/agent-jobs";
import { chantProduct, setChantProductForTests } from "../src/chant-product";
import { agentOf } from "../src/config/agents";
import type { ChantProduct, ProductPipelineOptions } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { driftOpSpec } from "../src/drift";
import { EXIT } from "../src/exit-codes";
import type { StageIo } from "../src/stages";
import { PRODUCT_WORDS } from "../src/words";

/** A fake chant with the agent job (chant#4616). */
function fakeChant() {
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
    ...CHANT_DEFAULTS,
    runChantInProcess: async (argv) => (calls.push({ argv }), 0),
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
    const code = await writeAgentJobs(chant.api, "github", "production", parseConfig(YML).doc, PRODUCT_WORDS, EXIT, io(dir));
    expect(code).toBe(EXIT.done);
    expect(chant.options[0]!.agent).toEqual({ name: AGENT_OP, keyEnv: "FAKE_KEY", timeout: 20, maxRuns: 3, guarded: ["plywood.yml", "plywood.yaml"] });
    const spec = JSON.parse(readFileSync(join(dir, AGENT_SPEC_FILE), "utf8"));
    expect(spec.ops[0]).toMatchObject({ name: AGENT_OP, agent: { on: "comment", comment: "/plywood agent", maxRuns: 3 }, runner: "self-hosted" });
    expect(chant.calls[0]!.argv).toEqual(["run", "--generate", "github", "--spec", AGENT_SPEC_FILE, "--output", ".github/workflows"]);
  });

  it("hands chant only the words the agent's pipeline answers, and writes the Op file before the generator runs", async () => {
    const chant = fakeChant();
    const dir = repo();
    const err = io(dir);
    expect(await writeAgentJobs(chant.api, "github", "production", parseConfig(YML).doc, PRODUCT_WORDS, EXIT, err)).toBe(EXIT.done);
    expect(chant.options[0]!.words.commands).toEqual({ preview: "plan", agent: "agent" });
    expect(agentWords(PRODUCT_WORDS).commands).toEqual({ preview: "plan", agent: "agent" });
    expect(readFileSync(join(dir, AGENT_OP_FILE), "utf8")).toBe(agentOpFile());
    expect(agentOpFile()).toContain(`  name: "${AGENT_OP}",`);
    expect(err.stderr).toContain(`plywood ci: wrote ${AGENT_OP_FILE}; commit it with the workflow`);
  });

  it("keeps the policy directory out of the agent's reach", () => {
    expect(agentGuarded(parseConfig("policy: { rego: policy/rego }\n").doc)).toEqual(expect.arrayContaining(["plywood.yml"]));
  });

  it("no longer warns that no job answers the agent", () => {
    const warnings = checkConfig(parseConfig("agent: { comment: true, max_runs: 2 }\n")).filter((p) => p.key === "agent");
    expect(warnings).toEqual([]);
  });
});

describe("the comment agent against the installed chant (plywood#43)", () => {
  it("writes the agent's workflow with no refused words and no unknown Op", async () => {
    setChantProductForTests("reset");
    const real = await chantProduct();
    const dir = mkdtempSync(join(tmpdir(), "plywood-agent-real-"));
    execFileSync("git", ["init", "-q", dir]);
    const doc = parseConfig("stacks: { shop/dev: { dir: infra } }\nagent: { comment: true, max_runs: 3 }\n").doc;
    const was = process.cwd();
    process.chdir(dir);
    const out = io(dir);
    try {
      const code = await writeAgentJobs(real, "github", "production", doc, PRODUCT_WORDS, EXIT, out);
      const said = out.stderr.join("\n");
      expect(said).not.toContain("refused");
      expect(said).not.toContain("Unknown Op");
      expect(code).toBe(EXIT.done);
      expect(said).toContain("agent jobs at .github/workflows/");
    } finally {
      process.chdir(was);
    }
  }, 60_000);
});

describe("the drift agent and the drift runner", () => {
  it("puts chant's drift agent and the drift runner on each drift Op, and keeps the issue", () => {
    const doc = parseConfig(YML).doc;
    const spec = driftOpSpec(doc, "github", ["shop/dev"], "0 6 * * *", fakeChant().api);
    expect(spec.ops[0]).toMatchObject({ findingMode: "issue", runner: ["self-hosted", "drift"], agent: { on: "drift", maxRuns: 3, keyEnv: "FAKE_KEY" } });
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
