/**
 * `review` and `agent`: the model that reviews a pull request, and the
 * agents that act on a request (plywood#19).
 *
 *   review                 true, or a mapping; off when absent
 *   review.instructions    the instructions file on the base branch (chant's
 *                          default, .chant/review.md)
 *   review.command         the model command, prompt on stdin and review on
 *                          stdout (chant's default: Claude Code in print
 *                          mode with no tools)
 *   review.key_env         the variable holding the model's key, the one
 *                          secret the command sees (default ANTHROPIC_API_KEY)
 *   review.timeout         minutes the command may run (chant's default, 10)
 *     -> chant's reviewAgent step in handoff mode, in a pull request Op
 *        `plywood ci` writes (src/agents.ts); the model's job holds no forge
 *        write token, and a second job posts the note
 *
 *   agent.comment          true answers `/plywood agent <ask>`
 *   agent.drift            true has the drift agent open a pull request for a
 *                          drifted stack (respond.drift: pull-request)
 *   agent.alert            true, or a map of window and relay_key_secret: an
 *                          agent opens a pull request for a production alert
 *                          the relay recorded (chant#5329)
 *   agent.apply-failed     true, or the same map: an agent opens a pull
 *                          request for an update that failed on merge
 *                          (chant#5357). The triage comment stays
 *   agent.schedule         a map of cron, task and window: an agent does the
 *                          task on the cron and opens a pull request (chant#5357)
 *   agent.verify-failed    true, or a map of window and relay_key_secret: an
 *                          agent opens a pull request when a stage's verify
 *                          or soak fails after an update (chant#5339). The
 *                          pipeline's jobs record the failures (plywood#156)
 *   agent.command, agent.key_env, agent.timeout   as for review
 *   agent.max_runs         the most agent runs per day, the spend limit
 *   agent.token_env        the secret (GitHub, Forgejo) or protected variable
 *                          (GitLab) holding the token the push job pushes
 *                          the agent's branch with. A GitHub push with the
 *                          job token starts no workflow, so the agent's
 *                          commit is not previewed until a token of a user
 *                          or app pushes it
 *     -> pipeline.agent, and chant's agent job (chant#4616, src/agent-jobs.ts):
 *        `plywood ci` writes the comment agent's jobs and puts the drift
 *        agent on each scheduled drift Op
 */
