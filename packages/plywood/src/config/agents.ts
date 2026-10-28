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
 *   agent.command, agent.key_env, agent.timeout   as for review
 *   agent.max_runs         the most agent runs per day, the spend limit
 *     -> pipeline.agent, and chant's agent job (chant#4616, src/agent-jobs.ts):
 *        `plywood ci` writes the comment agent's jobs and puts the drift
 *        agent on each scheduled drift Op, on a chant that has the job
 */
import { error, isObject, onlyKeys, warning, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

export const DEFAULT_KEY_ENV = "ANTHROPIC_API_KEY";
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const REVIEW_KEYS = ["instructions", "command", "key_env", "timeout"] as const;
const AGENT_KEYS = ["comment", "drift", "command", "key_env", "timeout", "max_runs"] as const;

/** What the review Op's step takes (chant `ReviewAgentArgs`). */
export interface ReviewSettings {
  instructions?: string;
  command?: string;
  keyEnv: string;
  timeout?: number;
}

export interface AgentSettings {
  comment: boolean;
  drift: boolean;
  command?: string;
  keyEnv: string;
  timeout?: number;
  maxRuns?: number;
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

export function agentOf(doc: RawConfig): AgentSettings | undefined {
  const a = doc.agent;
  if (!isObject(a)) return undefined;
  return {
    comment: a.comment === true,
    drift: a.drift === true,
    ...(typeof a.command === "string" ? { command: a.command } : {}),
    keyEnv: typeof a.key_env === "string" ? a.key_env : DEFAULT_KEY_ENV,
    ...(typeof a.timeout === "number" ? { timeout: a.timeout } : {}),
    ...(typeof a.max_runs === "number" ? { maxRuns: a.max_runs } : {}),
  };
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
  key_env: { type: "string", default: DEFAULT_KEY_ENV, description: "The variable holding the model's key, the one secret the command sees." },
  timeout: { type: "integer", minimum: 1, description: "Minutes the command may run." },
};

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
      description: "Agents that act on a request: /plywood agent <ask>, and the drift agent's pull request.",
      properties: {
        comment: { type: "boolean", default: false, description: "Answer /plywood agent <ask> on a pull request." },
        drift: { type: "boolean", default: false, description: "Open a pull request that fixes a drifted stack (respond.drift: pull-request)." },
        ...modelSchema,
        max_runs: { type: "integer", minimum: 1, description: "The most agent runs per day." },
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
        for (const k of ["comment", "drift"] as const) if (a[k] !== undefined && typeof a[k] !== "boolean") out.push(error(`agent.${k}`, "is true or false"));
        if (a.max_runs !== undefined && (typeof a.max_runs !== "number" || !Number.isInteger(a.max_runs) || a.max_runs < 1)) out.push(error("agent.max_runs", "is a whole number of runs per day, 1 or more"));
        if ((a.comment === true || a.drift === true) && a.max_runs === undefined) out.push(warning("agent.max_runs", "is not set, so nothing limits how often an agent runs"));
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
  },
};
