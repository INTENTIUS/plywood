/**
 * The files `plywood init` writes besides the workflow, as text or JSON:
 *
 *   plywood.yml                         only the keys detection could not settle
 *   chant.workspace.json                the member picture: one member of chant's
 *                                       `pulumi` kind per Pulumi.yaml, which
 *                                       `chant workspace graph` and behold read,
 *                                       and the `ci` block plywood.yml sets
 *   chant.config.ts                     the chant project, with the pulumi lexicon
 *   plywood.component.ts                one chant component per stack, whose
 *                                       `pulumi-up` step previews and updates it
 *   .chant/op-waves/pulumi-up.spec.json the waves a merge updates in, read at base
 *
 * Each is a pure function of what init detected and plywood.yml, so a
 * second run gives the same bytes and writes nothing.
 */
import { emitYAMLEntry } from "@intentius/chant/yaml";
import type { ChantCiSettings, ChantGatePolicy, ChantRunner, ChantRunnerSpec } from "../chant-config";
import type { PolicyPack } from "../config/policy";
import type { RawConfig } from "../config/types";
import { fill, template } from "../templates";
import { OP_NAME, PR_GATE } from "../words";
import { environmentOf, slug, type DetectedProject } from "./detect";

/** One stack as init settles it. */
export interface InitStack {
  /** `project/stack`, plywood.yml's key. */
  key: string;
  project: string;
  stack: string;
  dir: string;
  engine?: "pulumi" | "plunge";
  gate?: ChantGatePolicy;
  /** chant's lock grain (chant#4552): `resource`, or `target` for plywood's `stack`. */
  lockGrain?: "resource" | "target";
  /** CrossGuard packs the stack's preview and update run, relative to its directory (plywood.yml `policy.packs`). */
  policyPacks?: PolicyPack[];
}

/** plywood.yml's text: the template's header and the keys, in the order given. */
export function plywoodYml(keys: RawConfig): string {
  const body = Object.entries(keys)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => emitYAMLEntry(k, v))
    .join("\n");
  const text = fill(template("plywood.yml"), { keys: body });
  return text.endsWith("\n") ? text : text + "\n";
}

/** The chant project's config, from the template. */
export function chantConfigTs(): string {
  return template("chant.config.ts.tmpl");
}

/** A component name chant takes: lowercase letters, digits and `-`. */
export function componentName(stack: Pick<InitStack, "key">): string {
  return slug(stack.key);
}

/** A TypeScript identifier for a stack's export. */
function exportName(stack: Pick<InitStack, "key">, taken: Set<string>): string {
  let base = stack.key.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (base === "" || /^\d/.test(base)) base = `stack_${base}`;
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  taken.add(name);
  return name;
}

/** The `pulumi-up` step input for a stack (chant pulumi lexicon `PulumiUpStepInput`). */
export function stepInput(s: InitStack): Record<string, unknown> {
  return {
    dir: s.dir,
    stack: s.stack,
    member: s.project,
    ...(s.engine ? { engine: s.engine } : {}),
    ...(s.lockGrain ? { lockGrain: s.lockGrain } : {}),
    ...(s.policyPacks?.length ? { policyPacks: s.policyPacks } : {}),
  };
}

/**
 * plywood.component.ts: one chant component per stack, each a plain object
 * (chant discovers any exported component-shaped value in a
 * `*.component.ts` file), so the file imports nothing.
 */
export function componentsFile(stacks: readonly InitStack[]): string {
  const taken = new Set<string>();
  const lines = [
    "// Written by plywood init from the stacks it found; running it again rewrites",
    "// this file. Each stack is a chant component whose pulumi-up step previews it",
    "// on a pull request and updates it in its wave.",
    "",
  ];
  for (const s of stacks) {
    const component = { name: componentName(s), dependsOn: [], deploy: [{ phase: "up", steps: [{ kind: "pulumi-up", ...stepInput(s) }] }] };
    lines.push(`export const ${exportName(s, taken)} = ${JSON.stringify(component)};`);
  }
  return lines.join("\n") + "\n";
}

const WAVE_NAME = /^[a-z0-9][a-z0-9_-]*$/;
const STRICTNESS: Record<ChantGatePolicy, number> = { never: 0, "on-destructive": 1, always: 2 };

/** The waves: plywood.yml's `waves`, else one per environment in dev-to-prod order. The first is the canary. */
export function wavesOf(stacks: readonly InitStack[], configured?: string[][]): Array<{ name: string; stacks: InitStack[] }> {
  const byKey = new Map(stacks.map((s) => [s.key, s]));
  if (configured && configured.length > 0) {
    return configured.map((keys, i) => ({ name: `wave-${i + 1}`, stacks: keys.map((k) => byKey.get(k)).filter((s): s is InitStack => s !== undefined) }));
  }
  const out: Array<{ name: string; stacks: InitStack[] }> = [];
  for (const s of stacks) {
    const env = environmentOf(s.stack);
    let name = slug(env);
    if (!WAVE_NAME.test(name)) name = `wave-${out.length + 1}`;
    const wave = out.find((w) => w.name === name);
    if (wave) wave.stacks.push(s);
    else out.push({ name, stacks: [s] });
  }
  return out;
}