import type { ChantWaveSummary } from "../chant-config";
import { eventResponsesOf } from "./drift";
import { error, isObject, onlyKeys, warning, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

export const DEFAULT_KEY_ENV = "ANTHROPIC_API_KEY";
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const FACT_AGENT_KEYS = ["window", "relay_key_secret"] as const;
const SCHEDULE_KEYS = ["cron", "task", "window"] as const;
/** chant's longest task (`agent.schedule.task`, the vocabulary's "at most 4000 characters"). */
export const SCHEDULE_TASK_MAX = 4000;
const REVIEW_KEYS = ["instructions", "command", "key_env", "timeout"] as const;
const AGENT_KEYS = ["comment", "drift", "alert", "apply-failed", "schedule", "verify-failed", "command", "key_env", "timeout", "max_runs", "token_env", "wave-refused"] as const;
/** The refused-wave summary's keys, `agent.wave-refused.*` in chant's vocabulary. */
export const WAVE_REFUSED_AGENT_KEYS = ["command", "key_secret", "timeout", "max_runs", "max_cost_usd"] as const;

/** What the review Op's step takes (chant `ReviewAgentArgs`). */
export interface ReviewSettings {
  instructions?: string;
  command?: string;
  keyEnv: string;
  timeout?: number;
}

/** An agent that reads facts the relay or an apply job recorded: present when its key is on. */
export interface FactAgentSettings {
  /** Minutes in which one member's facts join one run (chant's `window`). Absent: chant's default, 15. */
  window?: number;
  /** The secret holding the relay key the facts are signed with (chant's `relayKeyEnv`). Absent: CHANT_RELAY_KEY. */
  relayKeyEnv?: string;
}

/** The scheduled agent: the cron, the task, and the join window. */
export interface ScheduleAgentSettings {
  cron: string;
  task: string;
  window?: number;
}

export interface AgentSettings {
  comment: boolean;
  drift: boolean;
  /** `agent.alert`, absent when off. */
  alert?: FactAgentSettings;
  /** `agent.apply-failed`, absent when off. */
  applyFailed?: FactAgentSettings;
  /** `agent.schedule`, absent when off. */
  schedule?: ScheduleAgentSettings;
  /** `agent.verify-failed` (chant#5339), absent when off. */
  verifyFailed?: FactAgentSettings;
  command?: string;
  keyEnv: string;
  timeout?: number;
  maxRuns?: number;
  /** The push job's token variable (chant `OpAgentSpec.tokenEnv`). Absent: chant's default, the job token on GitHub and Forgejo. */
  tokenEnv?: string;
}

/** The review settings, or undefined when `review` is off. */
export function reviewOf(doc: RawConfig): ReviewSettings | undefined {
  const r = doc.review;
  if (r === undefined || r === false) return undefined;
  const m = isObject(r) ? r : {};
  return {
    ...(typeof m.instructions === "string" ? { instructions: m.instructions } : {}),
    ...(typeof m.command === "string" ? { command: m.command } : {}),
    keyEnv: typeof m.key_env === "string" ? m.key_env : DEFAULT_KEY_ENV,
    ...(typeof m.timeout === "number" ? { timeout: m.timeout } : {}),
  };
}

function factAgentOf(v: unknown): FactAgentSettings | undefined {
  if (v === true) return {};
  if (!isObject(v)) return undefined;
  return {
    ...(typeof v.window === "number" ? { window: v.window } : {}),
    ...(typeof v.relay_key_secret === "string" ? { relayKeyEnv: v.relay_key_secret } : {}),
  };
}

function scheduleOf(v: unknown): ScheduleAgentSettings | undefined {
  if (!isObject(v) || typeof v.cron !== "string" || typeof v.task !== "string") return undefined;
  return { cron: v.cron, task: v.task, ...(typeof v.window === "number" ? { window: v.window } : {}) };
}

export function agentOf(doc: RawConfig): AgentSettings | undefined {
  const a = doc.agent;
  if (!isObject(a)) return undefined;
  const alert = factAgentOf(a.alert);
  const applyFailed = factAgentOf(a["apply-failed"]);
  const schedule = scheduleOf(a.schedule);
  const verifyFailed = factAgentOf(a["verify-failed"]);
  return {
    comment: a.comment === true,
    drift: a.drift === true,
    ...(alert ? { alert } : {}),
    ...(applyFailed ? { applyFailed } : {}),
    ...(schedule ? { schedule } : {}),
    ...(verifyFailed ? { verifyFailed } : {}),
    ...(typeof a.command === "string" ? { command: a.command } : {}),
    keyEnv: typeof a.key_env === "string" ? a.key_env : DEFAULT_KEY_ENV,
    ...(typeof a.timeout === "number" ? { timeout: a.timeout } : {}),
    ...(typeof a.max_runs === "number" ? { maxRuns: a.max_runs } : {}),
    ...(typeof a.token_env === "string" ? { tokenEnv: a.token_env } : {}),
  };
}

/**
 * chant's `waveSummary` for the refused-wave summary: set only when
 * `respond.wave_refused` is `summary`, with each `agent.wave-refused.*` key
 * renamed to chant's field. A key left out takes chant's default.
 */
export function waveSummaryOf(doc: RawConfig): ChantWaveSummary | undefined {
  if (eventResponsesOf(doc)["wave-refused"] !== "summary") return undefined;
  const a = isObject(doc.agent) ? doc.agent : {};
  const s = isObject(a["wave-refused"]) ? a["wave-refused"] : {};
  return {
    ...(typeof s.command === "string" ? { command: s.command } : {}),
    ...(typeof s.key_secret === "string" ? { keyEnv: s.key_secret } : {}),
    ...(typeof s.timeout === "number" ? { timeout: s.timeout } : {}),
    ...(typeof s.max_runs === "number" ? { maxRuns: s.max_runs } : {}),
    ...(typeof s.max_cost_usd === "number" ? { maxCostUsd: s.max_cost_usd } : {}),
  };
}

function waveRefusedCheck(doc: RawConfig, s: unknown): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  if (!isObject(s)) return [error("agent.wave-refused", "is a mapping of command, key_secret, timeout, max_runs and max_cost_usd")];
  out.push(...onlyKeys(s, WAVE_REFUSED_AGENT_KEYS, "agent.wave-refused"));
  if (s.command !== undefined && (typeof s.command !== "string" || s.command.trim() === "")) out.push(error("agent.wave-refused.command", "is a command line that reads the prompt on stdin"));
  if (s.key_secret !== undefined && (typeof s.key_secret !== "string" || !VARIABLE.test(s.key_secret))) out.push(error("agent.wave-refused.key_secret", "names the secret holding the model's key, such as ANTHROPIC_API_KEY; the key itself never goes in plywood.yml"));
  if (s.timeout !== undefined && (typeof s.timeout !== "number" || !Number.isInteger(s.timeout) || s.timeout < 1)) out.push(error("agent.wave-refused.timeout", "is a whole number of minutes, 1 or more"));
  if (s.max_runs !== undefined && (typeof s.max_runs !== "number" || !Number.isInteger(s.max_runs) || s.max_runs < 1)) out.push(error("agent.wave-refused.max_runs", "is a whole number of summaries per day, 1 or more"));
  if (s.max_cost_usd !== undefined && (typeof s.max_cost_usd !== "number" || !(s.max_cost_usd > 0))) out.push(error("agent.wave-refused.max_cost_usd", "is a number of US dollars per day, above 0"));
  if (eventResponsesOf(doc)["wave-refused"] !== "summary") out.push(error("agent.wave-refused", "is read with respond.wave_refused set to summary"));
  return out;
}

