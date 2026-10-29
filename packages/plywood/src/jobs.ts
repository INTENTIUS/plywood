/**
 * plywood.yml's `env`, `pass`, `parallelism` and `environments` on the jobs
 * (plywood#29, src/config/jobs.ts):
 *
 *   waves spec   each wave's `variables`; its forge `environment` when all
 *                its stacks share one, else one job group per environment;
 *                `parallelism` on the spec (chant#4625)
 *   drift Ops    each Op's `variables` and its stack's `environment`
 *   pull request `runners`, `variables`, `secrets` and `parallelism` for
 *                chant's product pipeline and `build --pr-loop` (chant#4625)
 *   forge check  each pipeline's `forgeEnvironment`
 *
 * A passed secret is written as the forge's reference to it
 * (`${{ secrets.<name> }}` on GitHub and Forgejo, `$<name>` on GitLab),
 * never as a value. chant#4625 is feature-detected through
 * `@intentius/chant/parallelism`, a module it added; without it the waves
 * and drift jobs still get the variables and environments, which chant had
 * already, and the pull request jobs and `parallelism` say they need it.
 */
import type { ChantRunner, ChantRunnerSpec } from "./chant-config";
import type { ForgeKind } from "./chant-product";
import type { ForgeEnvironment, JobSettings } from "./config/jobs";
import { globMatches } from "./config/images";

let detected: Promise<boolean> | undefined;

/** Whether the installed chant has chant#4625: runners, variables, secrets and parallelism on the pull request jobs, parallelism on op waves. */
export function hasChant4625(): Promise<boolean> {
  detected ??= (async () => {
    try {
      // @ts-ignore: older chants lack the subpath (chant#4625).
      const m: Record<string, unknown> = await import("@intentius/chant/parallelism");
      return typeof m.mapLimited === "function" && typeof m.parallelismProblem === "function";
    } catch {
      return false;
    }
  })();
  return detected;
}

/** Tests say whether chant#4625 is there; `reset` goes back to the real import. */
export function setChant4625ForTests(has: boolean | "reset"): void {
  detected = has === "reset" ? undefined : Promise.resolve(has);
}

/** What `plywood ci` says when plywood.yml asks for something only chant#4625 does. */
export const JOBS_NEED_CHANT = "needs chant's runners, variables, passed secrets and parallelism on the pull request jobs (chant#4625), which this chant lacks";

/** The forge's reference to a secret, as a job's variable value. */
export function secretReference(forge: ForgeKind, secret: string): string {
  return forge === "gitlab" ? `$${secret}` : `\${{ secrets.${secret} }}`;
}

/** `env` and `pass` as one job's variables on `forge`. */
export function jobVariables(forge: ForgeKind, s: Pick<JobSettings, "variables" | "secrets">): Record<string, string> {
  const out: Record<string, string> = { ...s.variables };
  for (const [name, secret] of Object.entries(s.secrets)) {
    // On GitLab every CI/CD variable is in the job already; a secret under its own name needs no line.
    if (forge === "gitlab" && name === secret) continue;
    out[name] = secretReference(forge, secret);
  }
  return out;
}

/** The forge environment `environments` gives `stack`: the first glob that matches it. */
export function environmentFor(stack: string, s: Pick<JobSettings, "environments">): ForgeEnvironment | undefined {
  return s.environments.find((e) => globMatches(e.glob, stack))?.environment;
}

const GROUP_NAME = /[^a-z0-9_-]+/g;

