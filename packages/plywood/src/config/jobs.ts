/**
 * `env`, `pass`, `parallelism` and `environments`: what the jobs run with
 * (plywood#29).
 *
 *   env           variable to value         each job's variables: the waves,
 *                                           the drift Ops and, with chant#4625,
 *                                           the pull request jobs
 *   pass          secret names, or          secrets passed as variables, by
 *                 variable to secret        name, never a value
 *   parallelism   a whole number            stacks previewed at once in a wave
 *                                           and runs updated at once in a wave
 *                                           (chant#4625)
 *   forge_environments  stack glob to a     each update job's deployment
 *                 forge environment         environment, and the forge check's.
 *                                           A name or a { name, url } entry
 *                                           under `environments` is its
 *                                           earlier spelling; a mapping of
 *                                           stage keys there is a stage
 *                                           (src/config/promotion.ts)
 *
 * The translation is in src/jobs.ts, which puts the settings on the waves
 * spec, the drift Ops and the pull request pipeline.
 */
import type { JsonSchema } from "./types";
import { error, isObject, warning, type ConfigGroup, type ConfigProblem } from "./types";
import { globMatches } from "./images";
import { isForgeEnvironmentEntry, isStageEntry } from "./promotion";
import { STAGE_ENTRY_SCHEMA } from "./stage";

/** A variable name, as every forge reads one. */
export const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Names the jobs set or drop themselves, which `env` and `pass` cannot take (chant's `prLoopPassedEnv` refuses them too). */
export const RESERVED_VARIABLES: readonly string[] = [
  "GITHUB_TOKEN", "GITEA_TOKEN", "FORGEJO_TOKEN", "CI_JOB_TOKEN", "GITLAB_TOKEN", "CHANT_FORGE_TOKEN",
  "ACTIONS_ID_TOKEN_REQUEST_URL", "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "BASE_SHA", "PR_NUMBER", "HEAD_SHA", "GREEN_SHA", "CHANT_RUN_EVENTS_DIR", "CHANT_RUNNER_KEY",
];

/** One forge environment: its name as the forge spells it, and the URL its deployments show. */
export interface ForgeEnvironment {
  name: string;
  url?: string;
}

/** What the group hands src/jobs.ts. */
export interface JobSettings {
  /** `env`: plain variables. */
  variables: Record<string, string>;
  /** `pass`: variable to the forge secret it is read from. */
  secrets: Record<string, string>;
  parallelism?: number;
  /** `forge_environments`, then the globs `environments` names in the earlier spelling, in file order: the first glob that matches a stack wins. */
  environments: Array<{ glob: string; environment: ForgeEnvironment }>;
}

const environmentSchema: JsonSchema = {
  anyOf: [
    { type: "string", minLength: 1 },
    { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1 }, url: { type: "string" } } },
  ],
};

/** `environments.<name>` as a stage of promotion (src/config/promotion.ts, src/config/stage.ts): its stacks there and the stage keys. */
const stageSchema: JsonSchema = STAGE_ENTRY_SCHEMA;

function variableProblems(name: string, key: string): ConfigProblem[] {
  if (!VARIABLE.test(name)) return [error(key, `${JSON.stringify(name)} is not a variable name: letters, digits and _, not starting with a digit`)];
  if (RESERVED_VARIABLES.includes(name)) return [error(key, `${name} is a name the jobs set or drop themselves, and a forge token never reaches the code a preview runs; use another name`)];
  return [];
}

/** `pass` as variable to secret: a list passes each secret under its own name. */
export function passedSecrets(v: unknown): Record<string, string> {
  if (Array.isArray(v)) return Object.fromEntries(v.filter((s): s is string => typeof s === "string").map((s) => [s, s]));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === "string"));
  return {};
}

/**
 * Each stack glob's forge environment, with the key it was written under:
 * `forge_environments`, then each glob entry of `environments` (the earlier
 * spelling) that `forge_environments` does not name. A stage entry under
 * `environments` is promotion's (src/config/promotion.ts), not a glob's.
 */
export function forgeEnvironmentEntries(doc: Record<string, unknown>): Array<{ key: string; glob: string; value: unknown }> {
  const own = isObject(doc.forge_environments) ? Object.entries(doc.forge_environments).map(([glob, value]) => ({ key: `forge_environments.${glob}`, glob, value })) : [];
  const named = new Set(own.map((e) => e.glob));
  const earlier = isObject(doc.environments)
    ? Object.entries(doc.environments)
        .filter(([glob, value]) => !isStageEntry(value) && !named.has(glob))
        .map(([glob, value]) => ({ key: `environments.${glob}`, glob, value }))
    : [];
  return [...own, ...earlier];
}

/** Each stack glob's forge environment in file order, from `forge_environments` and the earlier spelling under `environments`. */
export function environmentsOf(doc: Record<string, unknown>): JobSettings["environments"] {
  return forgeEnvironmentEntries(doc).flatMap(({ glob, value: e }) => {
    if (typeof e === "string") return [{ glob, environment: { name: e } }];
    if (isObject(e) && typeof e.name === "string") return [{ glob, environment: { name: e.name, ...(typeof e.url === "string" ? { url: e.url } : {}) } }];
    return [];
  });
}

/** The group's settings, from a config that checked clean. */
export function jobSettingsOf(doc: Record<string, unknown>): JobSettings {
  const variables = isObject(doc.env) ? Object.fromEntries(Object.entries(doc.env).map(([k, v]) => [k, String(v)])) : {};
  return {
    variables,
    secrets: passedSecrets(doc.pass),
    ...(typeof doc.parallelism === "number" ? { parallelism: doc.parallelism } : {}),
    environments: environmentsOf(doc),
  };
}

