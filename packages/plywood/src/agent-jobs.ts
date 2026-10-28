/**
 * plywood.yml's `agent` on chant's agent job (chant#4616). The job is
 * chant's: plywood maps its keys onto chant's agent settings and writes the
 * Op specs chant's generator reads.
 *
 *   agent.comment   true answers `/plywood agent <ask>`: productPipelineJobs
 *                   returns the agent's Op spec, written to
 *                   .chant/ops/plywood-agent.spec.json and generated with
 *                   `run --generate`, as the review and drift jobs are
 *   agent.drift     true, with respond.drift: pull-request, puts chant's
 *                   drift agent on each scheduled drift Op (src/drift.ts):
 *                   after a drift run, the agent opens or updates a pull
 *                   request from plywood/agent/<op>
 *   agent.command, agent.key_env, agent.timeout, agent.max_runs, agent.token_env
 *                   chant's command, keyEnv, timeout, maxRuns and tokenEnv
 *
 * The agent may not change plywood.yml or the policy directory, beside
 * chant's own guarded paths.
 *
 * Everything here is behind a feature-detect: a chant without
 * `CI_AGENT_FLOOR` on its ci-product entry gets no agent jobs, and plywood
 * says so.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toChantSettings, type ChantRunner, type ChantRunnerSpec } from "./chant-config";
import type { ChantProduct, ForgeKind } from "./chant-product";
import { agentOf, type AgentSettings } from "./config/agents";
import { CONFIG_NAMES, type RawConfig } from "./config/index";
import type { ExitTable } from "./exit-codes";
import { chantPipelineOptions } from "./images";
import type { StageIo } from "./stages";
import { PRODUCT, PRODUCT_WORDS, type ProductWordsInput } from "./words";

/** The agent's Op name: its workflow, its jobs and its runs on the ledger. */
export const AGENT_OP = "plywood-agent";
export const AGENT_SPEC_FILE = ".chant/ops/plywood-agent.spec.json";

/** The message when the installed chant has no agent job. */
export const AGENT_NEEDS_CHANT = "agent needs a chant with the agent job (chant#4616), and the installed one has none, so no agent job was written";

/** Whether the installed chant has the agent job: `CI_AGENT_FLOOR` on its ci-product entry. */
export function hasChantAgent(chant: ChantProduct | undefined): boolean {
  return typeof chant?.CI_AGENT_FLOOR === "string";
}

/** A stage's runner from plywood's `runners`: one for all, or the stage's over the default. */
export function stageRunner(runner: ChantRunner | undefined, stage: "preview" | "up" | "drift"): ChantRunnerSpec | undefined {
  if (runner === undefined) return undefined;
  if (typeof runner === "string" || Array.isArray(runner) || "group" in runner) return runner as ChantRunnerSpec;
  const staged = runner as Partial<Record<string, ChantRunnerSpec>>;
  return staged[stage] ?? staged.default;
}

/** Paths the agent may not change beside chant's: plywood.yml and the Rego directory. */
export function agentGuarded(doc: RawConfig): string[] {
  const policy = (toChantSettings({ doc }).ci.policy as { path?: unknown } | undefined)?.path;
  return [...CONFIG_NAMES, ...(typeof policy === "string" && policy.trim() !== "" ? [`${policy.replace(/^\.\//, "").replace(/\/+$/, "")}/`] : [])];
}

/** chant's agent settings from plywood.yml's `agent` (chant `OpAgentSpec` without the trigger). */
export function chantAgentOptions(a: AgentSettings, doc: RawConfig): Record<string, unknown> {
  return {
    ...(a.command ? { command: a.command } : {}),
    keyEnv: a.keyEnv,
    ...(a.timeout !== undefined ? { timeout: a.timeout } : {}),
    ...(a.maxRuns !== undefined ? { maxRuns: a.maxRuns } : {}),
    // chant#4616's push token; without it the push job uses the job token, whose GitHub push starts no workflow.
    ...(a.tokenEnv !== undefined ? { tokenEnv: a.tokenEnv } : {}),
    guarded: agentGuarded(doc),
  };
}

/**
 * The `agent` and `runner` fields of each scheduled drift Op (chant#4616),
 * or nothing when the installed chant lacks them. The runner is
 * `runners.drift`, else `runners.default`, else the one runner; the agent
 * rides on respond.drift: pull-request with agent.drift true.
 */
