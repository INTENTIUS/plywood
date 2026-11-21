import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TRIGGER_OPS, factTriggersOn, triggerOpFile, triggerOpFileText, triggerSpecFile, writeTriggerAgentJobs } from "../src/agent-triggers";
import { chantProduct, setChantProductForTests } from "../src/chant-product";
import { agentOf } from "../src/config/agents";
import { checkConfig, parseConfig } from "../src/config/index";
import { EXIT } from "../src/exit-codes";
import type { StageIo } from "../src/stages";
import { agentFactsArgv } from "../src/stages";
import { ci } from "../src/stages";
import { wavesEngine, wavesSpecText } from "../src/waves-workflow";
import { PRODUCT_WORDS } from "../src/words";
import { CHANT_DEFAULTS } from "./chant-defaults";
import type { ChantProduct } from "../src/chant-product";

const YML = [
  "stacks: { shop/dev: { dir: infra } }",
  "agent:",
  "  alert: { window: 20, relay_key_secret: PLYWOOD_RELAY_KEY }",
  "  apply-failed: true",
  "  schedule: { cron: '0 7 * * 1', task: Raise each provider pin to the newest release. }",
  "  key_env: FAKE_KEY",
  "  max_runs: 2",
  "",
].join("\n");

function io(cwd: string): StageIo & { stderr: string[] } {
  const stderr: string[] = [];
  return { stderr, cwd, env: {}, out: () => {}, err: (...s: string[]) => void stderr.push(...s) } as never;
}

function fake(calls: string[][]): ChantProduct {
  return { ...CHANT_DEFAULTS, assertProductWords: (w) => w as never, productPipelineJobs: () => ({}) as never, approveLine: () => "", runChantInProcess: async (argv) => (calls.push(argv), 0) };
}

describe("agent.alert, agent.apply-failed and agent.schedule", () => {
  it("are off when absent, and off when false", () => {
    expect(factTriggersOn(agentOf(parseConfig("agent: { comment: true }\n").doc))).toEqual([]);
    expect(factTriggersOn(agentOf(parseConfig("agent: { alert: false, apply-failed: false }\n").doc))).toEqual([]);
  });

  it("read true or a map, and the schedule's cron and task", () => {
    const a = agentOf(parseConfig(YML).doc)!;
    expect(a.alert).toEqual({ window: 20, relayKeyEnv: "PLYWOOD_RELAY_KEY" });
    expect(a.applyFailed).toEqual({});
    expect(a.schedule).toEqual({ cron: "0 7 * * 1", task: "Raise each provider pin to the newest release." });
    expect(factTriggersOn(a)).toEqual(["alert", "apply-failed", "schedule"]);
  });

  it("check their keys", () => {
    const keys = (y: string) => checkConfig(parseConfig(y)).filter((p) => p.severity === "error").map((p) => p.key);
    expect(keys("agent: { alert: { window: 0 }, schedule: { cron: '* *', task: '' } }\n")).toEqual(expect.arrayContaining(["agent.alert.window", "agent.schedule.cron", "agent.schedule.task"]));
    expect(keys("agent: { alert: { relay_key_secret: 'sk-1-2' }, apply-failed: { extra: 1 } }\n")).toEqual(expect.arrayContaining(["agent.alert.relay_key_secret", "agent.apply-failed.extra"]));
    expect(keys("agent: { alert: 3 }\n")).toContain("agent.alert");
    expect(keys(YML)).toEqual([]);
  });

  it("warn that max_runs is unset, and leave apply.when: pull-request alone", () => {
    const w = checkConfig(parseConfig("agent: { alert: true, apply-failed: true }\napply: { when: pull-request }\n")).filter((p) => p.severity === "warning").map((p) => p.key);
    expect(w).toContain("agent.max_runs");
    expect(w).not.toContain("agent.apply-failed");
  });
});

