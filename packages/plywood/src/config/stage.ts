/**
 * The stage keys (plywood#156): how each environment of `promotion` behaves
 * as a stage of chant's pipeline, in the words of chant's CI product config
 * page ("Stage keys"). plywood checks their shape and hands them to chant's
 * `pipelineFromConfig` as written; chant checks the rest when `plywood ci`
 * writes `.chant/pipeline.ts` (src/pipeline.ts).
 *
 * Under `environments.<name>`, beside `targets` (src/config/promotion.ts):
 *
 *   gate, approval, approval_rules     the stage's own gate, in place of the top-level ones
 *   forge_environment                  the forge deployment environment of its jobs
 *   hold, freeze                       a manual hold, and freeze windows
 *   urgent.role                        the role whose proven approval passes the gate on promote --urgent
 *   pause_after_rollback               a rollback pauses the stage until it is resumed
 *   on_verify_fail                     hold, or rollback: request the rollback when a verify or soak fails
 *   failure_tolerance                  failed runs a wave lets through
 *   after, queue                       the stage graph and one release at a time
 *   soak                               duration, checks and overrides
 *   risk                               approve_above and approval_rules over the score
 *   replan_dependents                  stacks whose dependents are planned again
 *   publish, reads                     release artifacts
 *   agent_steps                        a model's reading of the release
 *   config, secrets, imports           the stage's config and secret set
 *
 * At the top level:
 *
 *   risk.approve_above, risk.questions the change risk the preview scores
 *   replan_dependents                  for every stage, and the waves on merge
 *   release.cut, release.label         the release the merge cuts
 *   recheck.schedule                   when a promotion a soak holds is tried again
 *   config_sets.<set>                  shared config and secret sets
 *
 * The canary is `waves.canary` (src/config/stacks.ts): its wave is the
 * first of each stage, marked `canary`. Every key is off until set.
 */
import type { ChantCiSettings } from "../chant-config";
import { APPROVALS, GATES, approvalRulesProblems } from "./approval";
import { error, isObject, oneOf, onlyKeys, stringList, type ConfigGroup, type ConfigProblem, type JsonSchema, type RawConfig } from "./types";

/** The keys of a stage entry under `environments.<name>`. */
export const STAGE_ENTRY_KEYS = [
  "targets",
  "gate",
  "approval",
  "approval_rules",
  "forge_environment",
  "hold",
  "freeze",
  "urgent",
  "pause_after_rollback",
  "on_verify_fail",
  "failure_tolerance",
  "after",
  "queue",
  "soak",
  "risk",
  "replan_dependents",
  "publish",
  "reads",
  "agent_steps",
  "config",
  "secrets",
  "imports",
] as const;

export const ON_VERIFY_FAIL = ["hold", "rollback"] as const;
export const QUEUES = ["replace"] as const;
export const SOAK_CHECK_KINDS = ["http", "prometheus", "cloudwatch-alarm", "command", "health", "drift", "apply", "policy"] as const;
export const SOAK_ON_FAIL = ["restart", "hold"] as const;
const SECRET_STORES = ["forge_secret", "aws_secrets_manager", "gcp_secret_manager", "azure_key_vault"] as const;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CRON_FIELDS = 5;

/** chant's words for a secret's place, from plywood.yml's snake_case (`EnvironmentSecretRef`). */
const SECRET_WORDS: Readonly<Record<string, string>> = { forge_secret: "forgeSecret", aws_secrets_manager: "awsSecretsManager", gcp_secret_manager: "gcpSecretManager", azure_key_vault: "azureKeyVault", json_key: "jsonKey" };

const stringMap: JsonSchema = { type: "object", additionalProperties: { type: "string" } };
const secretRef: JsonSchema = {
  anyOf: [
    { type: "string", pattern: VARIABLE.source },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        forge_secret: { type: "string" },
        aws_secrets_manager: { type: "string" },
        gcp_secret_manager: { type: "string" },
        azure_key_vault: { type: "string" },
        json_key: { type: "string" },
        region: { type: "string" },
      },
    },
  ],
};
const setSchema: Record<string, JsonSchema> = {
  config: { ...stringMap, description: "Plain values the stage's jobs get as variables." },
  secrets: { type: "object", additionalProperties: secretRef, description: "Secrets the stage's jobs get as variables, each named by where it is kept: a forge secret's name, or a map naming a cloud secret store." },
  imports: { type: "array", items: { type: "string" }, description: "The config_sets this set takes first, in order." },
};
const rulesSchema: JsonSchema = {
  description: "Approval rules, as approval_rules takes them.",
  anyOf: [{ type: "object", additionalProperties: { $ref: "#/$defs/approvalNode" } }, { type: "array", items: { $ref: "#/$defs/approvalNode" } }],
};
const soakCheck: JsonSchema = {
  type: "object",
  required: ["kind"],
  properties: {
    kind: { type: "string", enum: [...SOAK_CHECK_KINDS] },
    on_fail: { type: "string", enum: [...SOAK_ON_FAIL], default: "restart" },
  },
  description: "One soak check: its kind, with that kind's settings beside it, and on_fail.",
};