function modelKeys(m: Record<string, unknown>, key: string): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  if (m.instructions !== undefined && (typeof m.instructions !== "string" || m.instructions.trim() === "")) out.push(error(`${key}.instructions`, "is a path on the base branch, such as .chant/review.md"));
  if (m.command !== undefined && (typeof m.command !== "string" || m.command.trim() === "")) out.push(error(`${key}.command`, "is a command line that reads the prompt on stdin"));
  if (m.key_env !== undefined && (typeof m.key_env !== "string" || !VARIABLE.test(m.key_env))) out.push(error(`${key}.key_env`, "names an environment variable, such as ANTHROPIC_API_KEY; the key itself never goes in plywood.yml"));
  if (m.timeout !== undefined && (typeof m.timeout !== "number" || !Number.isInteger(m.timeout) || m.timeout < 1)) out.push(error(`${key}.timeout`, "is a whole number of minutes, 1 or more"));
  return out;
}

const modelSchema = {
  command: { type: "string", description: "The model command: the prompt on stdin, the answer on stdout." },
  key_secret: { type: "string", default: DEFAULT_KEY_ENV, description: "The variable holding the model's key, the one secret the command sees." },
  key_env: { type: "string", default: DEFAULT_KEY_ENV, description: "The variable holding the model's key, the one secret the command sees." },
  timeout: { type: "integer", minimum: 1, description: "Minutes the command may run." },
};

const factSchema = {
  window: { type: "integer", minimum: 1, maximum: 1440, default: 15, description: "Minutes in which one member's facts join one agent run." },
  relay_key_secret: { type: "string", description: "The secret holding the relay key the facts are signed and checked with. Default CHANT_RELAY_KEY." },
};

function windowProblem(key: string, v: Record<string, unknown>): ConfigProblem[] {
  const w = v.window;
  return w !== undefined && (typeof w !== "number" || !Number.isInteger(w) || w < 1 || w > 1440) ? [error(`${key}.window`, "is a whole number of minutes from 1 to 1440")] : [];
}