describe("the trigger agents' jobs", () => {
  it("write an Op file, a spec and a workflow for each trigger that is on, with chant's settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-triggers-157-"));
    const calls: string[][] = [];
    const out = io(dir);
    const code = await writeTriggerAgentJobs(fake(calls), "github", parseConfig(YML).doc, PRODUCT_WORDS, EXIT, out);
    expect(code).toBe(EXIT.done);
    expect(calls.map((c) => c[c.indexOf("--spec") + 1])).toEqual(["alert", "apply-failed", "schedule"].map((t) => triggerSpecFile(t as never)));
    const alert = JSON.parse(readFileSync(join(dir, triggerSpecFile("alert")), "utf8")).ops[0];
    expect(alert).toMatchObject({ name: "plywood-alert-agent", agent: { on: "alert", window: 20, relayKeyEnv: "PLYWOOD_RELAY_KEY", maxRuns: 2, keyEnv: "FAKE_KEY" } });
    const sched = JSON.parse(readFileSync(join(dir, triggerSpecFile("schedule")), "utf8")).ops[0];
    expect(sched).toMatchObject({ trigger: { schedule: "0 7 * * 1" }, agent: { on: "schedule", task: "Raise each provider pin to the newest release.", maxRuns: 2 } });
    expect(readFileSync(join(dir, triggerOpFile("alert")), "utf8")).toBe(triggerOpFileText("alert"));
    expect(out.stderr.join("\n")).not.toContain("set agent.max_runs");
  });

  it("write nothing when no trigger is on", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-triggers-157-"));
    const calls: string[][] = [];
    expect(await writeTriggerAgentJobs(fake(calls), "github", parseConfig("agent: { comment: true, max_runs: 1 }\n").doc, PRODUCT_WORDS, EXIT, io(dir))).toBe(EXIT.done);
    expect(calls).toEqual([]);
    expect(existsSync(join(dir, "ops"))).toBe(false);
  });
});

describe("agent.apply-failed on the wave jobs", () => {
  it("puts agentFacts in the waves spec's options, with the relay key's secret", () => {
    const pipeline = { agent: agentOf(parseConfig("agent: { apply-failed: { relay_key_secret: RK }, max_runs: 1 }\n").doc)! };
    expect(JSON.parse(wavesSpecText({ waves: [] }, wavesEngine(pipeline))).options).toEqual({ agentFacts: { relayKeyEnv: "RK" } });
    const plain = { agent: agentOf(parseConfig("agent: { apply-failed: true, max_runs: 1 }\n").doc)! };
    expect(JSON.parse(wavesSpecText({ waves: [] }, wavesEngine(plain))).options).toEqual({ agentFacts: {} });
    expect(wavesSpecText({ waves: [] }, wavesEngine({}))).not.toContain("agentFacts");
  });
});

describe("agent.apply-failed on the update before merge (chant#5399)", () => {
  const argv = (y: string) => agentFactsArgv(agentOf(parseConfig(y).doc));
  it("passes --agent-facts, and the relay key's secret when one is named", () => {
    expect(argv("agent: { apply-failed: true, max_runs: 1 }\n")).toEqual(["--agent-facts", "apply-failed"]);
    expect(argv("agent: { apply-failed: { relay_key_secret: RK }, max_runs: 1 }\n")).toEqual(["--agent-facts", "apply-failed", "--agent-facts-key-env", "RK"]);
  });
  it("passes nothing when agent.apply-failed is off", () => {
    expect(argv("agent: { alert: true, max_runs: 1 }\n")).toEqual([]);
    expect(agentFactsArgv(undefined)).toEqual([]);
  });
  it("reaches the pr-loop build line only with apply.when: pull-request", async () => {
    const run = async (applyWhen: string) => {
      const dir = mkdtempSync(join(tmpdir(), "plywood-facts-157-"));
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, "plywood.yml"), `stacks:\n  shop/dev: {}\nagent: { apply-failed: true, max_runs: 1 }\napply: { when: ${applyWhen} }\n`);
      const calls: string[][] = [];
      setChantProductForTests({ ...fake(calls), productPipelineJobs: (_f, _e, o) => ({ words: { ...(o.words as object), prGate: "up" }, plan: { jobName: "plan", command: "" }, post: { command: "" }, comments: {} }) as never });
      await ci(["--forge", "github"], false, EXIT, io(dir));
      setChantProductForTests("reset");
      return calls.find((c) => c[0] === "build") ?? [];
    };
    expect(await run("pull-request")).toEqual(expect.arrayContaining(["--apply-before-merge", "--agent-facts", "apply-failed"]));
    expect(await run("merge")).not.toContain("--agent-facts");
  });
});

describe("the trigger agents against the installed chant", () => {
  it("generate a workflow for each trigger", async () => {
    setChantProductForTests("reset");
    const real = await chantProduct();
    const dir = mkdtempSync(join(tmpdir(), "plywood-triggers-real-"));
    execFileSync("git", ["init", "-q", dir]);
    mkdirSync(join(dir, ".github"), { recursive: true });
    const was = process.cwd();
    process.chdir(dir);
    const out = io(dir);
    try {
      const code = await writeTriggerAgentJobs(real, "github", parseConfig(YML).doc, PRODUCT_WORDS, EXIT, out);
      const said = out.stderr.join("\n");
      expect(said).not.toContain("refused");
      expect(code).toBe(EXIT.done);
      for (const t of Object.keys(TRIGGER_OPS)) expect(said).toContain(`agent.${t} workflow at .github/workflows/${TRIGGER_OPS[t as keyof typeof TRIGGER_OPS].op}.yml`);
    } finally {
      process.chdir(was);
    }
  }, 120_000);
});
