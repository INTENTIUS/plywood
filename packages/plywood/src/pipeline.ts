/**
 * `.chant/pipeline.ts` from plywood.yml (plywood#156): `promotion` and the
 * waves build chant's pipeline declaration (chant#5324), which chant folds
 * to the spec the waves and promote jobs read. plywood maps its keys onto
 * chant's `pipelineFromConfig` and writes the file with `pipelineSource`;
 * `plywood ci --check` runs `checkPipelineFile`. Every mechanism is chant's:
 * stage gates, holds, freezes, soaks, the canary, risk, rollback on a failed
 * verify, the stage graph, release artifacts and agent steps.
 *
 *   stages        one per environment of `promotion`, first to last
 *   waves         the first stage's are the waves spec's
 *                 (`.chant/op-waves/pulumi-up.spec.json`); each later
 *                 stage's are the same waves over that environment's stacks
 *                 (src/config/promotion.ts `promotionTargets`)
 *   the canary    `waves.canary`'s wave, first in each stage, marked `canary`
 *   stage keys    `environments.<name>`'s, as chant's vocabulary names them,
 *                 `risk` and `replan_dependents` among them (chant#5425);
 *                 plywood's approval rules in chant's shape, and a stage
 *                 risk without `approve_above` takes the top-level one
 *   approval      a stage with rules and no `approval` anywhere takes
 *                 `pr-review` (src/config/approval.ts `approvalOf`)
 *   defaults      the waves spec's op, step, runner, notify, hooks, holds
 *                 and approvals; `replan_dependents` and `risk.approve_above`
 *   release       cut once the first stage updated, as plywood's bin
 *
 * Nothing here runs pulumi, plunge or git.
 */
import type { PipelineConfigInput, PipelineDeclaration, PipelineEnvironmentConfig } from "@intentius/chant/pipeline";
import { approvalOf, approvalSet, gateOf, quorumOf, RULES_DEFAULT_APPROVAL, type ApprovalRulesSettings } from "./config/approval";
import { promotionOf, promotionTargets, stageTargetsOf, type PromotionStack } from "./config/promotion";
import { stacksOf } from "./config/stacks";
import { replanDependentsOf } from "./config/stage";
import { isObject, type RawConfig } from "./config/types";
import type { ChantGatePolicy } from "./chant-config";
import { BIN, PRODUCT } from "./words";

/** The file chant reads, beside chant.config.ts. */
export const PIPELINE_FILE = ".chant/pipeline.ts";

/** The pipeline's name: the op its stage gates are recorded under, and the stage specs' prefix (`plywood-<stage>`). */
export const PIPELINE_NAME = PRODUCT;

/** What the file's header names. */
export const PIPELINE_SOURCE = { product: PRODUCT, config: "plywood.yml", command: `${PRODUCT} ci` } as const;

/** The keys of a stage entry plywood keeps to itself or maps on its own, so `pipelineFromConfig` does not read them. */
const OWN_KEYS = new Set(["targets", "config", "secrets", "imports", "risk", "replan_dependents", "approval_rules"]);

const STRICTNESS: Record<ChantGatePolicy, number> = { never: 0, "on-destructive": 1, always: 2 };

/** A wave as the waves spec holds it. */
export interface SpecWave {
  name: string;
  gate?: ChantGatePolicy;
  canary?: boolean;
  runs: Array<{ target: string; input?: Record<string, unknown>; [k: string]: unknown }>;
  [k: string]: unknown;
}

/** One stack as a later stage's run takes it: its key and the pulumi-up step's input there. */
export interface StageStack {
  key: string;
  project: string;
  input: Record<string, unknown>;
  /** `stacks.<key>.gate`, when plywood.yml sets one. */
  gate?: ChantGatePolicy;
}

/** The waves spec's wave marked `canary` when `waves.canary` puts its stacks in a first wave of their own (plywood#18). */
export function withCanaryWave(waves: readonly SpecWave[], doc: RawConfig): SpecWave[] {
  const canary = isObject(doc.waves) && Array.isArray(doc.waves.canary) && doc.waves.canary.length > 0;
  return waves.map((w, i) => (canary && i === 0 && w.name === "canary" ? { ...w, canary: true } : { ...w }));
}

/** The number of checks a soak setting lists. */
function soakChecks(soak: unknown): number {
  return isObject(soak) && Array.isArray(soak.checks) ? soak.checks.length : 0;
}

/**
 * Each stage's waves with the canary mark kept where chant holds the waves
 * after it: a first wave of a stage with more than one wave, with a soak of
 * at least one check, its own or the stage's. Elsewhere the canary's stacks
 * still update first, in a wave of their own, unmarked; chant refuses a
 * canary wave with no wave after it or no check to soak on.
 */
