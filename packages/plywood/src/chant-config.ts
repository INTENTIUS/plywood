/**
 * plywood.yml turned into chant's settings. plywood's keys wrap chant's
 * (plywood#2 ruling A), so plywood.yml never holds a chant key and this
 * module is the one place a plywood key meets chant's name for it.
 *
 * The settings come in three parts:
 *
 *   ci       chant's workspace `ci` block, under chant's own key names
 *            (`ci.workflow`, `ci.locks`, `ci.lockGrain`, `ci.prEnvironment`,
 *            `ci.policy`, `ci.identity`, `ci.branches`, `ci.labels`).
 *   members  one entry per stack, as a Pulumi member: its directory, and the
 *            engine and backend chant's pulumi lexicon takes as the member's
 *            config (chant#4559, the first rule `pulumiMemberEngine` asks);
 *            `memberDefaults` for a stack plywood.yml does not list.
 *   pipeline what plywood hands chant's product pipeline in process
 *            (chant#4550 ruling C): gate policy, approval source and rules,
 *            waves, what an open pull request needs before `/plywood up`,
 *            and the image, engine install lines and runners (plywood#12).
 *
 * `ci.lockGrain` is chant#4552's key (ruling A: target, resource or repo).
 * A chant without the lock grain build ignores it; plywood writes it, and
 * nothing more, until that build lands.
 *
 * Each config group writes its own part (src/config/<group>.ts).
 */
import { GROUPS, type PlywoodConfig } from "./config/index";
import type { ChantIdentitySettings } from "./config/identity";
import type { ChantPolicySettings, PolicyPack } from "./config/policy";

/** chant's `ci.workflow` values plywood sets (chant `CiWorkflow`). */
export type ChantCiWorkflow = "trunk-curated+apply-on-merge" | "apply-before-merge";
/** chant's `ci.locks` (chant `CiLocks`). */
export type ChantCiLocks = "plan" | "apply";
/** chant's `ci.lockGrain` (chant#4552 ruling A). */
export type ChantLockGrain = "target" | "resource" | "repo";
/** The approval sources chant's gate decision reads. */
export type ChantApprovalSource = "ledger" | "sealed" | "pr-review";
export type ChantGatePolicy = "always" | "on-destructive" | "never";

/** One approval rule, in the shape of chant's `GateQuorumRule` (op/gate-quorum.ts). */
export interface ChantQuorumRule {
  targets?: string[];
  count: number;
  roles?: string[];
  notAuthor?: boolean;
}

export interface ChantCiSettings {
  workflow?: ChantCiWorkflow;
  locks?: ChantCiLocks;
  lockGrain?: ChantLockGrain;
  prEnvironment?: { template: string; ttl?: string };
  /** chant's gate policy over the change set, read at base (chant#4294). */
  policy?: ChantPolicySettings;
  /** chant's plan and apply identities per cloud, Pulumi Cloud's included (chant#4296, #4549). */
  identity?: ChantIdentitySettings;
  branches?: Record<string, string[]>;
  labels?: Record<string, string[]>;
}

export interface ChantMemberSettings {
  /** The stack, as `project/stack`. */
  name: string;
  dir?: string;
  /** Paths whose change plans the stack, beside its directory. */
  paths?: string[];
  /** Set only when plywood.yml names the engine, or a `plunge+` backend names it; otherwise chant's pulumi lexicon decides. */
  engine?: "pulumi" | "plunge";
  backend?: string;
  gate?: ChantGatePolicy;
  /** The engine release plywood.yml's `pulumi:` or `plunge:` pins for the stack. */
  engineVersion?: string;
  /** The engine binary for a stack pinned to a release other than the one on PATH (src/images.ts `engineBin`). */
  engineBin?: string;
}

/** One runner: a label, every label of a list, or a GitHub runner group with labels its runners also carry. */
export type ChantRunnerSpec = string | string[] | { group: string; labels?: string[] };
/** The jobs' runner: one for all, or one per stage over a default. */
export type ChantRunner = ChantRunnerSpec | Partial<Record<"default" | "preview" | "up" | "drift", ChantRunnerSpec>>;

export interface ChantPipelineSettings {
  gate?: ChantGatePolicy;
  approval?: ChantApprovalSource;
  /** The rules a gate's approvals must meet. */
  quorum?: ChantQuorumRule[];
  /** An approval by the pull request's author never counts. */
  excludeAuthor?: boolean;
  waves?: string[][];
  /** What an open pull request needs before `/plywood up` updates it. */
  applyRequires?: string[];
  /** The review stack name pattern; `{number}` is the pull request's number. */
  reviewStackName?: string;
  forge?: { kind?: string; url?: string };
  /** The image every job runs in, by digest. Absent: chant's default image (src/images.ts `chantPipelineOptions`). */
  image?: string;
  /** The verified engine install lines; each skips an engine the image already carries. */
  engineSetup?: string[];
  /** The runner the jobs run on. */
  runner?: ChantRunner;
  /** CrossGuard packs every stack's pulumi-up step runs, relative to the repository root (chant#4541). */
  policyPacks?: PolicyPack[];
}

export interface ChantSettings {
  ci: ChantCiSettings;
  members: ChantMemberSettings[];
  /** The engine and backend for a stack plywood.yml does not list (one `plywood init` finds later). */
  memberDefaults: Pick<ChantMemberSettings, "engine" | "backend">;
  pipeline: ChantPipelineSettings;
}

/** chant's settings for a config that checked clean (`checkConfig` reports no error). */
export function toChantSettings(config: PlywoodConfig): ChantSettings {
  const out: ChantSettings = { ci: {}, members: [], memberDefaults: {}, pipeline: {} };
  for (const group of GROUPS) group.translate(config.doc, out);
  return out;
}
