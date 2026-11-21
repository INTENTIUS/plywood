/**
 * The agents a production alert, a failed update on merge and a schedule
 * start (plywood#157), from plywood.yml's `agent`. Each is chant's agent job
 * in a workflow of its own (`productAlertAgent`, `productApplyFailedAgent`
 * and `productScheduleAgent`, chant#5329 and chant#5357); plywood maps its
 * keys onto chant's settings and writes the Op spec chant's generator reads.
 *
 *   agent.alert        .chant/ops/plywood-alert-agent.spec.json, the Op file
 *                      ops/plywood-alert-agent.op.ts, and its workflow. The
 *                      relay (`chant notify relay`) records an alert as a
 *                      fact and starts the workflow; the workflow also runs
 *                      every 15 minutes and picks up a start that did not
 *                      arrive
 *   agent.apply-failed the same for plywood-apply-failed-agent, and the wave
 *                      jobs record each failed update as a fact: the waves
 *                      spec's `options.agentFacts` (src/waves-workflow.ts)
 *   agent.schedule     plywood-schedule-agent, on agent.schedule.cron
 *   agent.max_runs, agent.command, agent.key_env, agent.timeout, agent.token_env
 *                      as for the comment agent, one limit for each agent's runs
 *
 * An agent opens a pull request from plywood/agent/<op>-<member> and never
 * applies, approves or merges. Nothing here runs unless its key is set.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { agentOpSpec, agentWords, chantAgentOptions, writeIfChanged, OP_OUTPUT_DIR } from "./agent-jobs";
import type { ChantProduct, ForgeKind } from "./chant-product";
import { agentOf, type AgentSettings } from "./config/agents";
import type { RawConfig } from "./config/index";
import type { ExitTable } from "./exit-codes";
import type { StageIo } from "./stages";
import { PRODUCT, type ProductWordsInput } from "./words";

export type FactTrigger = "alert" | "apply-failed" | "schedule";

/** What each trigger is called in chant, and in the files plywood writes. */
export const TRIGGER_OPS: Readonly<Record<FactTrigger, { op: string; overview: string }>> = {
  alert: { op: "plywood-alert-agent", overview: "A model opens a pull request for a production alert the relay recorded" },
  "apply-failed": { op: "plywood-apply-failed-agent", overview: "A model opens a pull request for an update that failed on merge" },
  schedule: { op: "plywood-schedule-agent", overview: "A model does a recurring task and opens a pull request" },
};

export const triggerSpecFile = (t: FactTrigger): string => `.chant/ops/${TRIGGER_OPS[t].op}.spec.json`;
export const triggerOpFile = (t: FactTrigger): string => `ops/${TRIGGER_OPS[t].op}.op.ts`;

/** The triggers plywood.yml turns on, in a fixed order. */
export function factTriggersOn(a: AgentSettings | undefined): FactTrigger[] {
  return [...(a?.alert ? ["alert" as const] : []), ...(a?.applyFailed ? ["apply-failed" as const] : []), ...(a?.schedule ? ["schedule" as const] : [])];
}

/** The relay key's secret the apply jobs and the apply-failed agent share: the one agent.apply-failed names, else chant's default. */
export function applyFailedFacts(a: AgentSettings | undefined): { relayKeyEnv?: string } | undefined {
  if (!a?.applyFailed) return undefined;
  return a.applyFailed.relayKeyEnv !== undefined ? { relayKeyEnv: a.applyFailed.relayKeyEnv } : {};
}

/** A trigger's Op file: the Op chant's generator discovers the workflow's name from. */
export function triggerOpFileText(t: FactTrigger): string {
  const { op, overview } = TRIGGER_OPS[t];
  return [
    `// Written by '${PRODUCT} ci' from plywood.yml's agent.${t} key, and written again on each run: edit plywood.yml, not this file.`,
    `// The workflow runs chant's agent jobs under this Op's name and records its runs under ${op}.`,
    `// chant's generator needs the Op to exist. The agent's jobs are chant's and do not run this phase.`,
    `import { Op, phase, shell } from "@intentius/chant/op";`,
    "",
    "export default Op({",
    `  name: ${JSON.stringify(op)},`,
    `  overview: ${JSON.stringify(overview)},`,
    "  phases: [",
    `    phase("Agent", [shell(${JSON.stringify(`echo "${op} runs from its workflow"`)})]),`,
    "  ],",
    "});",
    "",
  ].join("\n");
}

