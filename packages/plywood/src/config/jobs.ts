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
 *   environments  stack glob to a forge     each update job's deployment
 *                 environment               environment, and the forge check's
 *
 * The translation is in src/jobs.ts, which puts the settings on the waves
 * spec, the drift Ops and the pull request pipeline.
 */
import type { JsonSchema } from "./types";
import { error, isObject, warning, type ConfigGroup, type ConfigProblem } from "./types";
import { globMatches } from "./images";

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
  /** `environments`, in file order: the first glob that matches a stack wins. */
  environments: Array<{ glob: string; environment: ForgeEnvironment }>;
}

const environmentSchema: JsonSchema = {
  anyOf: [
    { type: "string", minLength: 1 },
    { type: "object", additionalProperties: false, required: ["name"], properties: { name: { type: "string", minLength: 1 }, url: { type: "string" } } },
  ],
};

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

/** `environments` in file order. */
export function environmentsOf(v: unknown): JobSettings["environments"] {
  if (!isObject(v)) return [];
  return Object.entries(v).flatMap(([glob, e]) => {
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
    environments: environmentsOf(doc.environments),
  };
}

export const jobs: ConfigGroup = {
  name: "jobs",
  keys: ["env", "pass", "parallelism", "environments"],
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
      ],
    },
    parallelism: {
      description: "The most stacks a pull request previews at once in a wave, and the most a wave updates at once. Default: every stack of a wave at once in a preview, one at a time in an update.",
      type: "integer",
      minimum: 1,
    },
    environments: {
      description: "Stack glob to the forge deployment environment its update jobs run in (GitHub and GitLab): a name, or a map with name and url. The first glob that matches a stack wins; stacks of one wave in different environments run in one job each.",
      type: "object",
      additionalProperties: environmentSchema,
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
    if (doc.environments !== undefined) {
      if (!isObject(doc.environments)) out.push(error("environments", "must be a mapping of stack glob to environment"));
      else {
        const forge = isObject(doc.forge) ? doc.forge.kind : undefined;
        if (forge === "forgejo") out.push(error("environments", "Forgejo has no deployment environments; leave environments out, or give forge.kind github or gitlab"));
        const listed = isObject(doc.stacks) ? Object.keys(doc.stacks) : [];
        for (const [glob, e] of Object.entries(doc.environments)) {
          const named = typeof e === "string" ? e : isObject(e) ? e.name : undefined;
          if (typeof named !== "string" || named.trim() === "") out.push(error(`environments.${glob}`, "must name the environment, as the forge spells it, or be a mapping with name and url"));
          else if (isObject(e) && Object.keys(e).some((k) => k !== "name" && k !== "url")) out.push(error(`environments.${glob}`, "takes name and url"));
          if (listed.length > 0 && !listed.some((s) => globMatches(glob, s))) out.push(warning(`environments.${glob}`, "matches no stack under stacks"));
        }
      }
    }
    return out;
  },
  translate(doc, out) {
    const s = jobSettingsOf(doc);
    if (Object.keys(s.variables).length || Object.keys(s.secrets).length || s.parallelism !== undefined || s.environments.length) out.pipeline.jobs = s;
  },
};