export function driftOpFields(chant: ChantProduct | undefined, doc: RawConfig, op: string, respond: string): Record<string, unknown> {
  if (!hasChantAgent(chant)) return {};
  const runner = stageRunner(toChantSettings({ doc }).pipeline.runner, "drift");
  const a = agentOf(doc);
  const wantsAgent = respond === "pull-request" && a?.drift === true;
  const agent = wantsAgent
    ? chant!.productDriftAgent
      ? chant!.productDriftAgent(PRODUCT_WORDS, op, chantAgentOptions(a!, doc))
      : { on: "drift", ...chantAgentOptions(a!, doc) }
    : undefined;
  return { ...(runner !== undefined ? { runner } : {}), ...(agent ? { agent } : {}) };
}

/** The agent's spec file: productPipelineJobs' Op spec, with plywood's image and lines. */
export function agentOpSpec(spec: Record<string, unknown>, doc: RawConfig): { ops: unknown[]; options: Record<string, unknown> } {
  const p = toChantSettings({ doc }).pipeline;
  const engine = chantPipelineOptions({ ...(p.image ? { image: p.image } : {}), ...(p.engineSetup ? { engineSetup: p.engineSetup } : {}) }, false);
  const runner = stageRunner(p.runner, "preview");
  return {
    ops: [{ ...spec, ...(runner !== undefined && spec.runner === undefined ? { runner } : {}) }],
    options: {
      ...(engine.beforeScript ? { beforeScript: engine.beforeScript } : {}),
      ...(engine.image ? { image: engine.image } : {}),
    },
  };
}

const OP_OUTPUT_DIR: Readonly<Record<ForgeKind, string>> = { github: ".github/workflows", forgejo: ".forgejo/workflows", gitlab: "." };

function writeIfChanged(cwd: string, file: string, text: string): boolean {
  const path = join(cwd, file);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/**
 * The comment agent's jobs, for `plywood ci`, when plywood.yml sets
 * agent.comment. productPipelineJobs names the comment and builds the spec;
 * chant's generator writes the agent job and the push job.
 */
export async function writeAgentJobs(chant: ChantProduct, forge: ForgeKind, env: string, doc: RawConfig, words: ProductWordsInput, table: ExitTable, io: StageIo): Promise<number> {
  const a = agentOf(doc);
  if (!a?.comment) return table.done;
  if (!hasChantAgent(chant)) {
    io.err(`${PRODUCT} ci: ${AGENT_NEEDS_CHANT}`);
    return table.done;
  }
  const agentWords: ProductWordsInput = { ...words, commands: { ...words.commands, agent: "agent" } };
  let spec: Record<string, unknown> | undefined;
  try {
    spec = chant.productPipelineJobs(forge, env, { words: agentWords, agent: { name: AGENT_OP, ...chantAgentOptions(a, doc) } }).agent?.spec;
  } catch (e) {
    io.err(`${PRODUCT} ci: agent: ${(e as Error).message}`);
    return table.failed;
  }
  if (!spec) {
    io.err(`${PRODUCT} ci: chant returned no agent spec for /${PRODUCT} agent, so no agent job was written`);
    return table.done;
  }
  if (writeIfChanged(io.cwd, AGENT_SPEC_FILE, JSON.stringify(agentOpSpec(spec, doc), null, 2) + "\n")) io.err(`${PRODUCT} ci: wrote ${AGENT_SPEC_FILE}`);
  const outDir = OP_OUTPUT_DIR[forge];
  const code = await chant.runChantInProcess(["run", "--generate", forge, "--spec", AGENT_SPEC_FILE, "--output", outDir], agentWords);
  if (code !== table.done) return code;
  const dir = join(io.cwd, outDir);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && (readFileSync(join(dir, f), "utf8").split("\n", 1)[0] ?? "").includes(`--spec ${AGENT_SPEC_FILE}`))
    : [];
  for (const f of files) io.err(`${PRODUCT} ci: agent jobs at ${join(outDir, f).replace(/^\.\//, "")}, answering /${PRODUCT} agent <ask>`);
  io.err(`${PRODUCT} ci: the agent job reads the model's key from ${a.keyEnv}; set it from a secret${a.maxRuns === undefined ? ", and set agent.max_runs to limit how often it runs" : ""}`);
  if (forge === "github" && a.tokenEnv === undefined) io.err(`${PRODUCT} ci: the push job pushes with the job token, which starts no workflow on GitHub, so the agent's commit gets no preview; set agent.token_env to a secret holding a user's or app's token`);
  else if (a.tokenEnv !== undefined) io.err(`${PRODUCT} ci: the push job pushes with ${a.tokenEnv}; set it from a secret`);
  if (forge === "gitlab") io.err(`${PRODUCT} ci: on GitLab a pipeline of the default branch started with CHANT_AGENT_PR and CHANT_AGENT_ASK runs the agent; scope CHANT_FORGE_TOKEN to environment ${AGENT_OP}-push`);
  return table.done;
}