function factAgentProblems(key: string, v: unknown): ConfigProblem[] {
  if (v === undefined || typeof v === "boolean") return [];
  if (!isObject(v)) return [error(key, "is true, or a mapping of window and relay_key_secret")];
  const out = [...onlyKeys(v, FACT_AGENT_KEYS, key), ...windowProblem(key, v)];
  if (v.relay_key_secret !== undefined && (typeof v.relay_key_secret !== "string" || !VARIABLE.test(v.relay_key_secret))) out.push(error(`${key}.relay_key_secret`, "names the secret holding the relay key, such as CHANT_RELAY_KEY; the key itself never goes in plywood.yml"));
  return out;
}

function scheduleProblems(v: unknown): ConfigProblem[] {
  if (v === undefined) return [];
  if (!isObject(v)) return [error("agent.schedule", "is a mapping of cron, task and window")];
  const out = [...onlyKeys(v, SCHEDULE_KEYS, "agent.schedule"), ...windowProblem("agent.schedule", v)];
  if (typeof v.cron !== "string" || v.cron.trim().split(/\s+/).length !== 5) out.push(error("agent.schedule.cron", "is a five-field cron, such as '0 7 * * 1'"));
  if (typeof v.task !== "string" || v.task.trim() === "") out.push(error("agent.schedule.task", "is what the agent does on each run, in words"));
  else if (v.task.length > SCHEDULE_TASK_MAX) out.push(error("agent.schedule.task", `is at most ${SCHEDULE_TASK_MAX} characters`));
  return out;
}