export function canaryWhereItHolds(waves: Readonly<Record<string, readonly SpecWave[]>>, doc: RawConfig): Record<string, SpecWave[]> {
  const entries = isObject(doc.environments) ? (doc.environments as Record<string, unknown>) : {};
  const out: Record<string, SpecWave[]> = {};
  for (const [env, list] of Object.entries(waves)) {
    const entry = entries[env];
    const stageSoak = isObject(entry) ? entry.soak : undefined;
    out[env] = list.map((w) => {
      if (w.canary !== true || (list.length > 1 && (soakChecks(w.soak) > 0 || soakChecks(stageSoak) > 0))) return w;
      const { canary: _canary, ...rest } = w;
      return rest as SpecWave;
    });
  }
  return out;
}

/**
 * Each stage's waves: the waves spec's waves over that environment's
 * stacks. A run's stack is moved to the stack its project updates in the
 * stage (the same stack in the first stage); a wave's gate is the strictest
 * `stacks.<key>.gate` of its stacks there, and absent when none sets one, so
 * the stage's gate holds. A wave's forge environment and job groups are left
 * for the caller to work out again for the stage's stacks.
 */
export function stageWaves(first: readonly SpecWave[], promotion: readonly string[], byEnv: ReadonlyMap<string, Readonly<Record<string, StageStack>>>): { waves: Record<string, SpecWave[]>; problems: string[] } {
  const problems: string[] = [];
  const firstEnv = promotion[0]!;
  const out: Record<string, SpecWave[]> = {};
  const projectOf = new Map(Object.values(byEnv.get(firstEnv) ?? {}).map((s) => [s.key, s.project]));
  for (const env of promotion) {
    const stacks = byEnv.get(env) ?? {};
    out[env] = first.map((w) => {
      const { environment: _environment, groups: _groups, gate: _gate, ...rest } = structuredClone(w);
      const runs = w.runs.flatMap((r) => {
        const project = projectOf.get(r.target) ?? (typeof r.input?.member === "string" ? r.input.member : r.target.split("/")[0]!);
        const s = stacks[project];
        if (!s) {
          problems.push(`${project} has no stack in environment ${env}, so its run in wave ${w.name} has no target there`);
          return [];
        }
        return [{ ...structuredClone(r), target: s.key, input: { ...(r.input ?? {}), ...s.input } }];
      });
      const own = Object.values(stacks).filter((s) => runs.some((r) => r.target === s.key) && s.gate !== undefined).map((s) => s.gate!);
      const strictest = own.reduce<ChantGatePolicy | undefined>((a, b) => (a === undefined || STRICTNESS[b] > STRICTNESS[a] ? b : a), undefined);
      return { ...rest, ...(strictest ? { gate: strictest } : {}), runs } as SpecWave;
    });
  }
  return { waves: out, problems };
}

/**
 * Each environment's stack per project, as later stages take them, from the
 * stacks `plywood init` finds and plywood.yml's `targets`. `input` makes the
 * pulumi-up step's input for a stack.
 */
export function stagesByEnv(
  doc: RawConfig,
  stacks: ReadonlyArray<PromotionStack>,
  input: (key: string) => Record<string, unknown>,
): { byEnv: Map<string, Record<string, StageStack>>; problems: string[] } {
  const promotion = promotionOf(doc) ?? [];
  const { projects, problems } = promotionTargets(promotion, stacks, stageTargetsOf(doc));
  const listed = stacksOf(doc);
  const byEnv = new Map<string, Record<string, StageStack>>();
  for (const env of promotion) {
    const entry: Record<string, StageStack> = {};
    for (const p of projects) {
      const key = p.byEnv[env];
      if (key === undefined) continue;
      const gate = listed[key]?.gate;
      entry[p.project] = { key, project: p.project, input: input(key), ...(gate ? { gate } : {}) };
    }
    byEnv.set(env, entry);
  }
  return { byEnv, problems };
}

/**
 * A stage entry as chant's `pipelineFromConfig` reads it: plywood's own keys
 * left out, its approval rules (the stage's and its risk's) in chant's
 * shape, `replan_dependents` checked, a risk without `approve_above` given
 * the top-level `risk.approve_above`, and `approval: pr-review` on a stage
 * that has rules where neither it nor plywood.yml sets `approval`.
 */