/** The schema of a stage entry, `environments.<name>` under promotion. */
export const STAGE_ENTRY_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    targets: {
      type: "object",
      description: "Each project to the stack it updates in this environment, as stack or project/stack.",
      additionalProperties: { type: "string", minLength: 1 },
    },
    gate: { type: "string", enum: [...GATES], description: "When the stage's waves wait for an approval, in place of gate." },
    approval: { type: "string", enum: [...APPROVALS], description: "Which approvals of the stage count, in place of approval." },
    approval_rules: { ...rulesSchema, description: "The stage's approval rules, in place of approval_rules." },
    forge_environment: {
      description: "The forge deployment environment of the stage's jobs: a name, or a map with name and url.",
      anyOf: [{ type: "string" }, { type: "object", required: ["name"], additionalProperties: false, properties: { name: { type: "string" }, url: { type: "string" } } }],
    },
    hold: {
      description: "A manual hold: no release is promoted into the stage. true, or a map with reason, until (an ISO 8601 time) and description.",
      anyOf: [{ type: "boolean" }, { type: "object", additionalProperties: false, properties: { reason: { type: "string" }, until: { type: "string" }, description: { type: "string" } } }],
    },
    freeze: {
      type: "array",
      description: "Freeze windows in which no release is promoted into the stage.",
      items: { type: "object", required: ["from", "until"], additionalProperties: false, properties: { from: { type: "string" }, until: { type: "string" }, reason: { type: "string" } } },
    },
    urgent: { type: "object", required: ["role"], additionalProperties: false, properties: { role: { type: "string" } }, description: "The role whose one proven approval passes the stage's gate on plywood promote --urgent." },
    pause_after_rollback: { type: "boolean", default: false, description: "A rollback of the stage pauses it until plywood resume <env>." },
    on_verify_fail: { type: "string", enum: [...ON_VERIFY_FAIL], default: "hold", description: "A failed verify or soak check holds the stage as applied, or requests the rollback to its previous release, which waits for an approval." },
    failure_tolerance: { description: "The failed runs a wave lets through: a whole number, or a share such as 10%.", anyOf: [{ type: "integer", minimum: 0 }, { type: "string", pattern: "^[0-9]+(\\.[0-9]+)?%$" }] },
    after: { type: "array", items: { type: "string" }, description: "The stages a release applies in before this one opens for it. Default the stage before it in promotion." },
    queue: { type: "string", enum: [...QUEUES], description: "replace: the stage takes one release at a time, and a newer release waiting replaces an older one." },
    soak: {
      type: "object",
      required: ["duration"],
      additionalProperties: false,
      description: "Checks that must keep passing for duration after the stage's last update before a release is promoted into the next stage.",
      properties: {
        duration: { type: "string", description: "A duration such as 30m or 2h, or 0 to wait for the checks alone." },
        checks: { type: "array", items: soakCheck },
        overrides: {
          type: "array",
          items: { type: "object", required: ["members"], properties: { members: { type: "array", items: { type: "string" } }, duration: { type: "string" }, checks: { type: "array", items: soakCheck } } },
        },
      },
    },
    risk: {
      type: "object",
      additionalProperties: false,
      description: "Over this risk score, the stage's waves and a promote into it take approval_rules on top of the gate's own.",
      properties: { approve_above: { type: "number", minimum: 0, maximum: 1 }, approval_rules: rulesSchema },
    },
    replan_dependents: { type: "array", items: { type: "string" }, description: "Stacks whose dependents are previewed again when an output they read changes after an update in this stage." },
    publish: {
      type: "object",
      description: "Release artifacts the stage publishes once it updated: { member, output }, or { secret }.",
      additionalProperties: { type: "object", properties: { member: { type: "string" }, output: { type: "string" }, secret: secretRef } },
    },
    reads: {
      type: "object",
      description: "Artifacts of an earlier stage the stage's update gets in a variable: { stage, artifact }.",
      additionalProperties: { type: "object", required: ["stage", "artifact"], additionalProperties: false, properties: { stage: { type: "string" }, artifact: { type: "string" } } },
    },
    agent_steps: {
      type: "object",
      description: "Agent steps: a model's reading of the release the stage takes, with an answer of a declared shape. A step approves nothing and applies nothing.",
      additionalProperties: {
        type: "object",
        required: ["prompt", "schema"],
        additionalProperties: false,
        properties: {
          prompt: { type: "string", maxLength: 4000 },
          schema: { type: "object" },
          reads: { type: "object" },
          command: { type: "string" },
          key_secret: { type: "string" },
          timeout: { type: "integer", minimum: 1, maximum: 360 },
          max_runs: { type: "integer", minimum: 1 },
          max_cost_usd: { type: "number", exclusiveMinimum: 0 },
        },
      },
    },
    ...setSchema,
  },
};

