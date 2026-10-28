/**
 * `plywood init --engine`: the engine step of init.
 *
 * With no flag the step writes nothing, and chant's pulumi lexicon decides
 * per stack from a `plunge+` backend, PULUMI_BACKEND_URL or Pulumi.yaml
 * (chant#4559). `--engine pulumi` writes `engine: pulumi`.
 *
 * `--engine plunge` reads each stack's current backend (PULUMI_BACKEND_URL,
 * then Pulumi.yaml's backend.url, src/init/backend.ts) and gives it
 * `plunge+<same url>` in plywood.yml. plunge keeps its records beside the
 * stock state at the same root, so Pulumi.yaml and Pulumi.<stack>.yaml stay
 * as they are, and chant reports engine plunge for the stack from
 * plywood.yml alone. plunge has a `plunge+` form for file, s3, azblob and gs
 * (plunge pkg/backend/plunge/url.go); a Pulumi Cloud stack, or one on a
 * backend with no such form (Postgres), gets the guide that moves it in
 * place of a URL. init never picks plunge without the flag.
 *
 * When every stack can move and they share one backend, plywood.yml gets
 * `engine: plunge` and that `backend`. When they differ, each stack gets its
 * own `stacks.<project/stack>.backend`, and `engine: plunge` is written only
 * when every stack has one; a stack left on Pulumi Cloud stays on stock
 * Pulumi. The bucket check (src/init.ts bucketStep) and the adopt previews
 * (src/init/adopt.ts) then run on the URLs plywood.yml names.
 */
import type { RawConfig } from "../config/types";
import { PLUNGE_URL } from "../config/engine";
import { backendOf, isPulumiCloud, type StackBackend } from "./backend";
import type { Detected } from "./detect";

export const INIT_ENGINES = ["pulumi", "plunge"] as const;
export type InitEngine = (typeof INIT_ENGINES)[number];

/** The site page that moves a Pulumi Cloud stack onto a bucket, then onto plunge with `adopt --file`. */
export const MOVE_A_STACK_GUIDE = "https://intentius.io/plywood/guides/move-a-stack-backend/";

/** The DIY backend schemes plunge opens as `plunge+<url>` (plunge url.go). */
const PLUNGE_FORMS = /^(?:file|s3|azblob|gs):\/\//;

/** What the engine step hands back to init. */
export interface EngineStep {
  /** Keys for a new plywood.yml. */
  keys: RawConfig;
  /** Lines init prints under the files it wrote. */
  notes: string[];
  /** Each stack's move onto plunge, with `--engine plunge`. */
  plunge?: PlungeStack[];
}

export interface EngineStepInput {
  engine: InitEngine | undefined;
  detected: Detected;
  env: NodeJS.ProcessEnv;
}

/** One stack under `--engine plunge`: its backend now, and its plunge URL or why it has none. */
export interface PlungeStack {
  key: string;
  project: string;
  stack: string;
  dir: string;
  /** The backend the stack opens today, absent for Pulumi Cloud by login. */
  current?: string;
  source: StackBackend["source"];
  /** `plunge+<current>`, when plunge can open the stack's backend. */
  url?: string;
  /** Why the stack gets no plunge URL. */
  pointer?: string;
}

/** The plunge URL for a backend URL, or why there is none. */
export function plungeUrlOf(url: string | undefined): { url: string } | { pointer: string } {
  if (url !== undefined && PLUNGE_URL.test(url)) return { url };
  if (isPulumiCloud(url)) {
    return {
      pointer:
        `is on Pulumi Cloud${url ? ` (${url})` : ""}, which plunge does not open. Export the stack, move it to a bucket, ` +
        `and adopt the export with plunge stack adopt --file: ${MOVE_A_STACK_GUIDE}`,
    };
  }
  if (PLUNGE_FORMS.test(url!)) return { url: `plunge+${url}` };
  const scheme = url!.split("://")[0];
  return { pointer: `is on ${url}, and plunge has no plunge+ form for ${scheme}. Move it to a file, s3, azblob or gs backend first: ${MOVE_A_STACK_GUIDE}` };
}

/** Each found stack's plunge move, from the backend it opens today. */
export function plungeStacks(detected: Detected, env: NodeJS.ProcessEnv): PlungeStack[] {
  return detected.stacks.map((s) => {
    const project = detected.projects.find((p) => p.dir === s.dir && p.name === s.project) ?? { backendUrl: undefined };
    const b = backendOf(project, {}, env);
    const to = plungeUrlOf(b.url);
    return {
      key: s.key,
      project: s.project,
      stack: s.stack,
      dir: s.dir,
      ...(b.url !== undefined ? { current: b.url } : {}),
      source: b.source,
      ...("url" in to ? { url: to.url } : { pointer: to.pointer }),
    };
  });
}

/** plywood.yml's keys for the stacks that move: one shared `backend`, else one per stack. */
export function plungeKeys(stacks: readonly PlungeStack[]): RawConfig {
  const moving = stacks.filter((s) => s.url !== undefined);
  if (moving.length === 0) return {};
  const all = moving.length === stacks.length;
  const urls = new Set(moving.map((s) => s.url));
  if (all && urls.size === 1) return { engine: "plunge", backend: moving[0]!.url };
  const per: Record<string, RawConfig> = {};
  for (const s of moving) per[s.key] = { ...(s.dir !== "." ? { dir: s.dir } : {}), backend: s.url };
  return { ...(all ? { engine: "plunge" } : {}), stacks: per };
}

/** The lines init prints for the plunge move. */
export function plungeLines(stacks: readonly PlungeStack[]): string[] {
  if (stacks.length === 0) return ["--engine plunge: no stack was found, so no plunge backend is written"];
  const out = ["plunge backends (Pulumi.yaml and Pulumi.<stack>.yaml are unchanged; plunge keeps its records beside the stock state):"];
  for (const s of stacks) {
    if (s.url) out.push(`  ${s.key}: ${s.url}${s.current && s.current !== s.url ? `, the same root as ${s.current} (${s.source})` : ""}`);
    else out.push(`  ${s.key} ${s.pointer}`);
  }
  if (stacks.every((s) => !s.url)) out.push("  No stack can move yet, so plywood.yml names no engine and the stacks stay on stock Pulumi.");
  else if (stacks.some((s) => !s.url)) out.push("  The stacks without a plunge URL stay on stock Pulumi until they move.");
  return out;
}

/** The engine step for a new plywood.yml. */
export function engineStep(input: EngineStepInput): EngineStep {
  if (input.engine === undefined) return { keys: {}, notes: [] };
  if (input.engine === "pulumi") return { keys: { engine: "pulumi" }, notes: [] };
  const stacks = plungeStacks(input.detected, input.env);
  return { keys: plungeKeys(stacks), notes: plungeLines(stacks), plunge: stacks };
}