/** A job group's name for an environment: lowercase letters, digits, `-` and `_`. */
export function groupName(environment: ForgeEnvironment | undefined, taken: Set<string>): string {
  let base = environment ? environment.name.toLowerCase().replace(GROUP_NAME, "-").replace(/^-+|-+$/g, "") || "env" : "default";
  if (!/^[a-z0-9]/.test(base)) base = `env-${base}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

interface Wave {
  name: string;
  runs?: Array<{ target: string }>;
  shares?: number;
  groups?: unknown[];
  [k: string]: unknown;
}

/**
 * The waves spec with the jobs' settings on it. A wave whose stacks share
 * an environment runs in it; one whose stacks are in different environments
 * gets a job group per environment (stacks with none in `default`), so each
 * update job holds one environment's protection. A wave already split into
 * shares cannot also split by environment, and is refused by name.
 * `parallelism` goes on the spec only with chant#4625.
 */
export function withJobSettings(spec: Record<string, unknown>, s: JobSettings, forge: ForgeKind, opts: { parallelism: boolean }): Record<string, unknown> {
  const variables = jobVariables(forge, s);
  const waves = (Array.isArray(spec.waves) ? (spec.waves as Wave[]) : []).map((wave) => {
    const out: Wave = { ...wave };
    if (Object.keys(variables).length) out.variables = { ...((wave.variables as Record<string, string> | undefined) ?? {}), ...variables };
    if (s.environments.length === 0) return out;
    const runs = (wave.runs ?? []).map((r) => r.target);
    const byEnv = new Map<string, { environment: ForgeEnvironment | undefined; runs: string[] }>();
    for (const target of runs) {
      const environment = environmentFor(target, s);
      const key = environment ? JSON.stringify(environment) : "";
      const at = byEnv.get(key) ?? { environment, runs: [] };
      at.runs.push(target);
      byEnv.set(key, at);
    }
    delete out.environment;
    delete out.groups;
    if (byEnv.size === 1) {
      const [only] = byEnv.values();
      if (only!.environment) out.environment = { ...only!.environment };
      return out;
    }
    if (wave.shares !== undefined && wave.shares > 1) {
      throw new Error(`wave ${wave.name} holds stacks in ${byEnv.size} environments and is split into ${wave.shares} shares; a wave splits by one or the other, so give its stacks one environment or move them to waves of their own`);
    }
    const taken = new Set<string>();
    out.groups = [...byEnv.values()].map((g) => ({ name: groupName(g.environment, taken), runs: g.runs, ...(g.environment ? { environment: { ...g.environment } } : {}) }));
    return out;
  });
  return { ...spec, waves, ...(opts.parallelism && s.parallelism !== undefined && spec.step !== undefined ? { parallelism: s.parallelism } : {}) };
}

/** chant#4625's runner stages from plywood's: preview is plan, up is apply. */
export function prLoopRunners(runner: ChantRunner | undefined): { plan?: ChantRunnerSpec; apply?: ChantRunnerSpec; default?: ChantRunnerSpec } | undefined {
  if (runner === undefined) return undefined;
  if (typeof runner === "string" || Array.isArray(runner) || "group" in runner) return { default: runner as ChantRunnerSpec };
  const staged = runner as Partial<Record<"default" | "preview" | "up" | "drift", ChantRunnerSpec>>;
  const out = { ...(staged.preview ? { plan: staged.preview } : {}), ...(staged.up ? { apply: staged.up } : {}), ...(staged.default ? { default: staged.default } : {}) };
  return Object.keys(out).length ? out : undefined;
}

/** The pull request pipeline's options from chant#4625, for `productPipelineJobs`. */
export function prLoopJobOptions(s: JobSettings | undefined, runner: ChantRunner | undefined): Record<string, unknown> {
  const runners = prLoopRunners(runner);
  return {
    ...(runners ? { runners } : {}),
    ...(s && Object.keys(s.variables).length ? { variables: { ...s.variables } } : {}),
    ...(s && Object.keys(s.secrets).length ? { secrets: { ...s.secrets } } : {}),
    ...(s?.parallelism !== undefined ? { parallelism: s.parallelism } : {}),
  };
}

/**
 * The same as `chant build --pr-loop` flags (chant#4625). `--pr-runner` takes
 * labels, so a GitHub runner group reaches the pull request jobs only
 * through `productPipelineJobs`; `notes` says so.
 */
export function prLoopJobFlags(s: JobSettings | undefined, runner: ChantRunner | undefined): { flags: string[]; notes: string[] } {
  const flags: string[] = [];
  const notes: string[] = [];
  for (const [stage, spec] of Object.entries(prLoopRunners(runner) ?? {})) {
    if (typeof spec === "string") flags.push("--pr-runner", `${stage}=${spec}`);
    else if (Array.isArray(spec)) flags.push("--pr-runner", `${stage}=${spec.join(",")}`);
    else notes.push(`runners: the ${stage === "plan" ? "preview" : stage === "apply" ? "up" : "default"} runner group ${spec.group} is GitHub's, and chant's pull request generator takes labels; its jobs keep the forge's default runner`);
  }
  for (const [name, value] of Object.entries(s?.variables ?? {})) flags.push("--pr-variable", `${name}=${value}`);
  for (const [name, secret] of Object.entries(s?.secrets ?? {})) flags.push("--pr-secret", `${name}=${secret}`);
  if (s?.parallelism !== undefined) flags.push("--parallelism", String(s.parallelism));
  return { flags, notes };
}

/** Whether plywood.yml asks the pull request jobs for anything only chant#4625 gives them. */
export function wantsChant4625(s: JobSettings | undefined, runner: ChantRunner | undefined): boolean {
  return runner !== undefined || (s !== undefined && (Object.keys(s.variables).length > 0 || Object.keys(s.secrets).length > 0 || s.parallelism !== undefined));
}

/** The pull request jobs' part of the settings, for `plywood init` and `plywood ci`: chant's options and build flags with chant#4625, else a note when plywood.yml asks for them. */
export async function prJobsFor(pipeline: { jobs?: JobSettings; runner?: ChantRunner }): Promise<{ options: Record<string, unknown>; flags: string[]; notes: string[] }> {
  if (!wantsChant4625(pipeline.jobs, pipeline.runner)) return { options: {}, flags: [], notes: [] };
  if (!(await hasChant4625())) {
    const asked = [
      ...(pipeline.runner !== undefined ? ["runners"] : []),
      ...(pipeline.jobs && Object.keys(pipeline.jobs.variables).length ? ["env"] : []),
      ...(pipeline.jobs && Object.keys(pipeline.jobs.secrets).length ? ["pass"] : []),
      ...(pipeline.jobs?.parallelism !== undefined ? ["parallelism"] : []),
    ];
    return { options: {}, flags: [], notes: [`${asked.join(", ")} on the pull request jobs ${JOBS_NEED_CHANT}; the waves and drift jobs have ${asked.filter((k) => k !== "parallelism").join(", ") || "none of them"}`] };
  }
  const { flags, notes } = prLoopJobFlags(pipeline.jobs, pipeline.runner);
  return { options: prLoopJobOptions(pipeline.jobs, pipeline.runner), flags, notes };
}
