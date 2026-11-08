/**
 * chant's product pipeline (`@intentius/chant/ci-product`, chant#4550),
 * imported on first use. Tests stand in a fake with
 * {@link setChantProductForTests}.
 */
import type { ChantCommand, ProductWordsInput } from "./words";

export type ForgeKind = "github" | "gitlab" | "forgejo";

/** The words as chant resolves them; plywood reads only these slots. */
export interface ProductWords {
  product: string;
  stages: Record<string, string>;
  commands: Record<string, ChantCommand>;
  prGate: string;
  op?: string;
  bin?: string;
}

/** The part of `ProductPipelineJobs` plywood reads (chant components/product-pipeline.ts). */
export interface ProductPipelineJobs {
  words: ProductWords;
  plan: { jobName: string; command: string };
  /** `control`: the note job's read of the control repo (chant#4619), when the options name one. */
  post: { command: string; control?: { stepName: string; env: Record<string, string>; script: string } };
  record?: { jobName: string; command: string };
  applyBeforeMerge?: { jobName: string; command: string };
  comments: Partial<Record<ChantCommand, string>>;
  waves?: { spec: unknown; specFile: string; jobs: Array<{ command: string[] }> };
  /** The agent's Op spec for `/plywood agent` (chant#4616), when the options ask for the agent. */
  agent?: { comment: string; name: string; spec: Record<string, unknown> };
  /** The `/plywood preview` comment's jobs (chant#4620), with `previewComment`. */
  preview?: { jobName: string; noteJobName: string; comment: string };
  /** The stale marking's job (chant#4628), with `staleNotes`. */
  stale?: { command: string; env: Record<string, string> };
  /** The action job (chant#4654), with `actionJob`: the comment and the dispatch inputs it answers, and `plywood action --from-event`. */
  action?: { jobName: string; comment: string; inputs: { member: string; action: string }; command: string };
}

/** The options plywood passes to `productPipelineJobs`. */
export interface ProductPipelineOptions {
  words: ProductWordsInput | ProductWords;
  applyBeforeMerge?: boolean;
  locks?: "plan";
  branch?: string;
  waves?: unknown;
  /** The checks the apply-before-merge job asks (chant#4607). */
  applyRequires?: string[];
  /** The agent's settings (chant#4616 `ProductAgentOptions`). */
  agent?: boolean | Record<string, unknown>;
  /** The control repo (chant#4568's `ControlTarget`); with chant#4619 `post.control` reads it. */
  control?: { target: unknown };
  /** The `/plywood preview` comment's jobs (chant#4620). */
  previewComment?: boolean;
  /** The pull request jobs' runner by stage, variables, passed secrets and parallelism (chant#4625); src/jobs.ts. */
  runners?: unknown;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
  parallelism?: number;
  /** The note carries its target commit, and a push to the target branch marks older notes stale (chant#4628). */
  staleNotes?: boolean;
  /** The responses to a refused wave, a failed apply and the description (chant#4629), by chant's event names. */
  respond?: Record<string, string>;
  /** The decide service the description check asks (chant#4629). */
  decide?: { backend: string; model: string };
  /** Merge the pull request once its update before merge applied (chant#4636). */
  applyMerge?: { tokenEnv: string; method?: string };
  /** The job that answers `/plywood action <stack> <name>` and a dispatch with `stack` and `action` inputs (chant#4654). */
  actionJob?: boolean | { inputs?: { member?: string; action?: string } };
}

/** What an action job was asked for, as chant's `productActionFromEnv` reads it (chant#4654). */
export type ProductActionRequest = { kind: "action"; member: string; address: string; from: "comment" | "dispatch" } | { kind: "refused"; reason: string };

/** What plywood calls from `@intentius/chant/ci-product`. */
export interface ChantProduct {
  assertProductWords(input: ProductWordsInput | ProductWords, options?: { jobs?: readonly ChantCommand[] }): ProductWords;
  productPipelineJobs(forge: ForgeKind, env: string, options: ProductPipelineOptions): ProductPipelineJobs;
  approveLine(words: ProductWords, input: { op: string; gate: string; digest: string }): string;
  /** `options.mcp` is chant#4555's product tool hook, for `serve mcp`. */
  runChantInProcess(argv: string[], words: ProductWordsInput | ProductWords, options?: { mcp?: unknown }): Promise<number>;
  /** The waves spec with the words' op, gate pattern and approval preset (chant#4550); plywood init writes its output. */
  productWavesSpec(spec: Record<string, unknown>, words: ProductWordsInput | ProductWords): Record<string, unknown>;
  /** The `agent` of a scheduled drift Op (chant#4616). */
  productDriftAgent(words: ProductWordsInput | ProductWords, op: string, options?: Record<string, unknown>): Record<string, unknown>;
  /** The standing pending gates waiting on a plan digest, with the pull request a `pr-<n>` op names (chant#4607). */
  pendingGatesByPlan(digest: string, options?: { op?: string; pullRequestsOnly?: boolean; cwd?: string }): Promise<PendingGateByPlan[]>;
  /** Checks a `--requires` list for `pr-apply --before-merge` (chant#4607). */
  parseRequiresList(values: readonly string[]): { checks: string[] } | { error: string };
  /** Whether an op waves spec gets the approval status jobs: a `pr-review` or `pull-request` wave (chant#4630). */
  opWavesPostsApprovalStatus(spec: unknown): boolean;
  /** The stack and action an action job was started for, from `CHANT_ACTION_COMMENT`, or `CHANT_ACTION_MEMBER` and `CHANT_ACTION` (chant#4654). */
  productActionFromEnv(words: ProductWords, env: Record<string, string | undefined>): ProductActionRequest;
  /** chant's OTLP exporter, with the product's span prefix (chant#4555). */
  configureOtlp(options: { prefix?: string; env?: NodeJS.ProcessEnv }): unknown;
}

/** One standing pending gate a digest matched (chant's `PendingGateByPlan`, chant#4607). */
export interface PendingGateByPlan {
  op: string;
  gate: string;
  pr?: number;
  member?: string;
  matched: "planDigest" | "changeSet";
  timestamp: string;
  url?: string;
}

declare const __PLYWOOD_CHANT__: string | undefined;

/** The chant version this bundle was built with, set by scripts/build-cli.mjs. */
export const BUILT_CHANT = typeof __PLYWOOD_CHANT__ === "string" ? __PLYWOOD_CHANT__ : "unknown";

let cached: Promise<ChantProduct> | undefined;

/** chant's product pipeline. */
export function chantProduct(): Promise<ChantProduct> {
  cached ??= import("@intentius/chant/ci-product").then((m) => m as unknown as ChantProduct);
  return cached;
}

/** Tests stand in a fake chant. `reset` goes back to the real import. */
export function setChantProductForTests(fake: ChantProduct | "reset"): void {
  cached = fake === "reset" ? undefined : Promise.resolve(fake);
}