/** Whether `v` is a stage entry: a mapping holding a stage key. A glob's `{ name, url }` holds none. */
export function holdsStageKey(v: unknown): v is Record<string, unknown> {
  return isObject(v) && Object.keys(v).some((k) => (STAGE_ENTRY_KEYS as readonly string[]).includes(k));
}

function numberIn(v: unknown, min: number, max: number): boolean {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
}

function cronProblem(v: unknown, key: string): ConfigProblem[] {
  return typeof v === "string" && v.trim().split(/\s+/).length === CRON_FIELDS ? [] : [error(key, "is a five-field cron line, such as '*/15 * * * *'")];
}

function secretRefProblems(v: unknown, key: string): ConfigProblem[] {
  if (typeof v === "string") return VARIABLE.test(v) ? [] : [error(key, `${JSON.stringify(v)} is not a secret name`)];
  if (!isObject(v)) return [error(key, "names a forge secret, or is a map with one of forge_secret, aws_secrets_manager, gcp_secret_manager, azure_key_vault")];
  const stores = SECRET_STORES.filter((s) => v[s] !== undefined);
  const out = onlyKeys(v, [...SECRET_STORES, "json_key", "region"], key);
  if (stores.length !== 1) out.push(error(key, `names one place a secret is kept: one of ${SECRET_STORES.join(", ")}`));
  return out;
}

/** A config and secret set's problems: `environments.<name>` or `config_sets.<set>`. */
function setProblems(v: Record<string, unknown>, key: string, sets: readonly string[]): ConfigProblem[] {
  const out: ConfigProblem[] = [];
  if (v.config !== undefined) {
    if (!isObject(v.config)) out.push(error(`${key}.config`, "maps each variable to a plain value"));
    else for (const [name, value] of Object.entries(v.config)) {
      if (!VARIABLE.test(name)) out.push(error(`${key}.config.${name}`, "is not a variable name"));
      if (typeof value !== "string") out.push(error(`${key}.config.${name}`, "must be a string"));
    }
  }
  if (v.secrets !== undefined) {
    if (!isObject(v.secrets)) out.push(error(`${key}.secrets`, "maps each variable to where its secret is kept"));
    else for (const [name, ref] of Object.entries(v.secrets)) {
      if (!VARIABLE.test(name)) out.push(error(`${key}.secrets.${name}`, "is not a variable name"));
      out.push(...secretRefProblems(ref, `${key}.secrets.${name}`));
    }
  }
  out.push(...stringList(v.imports, `${key}.imports`));
  if (Array.isArray(v.imports)) for (const s of v.imports) if (typeof s === "string" && !sets.includes(s)) out.push(error(`${key}.imports`, `names ${s}, which is not under config_sets`));
  return out;
}

function soakChecksProblems(checks: unknown, key: string): ConfigProblem[] {
  if (checks === undefined) return [];
  if (!Array.isArray(checks)) return [error(key, "is a list of checks, each with a kind")];
  return checks.flatMap((c, i) => {
    if (!isObject(c)) return [error(`${key}[${i}]`, "is a map with kind")];
    return [...oneOf(c.kind, SOAK_CHECK_KINDS, `${key}[${i}].kind`), ...(c.kind === undefined ? [error(`${key}[${i}].kind`, `names what the check reads: one of ${SOAK_CHECK_KINDS.join(", ")}`)] : []), ...oneOf(c.on_fail, SOAK_ON_FAIL, `${key}[${i}].on_fail`)];
  });
}