export const agents: ConfigGroup = {
  name: "agents",
  keys: ["review", "agent"],
  schema: {
    review: {
      description: "A model reviews each pull request and posts one note. It approves and gates nothing. Off when absent.",
      oneOf: [
        { type: "boolean" },
        {
          type: "object",
          additionalProperties: false,
          properties: { instructions: { type: "string", description: "The instructions file, read from the base branch. Default .chant/review.md." }, ...modelSchema },
        },
      ],
    },
    agent: {
      type: "object",
      additionalProperties: false,
      description: "Agents that act on a request: /plywood agent <ask>, the drift agent's pull request, and the agents a production alert, a failed update on merge, a failed verify or soak, or a schedule starts. Each opens a pull request; none applies, approves or merges. All are off until set.",
      properties: {
        comment: { type: "boolean", default: false, description: "Answer /plywood agent <ask> on a pull request." },
        drift: { type: "boolean", default: false, description: "Open a pull request that fixes a drifted stack (respond.drift: pull-request)." },
        alert: {
          description: "An agent opens a pull request for a production alert the relay recorded. true, or a map. The relay takes the alert at POST /alert/<source>.",
          oneOf: [{ type: "boolean" }, { type: "object", additionalProperties: false, properties: factSchema }],
        },
        "apply-failed": {
          description: "An agent opens a pull request for an update that failed on merge, beside the triage comment. true, or a map. Wave jobs record the failure.",
          oneOf: [{ type: "boolean" }, { type: "object", additionalProperties: false, properties: factSchema }],
        },
        schedule: {
          type: "object",
          additionalProperties: false,
          required: ["cron", "task"],
          description: "An agent does a recurring task on a cron and opens a pull request when the task changes something.",
          properties: {
            cron: { type: "string", description: "When the agent runs: a five-field cron." },
            task: { type: "string", maxLength: SCHEDULE_TASK_MAX, description: "What the agent does on each run, in your words." },
            window: factSchema.window,
          },
        },
        "verify-failed": {
          description: "An agent opens a pull request when a stage's verify or soak check fails after an update. true, or a map. The promote and wave jobs record the failure.",
          oneOf: [{ type: "boolean" }, { type: "object", additionalProperties: false, properties: factSchema }],
        },
        ...modelSchema,
        max_runs: { type: "integer", minimum: 1, description: "The most agent runs per day." },
        "wave-refused": {
          type: "object",
          additionalProperties: false,
          description: "The model run behind respond.wave_refused: summary. Each key is optional; chant's defaults fill the rest.",
          properties: {
            command: { type: "string", description: "The model command: the prompt on stdin, the summary on stdout." },
            key_secret: { type: "string", default: DEFAULT_KEY_ENV, description: "The secret (GitHub, Forgejo) or CI/CD variable (GitLab) holding the model's key." },
            timeout: { type: "integer", minimum: 1, description: "Minutes the command may run." },
            max_runs: { type: "integer", minimum: 1, description: "The most summaries per day." },
            max_cost_usd: { type: "number", exclusiveMinimum: 0, description: "The most US dollars the summaries may cost per day." },
          },
        },
        token_env: {
          type: "string",
          description: "The secret (GitHub, Forgejo) or protected variable (GitLab) holding the token the push job pushes the agent's branch with. Default: the job token on GitHub and Forgejo, CHANT_FORGE_TOKEN on GitLab. A GitHub push with the job token starts no workflow, so the agent's commit gets no preview.",
        },
      },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    const r = doc.review;
    if (r !== undefined && typeof r !== "boolean") {
      if (!isObject(r)) out.push(error("review", "is true, or a mapping of instructions, command, key_env and timeout"));
      else out.push(...onlyKeys(r, REVIEW_KEYS, "review"), ...modelKeys(r, "review"));
    }
    const a = doc.agent;
    if (a !== undefined) {
      if (!isObject(a)) out.push(error("agent", "must be a mapping"));
      else {
        out.push(...onlyKeys(a, AGENT_KEYS, "agent"), ...modelKeys(a, "agent"));
        if (a["wave-refused"] !== undefined) out.push(...waveRefusedCheck(doc, a["wave-refused"]));
        for (const k of ["comment", "drift"] as const) if (a[k] !== undefined && typeof a[k] !== "boolean") out.push(error(`agent.${k}`, "is true or false"));
        if (a.token_env !== undefined && (typeof a.token_env !== "string" || !VARIABLE.test(a.token_env))) out.push(error("agent.token_env", "names the secret holding the push token, such as PLYWOOD_AGENT_TOKEN; the token itself never goes in plywood.yml"));
        if (a.max_runs !== undefined && (typeof a.max_runs !== "number" || !Number.isInteger(a.max_runs) || a.max_runs < 1)) out.push(error("agent.max_runs", "is a whole number of runs per day, 1 or more"));
        out.push(...factAgentProblems("agent.alert", a.alert), ...factAgentProblems("agent.apply-failed", a["apply-failed"]), ...factAgentProblems("agent.verify-failed", a["verify-failed"]), ...scheduleProblems(a.schedule));
        const verifyOn = a["verify-failed"] !== undefined && a["verify-failed"] !== false;
        if (verifyOn && doc.promotion === undefined) out.push(warning("agent.verify-failed", "is on and plywood.yml has no promotion, so no stage records a failed verify or soak"));
        const on = a.comment === true || a.drift === true || (a.alert !== undefined && a.alert !== false) || (a["apply-failed"] !== undefined && a["apply-failed"] !== false) || a.schedule !== undefined || verifyOn;
        if (on && a.max_runs === undefined) out.push(warning("agent.max_runs", "is not set, so nothing limits how often an agent runs"));
        if (a.drift === true && !(isObject(doc.respond) && doc.respond.drift === "pull-request")) out.push(warning("agent.drift", "is true and respond.drift is not pull-request, so no drift run starts the agent"));
      }
    }
    const respond = isObject(doc.respond) ? doc.respond.drift : undefined;
    if (respond === "pull-request" && !(isObject(a) && a.drift === true)) out.push(warning("respond.drift", "is pull-request and agent.drift is not true, so a drift run keeps the issue only"));
    return out;
  },
  translate(doc, out) {
    const review = reviewOf(doc);
    if (review) out.pipeline.review = review;
    const agent = agentOf(doc);
    if (agent) out.pipeline.agent = agent;
    const waveSummary = waveSummaryOf(doc);
    if (waveSummary) out.pipeline.waveSummary = waveSummary;
  },
};
