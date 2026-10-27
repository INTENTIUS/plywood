/**
 * plywood.yml turned into chant's settings. plywood's keys wrap chant's
 * (plywood#2 ruling A), so plywood.yml never holds a chant key and this
 * module is the one place a plywood key meets chant's name for it.
 *
 * The settings come in three parts:
 *
 *   ci       chant's workspace `ci` block, under chant's own key names
 *            (`ci.workflow`, `ci.locks`, `ci.lockGrain`, `ci.prEnvironment`,
 *            `ci.branches`, `ci.labels`).
 *   members  one entry per stack, as a Pulumi member: its directory, and the
 *            engine and backend chant's pulumi lexicon takes as the member's
 *            config (chant#4559, the first rule `pulumiMemberEngine` asks);
 *            `memberDefaults` for a stack plywood.yml does not list.
 *   pipeline what plywood hands chant's product pipeline in process
 *            (chant#4550 ruling C): gate policy, approval source and rules,
 *            waves, and what an open pull request needs before `/plywood up`.
 *
 * `ci.lockGrain` is chant#4552's key (ruling A: target, resource or repo).
 * A chant without the lock grain build ignores it; plywood writes it, and
 * nothing more, until that build lands.
 *
 * Each config group writes its own part (src/config/<group>.ts).
 */
import { GROUPS, type PlywoodConfig } from "./config/index";

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
}

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