/** chant's Op spec for one trigger, from plywood.yml's `agent`. */
export function triggerSpec(chant: ChantProduct, t: FactTrigger, a: AgentSettings, doc: RawConfig, words: ProductWordsInput): Record<string, unknown> {
  const base = { name: TRIGGER_OPS[t].op, ...chantAgentOptions(a, doc) };
  if (t === "schedule") {
    const s = a.schedule!;
    return chant.productScheduleAgent(words, { ...base, schedule: s.cron, task: s.task, ...(s.window !== undefined ? { window: s.window } : {}) });
  }
  const f = (t === "alert" ? a.alert : a.applyFailed)!;
  const options = { ...base, ...(f.window !== undefined ? { window: f.window } : {}), ...(f.relayKeyEnv !== undefined ? { relayKeyEnv: f.relayKeyEnv } : {}) };
  return t === "alert" ? chant.productAlertAgent(words, options) : chant.productApplyFailedAgent(words, options);
}

/**
 * The jobs of each trigger plywood.yml turns on, for `plywood ci`: the Op
 * file, the spec and chant's generated workflow. Returns chant's exit code
 * when the generator fails.
 */
export async function writeTriggerAgentJobs(chant: ChantProduct, forge: ForgeKind, doc: RawConfig, words: ProductWordsInput, table: ExitTable, io: StageIo): Promise<number> {
  const a = agentOf(doc);
  const triggers = factTriggersOn(a);
  if (!a || triggers.length === 0) return table.done;
  const forAgent = agentWords(words);
  const outDir = OP_OUTPUT_DIR[forge];
  for (const t of triggers) {
    let spec: Record<string, unknown>;
    try {
      spec = triggerSpec(chant, t, a, doc, forAgent);
    } catch (e) {
      io.err(`${PRODUCT} ci: agent.${t}: ${(e as Error).message}`);
      return table.failed;
    }
    const specFile = triggerSpecFile(t);
    if (writeIfChanged(io.cwd, triggerOpFile(t), triggerOpFileText(t))) io.err(`${PRODUCT} ci: wrote ${triggerOpFile(t)}; commit it with the workflow`);
    if (writeIfChanged(io.cwd, specFile, JSON.stringify(agentOpSpec(spec, doc), null, 2) + "\n")) io.err(`${PRODUCT} ci: wrote ${specFile}`);
    const code = await chant.runChantInProcess(["run", "--generate", forge, "--spec", specFile, "--output", outDir], forAgent);
    if (code !== table.done) return code;
    const dir = join(io.cwd, outDir);
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && (readFileSync(join(dir, f), "utf8").split("\n", 1)[0] ?? "").includes(`--spec ${specFile}`))
      : [];
    for (const f of files) io.err(`${PRODUCT} ci: agent.${t} workflow at ${join(outDir, f).replace(/^\.\//, "")}`);
    io.err(...noteFor(t, a, forge));
  }
  io.err(`${PRODUCT} ci: each agent job reads the model's key from ${a.keyEnv}; set it from a secret${a.maxRuns === undefined ? ", and set agent.max_runs to limit how often an agent runs" : ""}`);
  return table.done;
}

/** What the person setting up a trigger still has to do outside plywood.yml. */
function noteFor(t: FactTrigger, a: AgentSettings, forge: ForgeKind): [string] {
  const key = (t === "schedule" ? undefined : (t === "alert" ? a.alert : a.applyFailed)?.relayKeyEnv) ?? "CHANT_RELAY_KEY";
  if (t === "alert") return [`${PRODUCT} ci: agent.alert reads the alerts the relay recorded; point an alert source at the relay's POST /alert/<source> (chant's notify guide), and set ${key} from a secret${forge === "gitlab" ? ", and guard each job of .gitlab-ci.yml against the relay's trigger pipeline" : ""}`];
  if (t === "apply-failed") return [`${PRODUCT} ci: agent.apply-failed reads the failures the merge's wave jobs record; set ${key} from a secret for the wave jobs and the agent`];
  return [`${PRODUCT} ci: agent.schedule runs on ${a.schedule!.cron}`];
}
