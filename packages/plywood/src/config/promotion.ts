/**
 * `promotion` and `environments.<name>.targets`: the order a release moves
 * through the environments, and the stack each project updates in each one
 * (the words of chant's CI product config page).
 *
 *   promotion                              a list of environment names, first
 *                                          to last; chant.config.ts lists them
 *                                          as `environments`, which chant's
 *                                          promotion order reads
 *   environments.<name>.targets.<project>  the stack the project updates in
 *                                          that environment, when its name
 *                                          does not say so
 *
 * A stack glob's forge deployment environment is `forge_environments`
 * (src/config/jobs.ts). `environments` took those globs before it held
 * stages, and still reads them: an entry whose value is a name, or a mapping
 * of `name` and `url`, is a glob's, read as `forge_environments`; any other
 * mapping is a stage entry.
 *
 * With `promotion`, plywood init writes one component per project, whose
 * `pulumi-up` step carries an `environments` map with each environment's
 * stack. chant resolves the entry for the environment a promote, rollback or
 * redeploy acts on before the step runs, so `plywood promote --to staging`
 * updates the staging stacks only.
 *
 * A project takes one stack per environment, and each of its stacks is one
 * environment's target. Without `targets`, an environment's stack is the one
 * named after it (`shop/staging` for `staging`), else the one whose name's
 * environment part is it (`shop/prod-east` for `prod`).
 */