export function chantEnvironment(entry: Record<string, unknown> | undefined, doc: RawConfig = {}): PipelineEnvironmentConfig {
  if (!entry) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(entry)) if (!OWN_KEYS.has(k)) out[k] = structuredClone(v);
  if (entry.approval_rules !== undefined) out.approval_rules = quorumOf(entry.approval_rules as ApprovalRulesSettings);
  const risk = isObject(entry.risk) ? entry.risk : undefined;
  if (risk) {
    const top = isObject(doc.risk) && typeof doc.risk.approve_above === "number" ? doc.risk.approve_above : undefined;
    const approveAbove = typeof risk.approve_above === "number" ? risk.approve_above : top;
    out.risk = {
      ...(approveAbove !== undefined ? { approve_above: approveAbove } : {}),
      ...(risk.approval_rules !== undefined ? { approval_rules: quorumOf(risk.approval_rules as ApprovalRulesSettings) } : {}),
    };
  }
  const replan = replanDependentsOf(entry.replan_dependents);
  if (replan) out.replan_dependents = replan;
  const rules = entry.approval_rules !== undefined || risk?.approval_rules !== undefined;
  if (rules && !approvalSet(entry.approval) && !approvalSet(doc.approval)) out.approval = RULES_DEFAULT_APPROVAL;
  return out as PipelineEnvironmentConfig;
}

/** The op-waves settings every stage shares, from the waves spec: chant's `defaults`. */
export function pipelineDefaults(spec: Record<string, unknown>, doc: RawConfig): NonNullable<PipelineConfigInput["defaults"]> {
  const out: Record<string, unknown> = {};
  for (const k of ["op", "step", "runner", "notify", "hooks", "holds", "point"]) if (spec[k] !== undefined) out[k] = structuredClone(spec[k]);
  if (isObject(spec.approvals)) {
    const { quorum: _quorum, ...approvals } = spec.approvals;
    if (Object.keys(approvals).length) out.approvals = approvals;
  }
  // The risk score the first stage's waves make, which a promote into a later stage reads (chant#5387).
  const approveAbove = isObject(doc.risk) && typeof doc.risk.approve_above === "number" ? doc.risk.approve_above : undefined;
  if (approveAbove !== undefined) out.holds = { ...(isObject(out.holds) ? out.holds : {}), risk: { ...(isObject((out.holds as Record<string, unknown> | undefined)?.risk) ? ((out.holds as Record<string, unknown>).risk as Record<string, unknown>) : {}), approveAbove } };
  const replan = replanDependentsOf(doc.replan_dependents);
  if (replan) out.replanDependents = replan;
  return out as NonNullable<PipelineConfigInput["defaults"]>;
}

/** What {@link pipelineInput} takes. */
export interface PipelineInputs {
  doc: RawConfig;
  /** Each stage's waves (src/pipeline.ts {@link stageWaves}). */
  waves: Record<string, SpecWave[]>;
  /** The waves spec the first stage's waves come from, for the defaults. */
  spec: Record<string, unknown>;
  /** The waves spec's `control`, told once the first stage updated. */
  control?: Record<string, unknown>;
}

/** chant's `pipelineFromConfig` input from plywood.yml. */
export function pipelineInput(i: PipelineInputs): PipelineConfigInput {
  const { doc } = i;
  const promotion = promotionOf(doc) ?? [];
  const entries = isObject(doc.environments) ? (doc.environments as Record<string, unknown>) : {};
  const release = isObject(doc.release) ? doc.release : {};
  return {
    name: PIPELINE_NAME,
    promotion,
    environments: Object.fromEntries(promotion.map((env) => [env, chantEnvironment(isObject(entries[env]) ? (entries[env] as Record<string, unknown>) : undefined, doc)])),
    ...(doc.approval_rules !== undefined ? { approvalRules: quorumOf(doc.approval_rules as ApprovalRulesSettings) as PipelineConfigInput["approvalRules"] } : {}),
    gate: gateOf(doc),
    approval: approvalOf(doc),
    waves: canaryWhereItHolds(i.waves, doc) as unknown as PipelineConfigInput["waves"],
    defaults: pipelineDefaults(i.spec, doc),
    release: { cut: release.cut !== false, label: typeof release.label === "string" ? release.label : "auto", bin: BIN.split(" ") },
    ...(i.control ? { control: i.control as unknown as PipelineConfigInput["control"] } : {}),
    ...(isObject(doc.recheck) && typeof doc.recheck.schedule === "string" ? { recheck: { schedule: doc.recheck.schedule } } : {}),
  };
}

/** chant's pipeline helpers, loaded on first use. */
export async function chantPipeline(): Promise<typeof import("@intentius/chant/pipeline")> {
  return import("@intentius/chant/pipeline");
}

/** The declaration and the file's text, through chant's helpers. Throws chant's message when the declaration does not check. */
export async function pipelineFile(i: PipelineInputs): Promise<{ declaration: PipelineDeclaration; text: string }> {
  const chant = await chantPipeline();
  const declaration = chant.pipelineFromConfig(pipelineInput(i));
  return { declaration, text: chant.pipelineSource(declaration, { ...PIPELINE_SOURCE }) };
}