/** The problems of one stage entry's stage keys (not `targets`, which src/config/promotion.ts checks). */
export function stageEntryProblems(env: string, e: Record<string, unknown>, doc: RawConfig, promotion: readonly string[]): ConfigProblem[] {
  const key = `environments.${env}`;
  const sets = isObject(doc.config_sets) ? Object.keys(doc.config_sets) : [];
  const out: ConfigProblem[] = [...onlyKeys(e, STAGE_ENTRY_KEYS, key), ...oneOf(e.gate, GATES, `${key}.gate`), ...oneOf(e.approval, APPROVALS, `${key}.approval`)];
  if (e.approval_rules !== undefined) out.push(...approvalRulesProblems(e.approval_rules, `${key}.approval_rules`));
  if (e.hold !== undefined && typeof e.hold !== "boolean") {
    if (!isObject(e.hold)) out.push(error(`${key}.hold`, "is true, or a map with reason, until and description"));
    else out.push(...onlyKeys(e.hold, ["reason", "until", "description"], `${key}.hold`));
  }
  if (e.freeze !== undefined) {
    if (!Array.isArray(e.freeze) || e.freeze.some((w) => !isObject(w) || typeof w.from !== "string" || typeof w.until !== "string")) out.push(error(`${key}.freeze`, "is a list of windows, each with from and until (ISO 8601 times) and a reason"));
  }
  if (e.urgent !== undefined && !(isObject(e.urgent) && typeof e.urgent.role === "string" && e.urgent.role !== "")) out.push(error(`${key}.urgent`, "is a map with role, a role from .chant/trust.json"));
  if (e.pause_after_rollback !== undefined && typeof e.pause_after_rollback !== "boolean") out.push(error(`${key}.pause_after_rollback`, "is true or false"));
  out.push(...oneOf(e.on_verify_fail, ON_VERIFY_FAIL, `${key}.on_verify_fail`), ...oneOf(e.queue, QUEUES, `${key}.queue`));
  const t = e.failure_tolerance;
  if (t !== undefined && !((typeof t === "number" && Number.isInteger(t) && t >= 0) || (typeof t === "string" && /^[0-9]+(\.[0-9]+)?%$/.test(t)))) out.push(error(`${key}.failure_tolerance`, "is a whole number of runs, or a share such as 10%"));
  out.push(...stringList(e.after, `${key}.after`), ...stringList(e.replan_dependents, `${key}.replan_dependents`));
  if (Array.isArray(e.after)) for (const s of e.after) if (typeof s === "string" && !promotion.includes(s)) out.push(error(`${key}.after`, `names ${s}, which promotion does not list`));
  if (e.soak !== undefined) {
    if (!isObject(e.soak) || typeof e.soak.duration !== "string") out.push(error(`${key}.soak`, "is a map with duration, checks and overrides"));
    else {
      out.push(...onlyKeys(e.soak, ["duration", "checks", "overrides"], `${key}.soak`), ...soakChecksProblems(e.soak.checks, `${key}.soak.checks`));
      if (e.soak.overrides !== undefined && (!Array.isArray(e.soak.overrides) || e.soak.overrides.some((o) => !isObject(o) || !Array.isArray(o.members)))) out.push(error(`${key}.soak.overrides`, "is a list of maps, each with members"));
    }
  }
  if (e.risk !== undefined) {
    if (!isObject(e.risk)) out.push(error(`${key}.risk`, "is a map with approve_above and approval_rules"));
    else {
      out.push(...onlyKeys(e.risk, ["approve_above", "approval_rules"], `${key}.risk`));
      if (e.risk.approve_above !== undefined && !numberIn(e.risk.approve_above, 0, 1)) out.push(error(`${key}.risk.approve_above`, "is a score from 0 to 1"));
      if (e.risk.approval_rules !== undefined) out.push(...approvalRulesProblems(e.risk.approval_rules, `${key}.risk.approval_rules`));
    }
  }
  for (const k of ["publish", "reads", "agent_steps"] as const) if (e[k] !== undefined && !isObject(e[k])) out.push(error(`${key}.${k}`, "must be a mapping"));
  if (isObject(e.reads)) for (const [v, r] of Object.entries(e.reads)) {
    if (!VARIABLE.test(v)) out.push(error(`${key}.reads.${v}`, "is not a variable name"));
    if (!isObject(r) || typeof r.stage !== "string" || typeof r.artifact !== "string") out.push(error(`${key}.reads.${v}`, "is a map with stage and artifact"));
  }
  if (isObject(e.agent_steps)) for (const [s, a] of Object.entries(e.agent_steps)) {
    if (!isObject(a) || typeof a.prompt !== "string" || !isObject(a.schema)) out.push(error(`${key}.agent_steps.${s}`, "is a map with prompt and schema"));
    else if (a.prompt.length > 4000) out.push(error(`${key}.agent_steps.${s}.prompt`, "is at most 4000 characters"));
  }
  out.push(...setProblems(e, key, sets));
  return out;
}