import type { ChantGatePolicy } from "../chant-config";
import { environmentOf } from "../init/detect";
import { gateOf } from "./approval";
import { stacksOf } from "./stacks";
import { stageEntryProblems, STAGE_ENTRY_KEYS } from "./stage";
import { error, isObject, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";

/** An environment name: lowercase letters, digits, `-` and `_`, as chant names an environment. */
export const ENVIRONMENT_NAME = /^[a-z0-9][a-z0-9_-]*$/;

/** The keys a stage entry under `environments.<name>` takes: `targets` and the stage keys (src/config/stage.ts). */
export const STAGE_KEYS = STAGE_ENTRY_KEYS;

/** The pull request environments chant names `pr-<n>`, which no stage may take. */
const PR_ENVIRONMENT = /^pr-[0-9]+$/;

/** `promotion` as written, or undefined when plywood.yml leaves it out. */
export function promotionOf(doc: RawConfig): string[] | undefined {
  return Array.isArray(doc.promotion) && doc.promotion.every((e) => typeof e === "string") ? (doc.promotion as string[]) : undefined;
}

/**
 * Whether an `environments` value is a glob's forge environment, the form
 * `forge_environments` takes and `environments` took before stages: a name,
 * or a mapping of `name` and `url`.
 */
export function isForgeEnvironmentEntry(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length > 0 && keys.every((k) => k === "name" || k === "url");
}

/**
 * Whether an `environments` entry is a stage entry: a mapping of stage keys
 * (src/config/stage.ts), any mapping that is not a glob's forge environment.
 * A mapping with a key no stage takes is a stage entry too, and the stage
 * check names the key.
 */
export function isStageEntry(value: unknown): value is { targets?: unknown } & Record<string, unknown> {
  return isObject(value) && !isForgeEnvironmentEntry(value);
}

/** Each stage entry's targets: environment to project to the stack written there. */
export function stageTargetsOf(doc: RawConfig): Record<string, Record<string, string>> {
  if (!isObject(doc.environments)) return {};
  const out: Record<string, Record<string, string>> = {};
  for (const [env, entry] of Object.entries(doc.environments)) {
    if (!isStageEntry(entry) || !isObject(entry.targets)) continue;
    out[env] = Object.fromEntries(Object.entries(entry.targets).filter((e): e is [string, string] => typeof e[1] === "string"));
  }
  return out;
}

/** The environment `plywood ci`, `init` and `preview` plan in: promotion's first, else `production`. */
export function planEnvironment(doc: RawConfig): string {
  return promotionOf(doc)?.[0] ?? "production";
}

/** A stack as the promotion reads it. */
export interface PromotionStack {
  /** `project/stack`, plywood.yml's key. */
  key: string;
  project: string;
  stack: string;
}

/** One project's stack in each environment of `promotion`. */
export interface PromotionProject {
  project: string;
  /** Environment to the stack key it updates there, in promotion's order. */
  byEnv: Record<string, string>;
}

/** The stacks each project updates per environment, and what stops that from being settled. */
export interface PromotionTargets {
  projects: PromotionProject[];
  problems: string[];
}

/**
 * Each project's stack in each environment of `promotion`: the one
 * `targets` names, else the stack named after the environment, else the one
 * whose environment part is it. A project lacking a stack in an
 * environment, holding two there, or keeping a stack no environment takes is
 * a problem, since a release updates one stack of a project per environment.
 */
export function promotionTargets(promotion: readonly string[], stacks: readonly PromotionStack[], targets: Readonly<Record<string, Readonly<Record<string, string>>>> = {}): PromotionTargets {
  const problems: string[] = [];
  const byProject = new Map<string, PromotionStack[]>();
  for (const s of stacks) byProject.set(s.project, [...(byProject.get(s.project) ?? []), s]);
  for (const [env, named] of Object.entries(targets)) {
    for (const project of Object.keys(named)) {
      if (!byProject.has(project)) problems.push(`environments.${env}.targets.${project} names a project with no stack; the projects are ${[...byProject.keys()].join(", ") || "none"}`);
    }
  }
  const projects: PromotionProject[] = [];
  for (const [project, own] of byProject) {
    const byEnv: Record<string, string> = {};
    for (const env of promotion) {
      const written = targets[env]?.[project];
      if (written !== undefined) {
        const key = written.includes("/") ? written : `${project}/${written}`;
        if (own.some((s) => s.key === key)) byEnv[env] = key;
        else problems.push(`environments.${env}.targets.${project} is ${written}, which is not a stack of ${project}; its stacks are ${own.map((s) => s.key).join(", ")}`);
        continue;
      }
      const exact = own.filter((s) => s.stack === env);
      const found = exact.length > 0 ? exact : own.filter((s) => environmentOf(s.stack) === env);
      if (found.length === 1) byEnv[env] = found[0]!.key;
      else if (found.length === 0) problems.push(`${project} has no stack for environment ${env}; name one under environments.${env}.targets.${project}`);
      else problems.push(`${project} has ${found.map((s) => s.key).join(" and ")} in environment ${env}, and an environment takes one stack of a project; name one under environments.${env}.targets.${project}, or list each as an environment of its own in promotion`);
    }
    const used = Object.values(byEnv);
    for (const s of own) {
      const times = used.filter((k) => k === s.key).length;
      if (times === 0) problems.push(`${s.key} is no environment's stack; add its environment to promotion, or name it under environments.<name>.targets.${project}`);
      if (times > 1) problems.push(`${s.key} is the stack of ${times} environments of promotion; each environment of ${project} takes a stack of its own`);
    }
    projects.push({ project, byEnv });
  }
  return { projects, problems };
}

/** The gate of each environment of a project: its stack's `gate`, else the top-level gate. */
export function stageGates(doc: RawConfig, project: PromotionProject): Record<string, ChantGatePolicy> {
  const listed = stacksOf(doc);
  return Object.fromEntries(Object.entries(project.byEnv).map(([env, key]) => [env, listed[key]?.gate ?? gateOf(doc)]));
}

/** The stacks plywood.yml lists, as the promotion reads them. */
export function listedPromotionStacks(doc: RawConfig): PromotionStack[] {
  return Object.keys(stacksOf(doc)).flatMap((key) => {
    const [project, stack] = key.split("/");
    return project && stack ? [{ key, project, stack }] : [];
  });
}

export const promotion: ConfigGroup = {
  name: "promotion",
  keys: ["promotion"],
  schema: {
    promotion: {
      type: "array",
      minItems: 2,
      uniqueItems: true,
      items: { type: "string", pattern: ENVIRONMENT_NAME.source },
      description:
        "The order a release moves through the environments, first to last. The merge updates the first environment's stacks, and plywood promote carries a release to each next one behind its gate. Each project takes one stack per environment: the one named after it, or the one environments.<name>.targets names. Off when absent.",
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [];
    const p = doc.promotion;
    const stageEntries = isObject(doc.environments) ? Object.entries(doc.environments).filter(([, e]) => isStageEntry(e)) : [];
    if (p === undefined) {
      for (const [env, entry] of stageEntries) {
        const first = Object.keys(entry as Record<string, unknown>).find((k) => (STAGE_KEYS as readonly string[]).includes(k)) ?? "targets";
        out.push(error(`environments.${env}.${first}`, first === "targets" ? "names a stack for a stage, and plywood.yml has no promotion; list the environments in order under promotion" : "sets a stage, and plywood.yml has no promotion; list the environments in order under promotion"));
      }
      return out;
    }
    if (!Array.isArray(p) || p.some((e) => typeof e !== "string")) return [error("promotion", "must be a list of environment names, first to last")];
    const names = p as string[];
    if (names.length < 2) out.push(error("promotion", "lists at least two environments: a release is cut in the first and promoted to the next"));
    for (const name of names) {
      if (!ENVIRONMENT_NAME.test(name)) out.push(error("promotion", `${JSON.stringify(name)} is not an environment name: lowercase letters, digits, - and _, with no pattern`));
      else if (PR_ENVIRONMENT.test(name)) out.push(error("promotion", `${name} is the name of a pull request's environment; give the stage another name`));
    }
    const twice = names.filter((n, i) => names.indexOf(n) !== i);
    if (twice.length) out.push(error("promotion", `lists ${[...new Set(twice)].join(", ")} twice; each environment comes once`));
    for (const [env, entry] of stageEntries) {
      const e = entry as Record<string, unknown>;
      if (!names.includes(env)) out.push(error(`environments.${env}`, `is a stage, and promotion does not list ${env}`));
      if (e.targets !== undefined && (!isObject(e.targets) || Object.values(e.targets).some((v) => typeof v !== "string" || v === ""))) {
        out.push(error(`environments.${env}.targets`, "maps each project to the stack it updates in the environment, as stack or project/stack"));
      }
      // plywood#156: the stage keys, as chant's vocabulary names them.
      out.push(...stageEntryProblems(env, e, doc, names));
    }
    const listed = listedPromotionStacks(doc);
    if (out.length === 0 && listed.length > 0) {
      for (const problem of promotionTargets(names, listed, stageTargetsOf(doc)).problems) out.push(error("promotion", problem));
    }
    return out;
  },
  translate() {},
};