export const jobs: ConfigGroup = {
  name: "jobs",
  keys: ["env", "pass", "parallelism", "forge_environments", "environments"],
  schema: {
    env: {
      description: "Variables every job runs with: the waves, the drift jobs and the pull request jobs. Values are written into the workflow, so put a secret under pass.",
      type: "object",
      propertyNames: { pattern: VARIABLE.source },
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
    pass: {
      description: "Secrets the jobs read as variables, named and never written: a list of secret names, each passed under its own name, or a map of variable to secret.",
      anyOf: [
        { type: "array", items: { type: "string", pattern: VARIABLE.source }, uniqueItems: true },
        { type: "object", propertyNames: { pattern: VARIABLE.source }, additionalProperties: { type: "string", pattern: VARIABLE.source } },
        { type: "object", additionalProperties: false, required: ["secrets"], properties: { secrets: { type: "array", items: { type: "string", pattern: VARIABLE.source }, uniqueItems: true } } },
      ],
    },
    parallelism: {
      description: "The most stacks a pull request previews at once in a wave, and the most a wave updates at once. Default: every stack of a wave at once in a preview, one at a time in an update.",
      type: "integer",
      minimum: 1,
    },
    forge_environments: {
      description: "Stack glob to the forge deployment environment its update jobs run in (GitHub and GitLab): a name, or a map with name and url. The first glob that matches a stack wins; stacks of one wave in different environments run in one job each.",
      type: "object",
      additionalProperties: environmentSchema,
    },
    environments: {
      description: "Each environment of promotion to its stage keys: targets (each project to the stack it updates there), its gate, hold, freeze, soak, risk and the rest. An entry that is a name, or a map with name and url, is read as forge_environments, its earlier spelling.",
      type: "object",
      additionalProperties: { anyOf: [stageSchema, environmentSchema] },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    if (doc.env !== undefined) {
      if (!isObject(doc.env)) out.push(error("env", "must be a mapping of variable to value"));
      else
        for (const [k, v] of Object.entries(doc.env)) {
          out.push(...variableProblems(k, `env.${k}`));
          if (!["string", "number", "boolean"].includes(typeof v)) out.push(error(`env.${k}`, "must be a string, a number or true or false"));
        }
    }
    if (doc.pass !== undefined) {
      if (!Array.isArray(doc.pass) && !isObject(doc.pass)) out.push(error("pass", "must be a list of secret names, or a mapping of variable to secret"));
      else if (Array.isArray(doc.pass) && doc.pass.some((s) => typeof s !== "string")) out.push(error("pass", "must be a list of secret names"));
      else if (isObject(doc.pass) && Object.values(doc.pass).some((s) => typeof s !== "string")) out.push(error("pass", "maps each variable to the name of a secret, never its value"));
      else
        for (const [k, secret] of Object.entries(passedSecrets(doc.pass))) {
          out.push(...variableProblems(k, `pass.${k}`));
          if (!VARIABLE.test(secret)) out.push(error(`pass.${k}`, `${JSON.stringify(secret)} is not a secret name`));
          if (isObject(doc.env) && k in doc.env) out.push(error(`pass.${k}`, `${k} is under env too; a variable is a value or a passed secret, not both`));
        }
    }
    if (doc.parallelism !== undefined && !(typeof doc.parallelism === "number" && Number.isInteger(doc.parallelism) && doc.parallelism >= 1)) {
      out.push(error("parallelism", "must be a whole number of 1 or more"));
    }
    if (doc.forge_environments !== undefined && !isObject(doc.forge_environments)) out.push(error("forge_environments", "must be a mapping of stack glob to environment"));
    if (doc.environments !== undefined && !isObject(doc.environments)) out.push(error("environments", "must be a mapping of environment to its stage keys"));
    // A stage entry under environments is promotion's, checked in src/config/promotion.ts; a name or { name, url } there is forge_environments' earlier spelling.
    const globs = forgeEnvironmentEntries(doc);
    if (globs.length > 0) {
      const forge = isObject(doc.forge) ? doc.forge.kind : undefined;
      if (forge === "forgejo") out.push(error(globs[0]!.key.split(".")[0]!, "Forgejo has no deployment environments; leave forge_environments out, or give forge.kind github or gitlab"));
      const listed = isObject(doc.stacks) ? Object.keys(doc.stacks) : [];
      for (const { key, glob, value: e } of globs) {
        const named = typeof e === "string" ? e : isObject(e) ? e.name : undefined;
        if (typeof named !== "string" || named.trim() === "") out.push(error(key, "must name the environment, as the forge spells it, or be a mapping with name and url"));
        else if (isObject(e) && !isForgeEnvironmentEntry(e)) out.push(error(key, "takes name and url"));
        if (listed.length > 0 && !listed.some((s) => globMatches(glob, s))) out.push(warning(key, "matches no stack under stacks"));
      }
    }
    if (isObject(doc.forge_environments) && isObject(doc.environments)) {
      for (const glob of Object.keys(doc.forge_environments)) if (isForgeEnvironmentEntry(doc.environments[glob])) out.push(error(`environments.${glob}`, "is forge_environments' earlier spelling, and forge_environments names the same glob; keep one"));
    }
    return out;
  },
  translate(doc, out) {
    const s = jobSettingsOf(doc);
    if (Object.keys(s.variables).length || Object.keys(s.secrets).length || s.parallelism !== undefined || s.environments.length) out.pipeline.jobs = s;
  },
};