/** The risk keys as chant's `ci.risk` (`ChangeRiskSettings`), or undefined when plywood.yml sets none. */
export function ciRiskOf(doc: RawConfig): NonNullable<ChantCiSettings["risk"]> | undefined {
  const r = doc.risk;
  if (!isObject(r)) return undefined;
  const questions = Array.isArray(r.questions)
    ? r.questions.filter(isObject).map((q) => ({ id: String(q.id), text: String(q.text), weight: Number(q.weight), ...(typeof q.approve_above === "number" ? { approveAbove: q.approve_above } : {}) }))
    : undefined;
  return { ...(typeof r.approve_above === "number" ? { approveAbove: r.approve_above } : {}), ...(questions?.length ? { questions } : {}) };
}

/** A secret's place in chant's words: plywood.yml's snake_case keys renamed, a name kept. */
export function secretRefOf(ref: unknown): unknown {
  if (!isObject(ref)) return ref;
  return Object.fromEntries(Object.entries(ref).map(([k, v]) => [SECRET_WORDS[k] ?? k, v]));
}

function setOf(v: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(Array.isArray(v.imports) && v.imports.length ? { imports: [...(v.imports as string[])] } : {}),
    ...(isObject(v.config) ? { config: { ...(v.config as Record<string, string>) } } : {}),
    ...(isObject(v.secrets) ? { secrets: Object.fromEntries(Object.entries(v.secrets).map(([k, r]) => [k, secretRefOf(r)])) } : {}),
  };
}

/** `config_sets` and each environment's `config`, `secrets` and `imports` as chant's `ci.environmentSets`, or undefined when none is set. */
export function environmentSetsOf(doc: RawConfig): NonNullable<ChantCiSettings["environmentSets"]> | undefined {
  const environments: Record<string, Record<string, unknown>> = {};
  if (isObject(doc.environments)) {
    for (const [env, e] of Object.entries(doc.environments)) {
      if (!holdsStageKey(e)) continue;
      const set = setOf(e);
      if (Object.keys(set).length) environments[env] = set;
    }
  }
  const configSets = isObject(doc.config_sets) ? Object.fromEntries(Object.entries(doc.config_sets).filter(([, s]) => isObject(s)).map(([n, s]) => [n, setOf(s as Record<string, unknown>)])) : {};
  if (Object.keys(environments).length === 0 && Object.keys(configSets).length === 0) return undefined;
  return { environments, ...(Object.keys(configSets).length ? { configSets } : {}) } as NonNullable<ChantCiSettings["environmentSets"]>;
}

/** `replan_dependents` at the top level: the stacks whose dependents are previewed again, or undefined. */
export function replanDependentsOf(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string") ? [...(v as string[])] : undefined;
}