/** OpWavesSpec's runner (a label, labels, or a GitHub group) from plywood's `runners`: the `up` stage's, else the default. */
export function waveRunner(runner: ChantRunner | undefined): ChantRunnerSpec | undefined {
  if (runner === undefined) return undefined;
  if (typeof runner === "string" || Array.isArray(runner) || "group" in runner) return runner as ChantRunnerSpec;
  const staged = runner as Partial<Record<string, ChantRunnerSpec>>;
  return staged.up ?? staged.default;
}

export interface WavesSpecInput {
  stacks: readonly InitStack[];
  waves?: string[][];
  gate: ChantGatePolicy;
  branch: string;
  runner?: ChantRunnerSpec;
  quorum?: unknown[];
}

/**
 * The waves spec before chant fills its product names (`productWavesSpec`,
 * chant#4550): op `pulumi-up`, a `pulumi-up` step per run through the
 * pulumi lexicon's capability (chant#4541, #4545), and each wave's gate the
 * strictest of its stacks'.
 */
export function wavesSpec(input: WavesSpecInput): Record<string, unknown> {
  const waves = wavesOf(input.stacks, input.waves).filter((w) => w.stacks.length > 0);
  return {
    name: OP_NAME,
    op: OP_NAME,
    gate: PR_GATE,
    branches: [input.branch],
    ...(input.runner !== undefined ? { runner: input.runner } : {}),
    step: { kind: "pulumi-up" },
    ...(input.quorum && input.quorum.length > 0 ? { approvals: { quorum: input.quorum } } : {}),
    waves: waves.map((w) => {
      const gate = w.stacks.map((s) => s.gate ?? input.gate).reduce((a, b) => (STRICTNESS[b] > STRICTNESS[a] ? b : a));
      return { name: w.name, gate, runs: w.stacks.map((s) => ({ target: s.key, input: stepInput(s) })) };
    }),
  };
}

/** JSON as init writes it: two-space indent, a newline at the end. */
export function jsonText(v: unknown): string {
  return JSON.stringify(v, null, 2) + "\n";
}

export interface DeclarationInput {
  name: string;
  projects: readonly DetectedProject[];
  ci: ChantCiSettings;
  /** The pulumi lexicon's version, pinned like chant itself. */
  lexiconVersion: string;
}

const MEMBER_NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const PULUMI_LEXICON = "@intentius/chant-lexicon-pulumi";

/** A member name for a project, unique among `taken`. */
function memberName(project: DetectedProject, taken: Set<string>): string {
  let base = slug(project.name).slice(0, 36).replace(/-+$/, "");
  if (!MEMBER_NAME.test(base)) base = "stack";
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}-${i}`;
  taken.add(name);
  return name;
}

/**
 * The workspace declaration: `existing` (parsed chant.workspace.json) with a
 * `pulumi` member for each project it lacks, the pulumi lexicon's pin, and
 * the `ci` keys plywood.yml sets. Every other key is kept as it is.
 */
export function workspaceDeclaration(existing: Record<string, unknown> | undefined, input: DeclarationInput): Record<string, unknown> {
  const doc: Record<string, unknown> = existing ? structuredClone(existing) : { name: input.name, schema: 1 };
  const members = Array.isArray(doc.members) ? (doc.members as Array<Record<string, unknown>>) : [];
  const taken = new Set(members.map((m) => String(m.name)));
  for (const p of input.projects) {
    if (members.some((m) => m.dir === p.dir || (p.dir === "." && m.dir === undefined))) continue;
    members.push({ name: memberName(p, taken), dir: p.dir, kind: "pulumi" });
  }
  doc.members = members;
  const pins = Array.isArray(doc.pins) ? (doc.pins as Array<Record<string, unknown>>) : [];
  if (!pins.some((p) => p.package === PULUMI_LEXICON)) pins.push({ package: PULUMI_LEXICON, version: input.lexiconVersion });
  doc.pins = pins;
  const ci = doc.ci && typeof doc.ci === "object" && !Array.isArray(doc.ci) ? (doc.ci as Record<string, unknown>) : {};
  for (const [k, v] of Object.entries(input.ci)) if (v !== undefined) ci[k] = v;
  if (Object.keys(ci).length > 0) doc.ci = ci;
  return doc;
}

/** The member a workspace declaration gives the project in `dir`. */
export function memberOfDir(doc: Record<string, unknown> | undefined, dir: string): string | undefined {
  const members = doc && Array.isArray(doc.members) ? (doc.members as Array<Record<string, unknown>>) : [];
  const m = members.find((x) => x.dir === dir || (dir === "." && x.dir === undefined));
  return typeof m?.name === "string" ? m.name : undefined;
}