export const stage: ConfigGroup = {
  name: "stage",
  keys: ["risk", "replan_dependents", "release", "recheck", "config_sets"],
  schema: {
    risk: {
      type: "object",
      additionalProperties: false,
      description: "The change risk each preview scores from 0 to 1. Over approve_above, the change needs an approval of its own digest. Off when absent.",
      properties: {
        approve_above: { type: "number", minimum: 0, maximum: 1, description: "The score above which a change needs an approval of its own." },
        questions: {
          type: "array",
          description: "Questions the review agent answers from 0 to 1, each a reason in the score.",
          items: {
            type: "object",
            required: ["id", "text", "weight"],
            additionalProperties: false,
            properties: { id: { type: "string", pattern: "^[a-z0-9_-]+$" }, text: { type: "string" }, weight: { type: "number", minimum: 0, maximum: 1 }, approve_above: { type: "number", minimum: 0, maximum: 1 } },
          },
        },
      },
    },
    replan_dependents: {
      type: "array",
      items: { type: "string" },
      description: "Stacks (names or globs) whose dependents are previewed again when an output they read changes after an update. The preview waits at its own gate. Off when absent.",
    },
    release: {
      type: "object",
      additionalProperties: false,
      description: "The release the merge cuts once the first environment of promotion updated.",
      properties: {
        cut: { type: "boolean", default: true, description: "Cut a release once the first stage updated. On when plywood writes a pipeline." },
        label: { type: "string", default: "auto", description: "The release's label, or auto for the next version." },
      },
    },
    recheck: {
      type: "object",
      additionalProperties: false,
      required: ["schedule"],
      description: "How often a promotion a soak holds is tried again.",
      properties: { schedule: { type: "string", description: "A five-field cron line." } },
    },
    config_sets: {
      type: "object",
      description: "Shared sets of config and secrets that environments import.",
      additionalProperties: { type: "object", additionalProperties: false, properties: setSchema },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    const r = doc.risk;
    if (r !== undefined) {
      if (!isObject(r)) out.push(error("risk", "is a map with approve_above and questions"));
      else {
        out.push(...onlyKeys(r, ["approve_above", "questions"], "risk"));
        if (r.approve_above !== undefined && !numberIn(r.approve_above, 0, 1)) out.push(error("risk.approve_above", "is a score from 0 to 1"));
        if (r.questions !== undefined) {
          if (!Array.isArray(r.questions)) out.push(error("risk.questions", "is a list of questions, each with id, text and weight"));
          else r.questions.forEach((q, i) => {
            const k = `risk.questions[${i}]`;
            if (!isObject(q) || typeof q.id !== "string" || !/^[a-z0-9_-]+$/.test(q.id) || typeof q.text !== "string" || !numberIn(q.weight, 0, 1)) out.push(error(k, "has an id (lowercase letters, digits, - and _), the text, and a weight from 0 to 1"));
            else if (q.approve_above !== undefined && !numberIn(q.approve_above, 0, 1)) out.push(error(`${k}.approve_above`, "is a score from 0 to 1"));
          });
        }
      }
    }
    out.push(...stringList(doc.replan_dependents, "replan_dependents"));
    if (doc.release !== undefined) {
      if (!isObject(doc.release)) out.push(error("release", "is a map with cut and label"));
      else {
        out.push(...onlyKeys(doc.release, ["cut", "label"], "release"));
        if (doc.release.cut !== undefined && typeof doc.release.cut !== "boolean") out.push(error("release.cut", "is true or false"));
        if (doc.release.label !== undefined && (typeof doc.release.label !== "string" || doc.release.label === "")) out.push(error("release.label", "is a label, or auto"));
      }
    }
    if (doc.recheck !== undefined) {
      if (!isObject(doc.recheck)) out.push(error("recheck", "is a map with schedule"));
      else out.push(...onlyKeys(doc.recheck, ["schedule"], "recheck"), ...cronProblem(doc.recheck.schedule, "recheck.schedule"));
    }
    if (doc.config_sets !== undefined) {
      if (!isObject(doc.config_sets)) out.push(error("config_sets", "maps each shared set's name to its config, secrets and imports"));
      else {
        const sets = Object.keys(doc.config_sets);
        for (const [name, s] of Object.entries(doc.config_sets)) {
          if (!isObject(s)) out.push(error(`config_sets.${name}`, "is a map of config, secrets and imports"));
          else out.push(...onlyKeys(s, ["config", "secrets", "imports"], `config_sets.${name}`), ...setProblems(s, `config_sets.${name}`, sets));
        }
      }
    }
    const pipelineKeys = (["release", "recheck"] as const).filter((k) => doc[k] !== undefined);
    if (pipelineKeys.length && doc.promotion === undefined) out.push(error(pipelineKeys[0]!, "sets how the pipeline promotes a release, and plywood.yml has no promotion; list the environments in order under promotion"));
    return out;
  },
  translate(doc, out) {
    const risk = ciRiskOf(doc);
    if (risk) out.ci.risk = risk;
    const sets = environmentSetsOf(doc);
    if (sets) out.ci.environmentSets = sets;
  },
};
