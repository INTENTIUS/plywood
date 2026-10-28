/**
 * chant's product pipeline (`@intentius/chant/ci-product`, chant#4550),
 * reached through a feature-detect. plywood's pin is chant 0.124.54, which
 * has no such entry; the release after it does (its `CI_PRODUCT_FLOOR`).
 *
 * The entry is imported on first use. When it is missing, or lacks any of
 * `assertProductWords`, `productPipelineJobs`, `approveLine` and
 * `runChantInProcess` (chant#4550 names the first three as the check), the
 * verbs that need it say so and exit with chant's `failed` code, and
 * everything else keeps working on the pin.
 *
 * The `import()` carries a `@ts-ignore` so this compiles against a chant
 * without the subpath; scripts/build-cli.mjs stands in a module that throws
 * for a subpath the installed chant lacks, so the bundle builds either way.
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
  /** `control`: the note job's read of the control repo (chant#4619), when the options name one; a chant before it gives none. */
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
}

/** The options plywood passes to `productPipelineJobs`. */
export interface ProductPipelineOptions {
  words: ProductWordsInput | ProductWords;
  applyBeforeMerge?: boolean;
  locks?: "plan";
  branch?: string;
  waves?: unknown;
  /** The checks the apply-before-merge job asks (chant#4607); a chant before it ignores the option. */
  applyRequires?: string[];
  /** The agent's settings (chant#4616 `ProductAgentOptions`); a chant before it ignores the option. */
  agent?: boolean | Record<string, unknown>;
  /** The control repo (chant#4568's `ControlTarget`); with chant#4619 `post.control` reads it. */
  control?: { target: unknown };
  /** The `/plywood preview` comment's jobs (chant#4620); a chant before it ignores the option. */
  previewComment?: boolean;
  /** The pull request jobs' runner by stage, variables, passed secrets and parallelism (chant#4625); src/jobs.ts gives them only to a chant with it. */
  runners?: unknown;
  variables?: Record<string, string>;
  secrets?: Record<string, string>;
  parallelism?: number;
  /** The note carries its target commit, and a push to the target branch marks older notes stale (chant#4628); a chant before it ignores the option. */
  staleNotes?: boolean;
  /** The responses to a refused wave, a failed apply and the description (chant#4629), by chant's event names; a chant before it ignores the option. */
  respond?: Record<string, string>;
  /** The decide service the description check asks (chant#4629). */
  decide?: { backend: string; model: string };
  /** Merge the pull request once its update before merge applied (chant#4636); a chant before it ignores the option. */
  applyMerge?: { tokenEnv: string; method?: string };
}

/** What plywood calls from `@intentius/chant/ci-product`. */
export interface ChantProduct {
  assertProductWords(input: ProductWordsInput | ProductWords, options?: { jobs?: readonly ChantCommand[] }): ProductWords;
  productPipelineJobs(forge: ForgeKind, env: string, options: ProductPipelineOptions): ProductPipelineJobs;
  approveLine(words: ProductWords, input: { op: string; gate: string; digest: string }): string;
  /** `options.mcp` is chant#4555's product tool hook, for `serve mcp`; a chant before it ignores the option. */
  runChantInProcess(argv: string[], words: ProductWordsInput | ProductWords, options?: { mcp?: unknown }): Promise<number>;
  /** Present when `runChantInProcess` takes the product tool hook (chant#4555). */
  PRODUCT_MCP_HOOK_FLOOR?: string;
  /** The waves spec with the words' op, gate pattern and approval preset (chant#4550); plywood init writes its output. */
  productWavesSpec?(spec: Record<string, unknown>, words: ProductWordsInput | ProductWords): Record<string, unknown>;
  CI_PRODUCT_FLOOR?: string;
  /** Present when chant has the agent job and the scheduled Op spec's `agent` and `runner` (chant#4616). */
  CI_AGENT_FLOOR?: string;
  /** The `agent` of a scheduled drift Op (chant#4616). */
  productDriftAgent?(words: ProductWordsInput | ProductWords, op: string, options?: Record<string, unknown>): Record<string, unknown>;
  /** Present when chant's notify has the relay and `chant notify relay` (chant#4611). */
  NOTIFY_RELAY_FLOOR?: string;
  /** chant's relay server (chant#4611); its presence says `notify relay` runs in process. */
  startRelayServer?: (...args: unknown[]) => unknown;
  /** The standing pending gates waiting on a plan digest, with the pull request a `pr-<n>` op names (chant#4607). */
  pendingGatesByPlan?(digest: string, options?: { op?: string; pullRequestsOnly?: boolean; cwd?: string }): Promise<PendingGateByPlan[]>;
  /** Checks a `--requires` list for `pr-apply --before-merge` (chant#4607). */
  parseRequiresList?(values: readonly string[]): { checks: string[] } | { error: string };
  /** The comment preview's jobs (chant#4620); with {@link PR_PREVIEW_FLOOR} it says `pr-plan` takes `--target`. */
  prCommentPreviewJob?: (...args: unknown[]) => unknown;
  /** Present when chant has the comment preview and `pr-plan --target` (chant#4620). */
  PR_PREVIEW_FLOOR?: string;
  /** Present when chant has the responses to pipeline events (chant#4629). */
  CI_RESPOND_FLOOR?: string;
  /** Present when chant's op-waves generators post `<product>/approval` under a pr-review wave (chant#4630). */
  APPROVAL_STATUS_FLOOR?: string;
}

/**
 * Whether the installed chant has chant#4620: the product pipeline's
 * comment preview job (`build --pr-loop --preview-comment`) and `pr-plan
 * --target`, which landed together.
 */
export function hasChant4620(chant: ChantProduct): boolean {
  return typeof chant.prCommentPreviewJob === "function" && typeof chant.PR_PREVIEW_FLOOR === "string";
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

/**
 * Whether the installed chant has chant#4607: the op-wave generators write
 * the product's bin in each wave job, `pr-apply --before-merge` takes
 * `--requires`, and pending gates are read by plan digest. All three landed
 * together, and `pendingGatesByPlan` with `parseRequiresList` on the
 * ci-product entry is the check.
 */
export function hasChant4607(chant: ChantProduct): boolean {
  return typeof chant.pendingGatesByPlan === "function" && typeof chant.parseRequiresList === "function";
}

/** The functions whose presence says the installed chant has the product pipeline. */
export const REQUIRED = ["assertProductWords", "productPipelineJobs", "approveLine", "runChantInProcess"] as const;

declare const __PLYWOOD_CHANT__: string | undefined;

/** The chant version this bundle was built with, set by scripts/build-cli.mjs. */
export const BUILT_CHANT = typeof __PLYWOOD_CHANT__ === "string" ? __PLYWOOD_CHANT__ : "unknown";

/** The message a verb prints when the installed chant has no product pipeline. */
export function needsChantMessage(what: string): string {
  return (
    `${what} needs chant >= the release after 0.124.54, which carries @intentius/chant/ci-product (chant#4550). ` +
    `This plywood was built with chant ${BUILT_CHANT}, which lacks it. ` +
    "Upgrade plywood once that chant is out, or build against a local chant with 'just chant-local'."
  );
}

/** True when `m` has every function plywood calls. */
export function isChantProduct(m: unknown): m is ChantProduct {
  if (!m || typeof m !== "object") return false;
  const r = m as Record<string, unknown>;
  return REQUIRED.every((name) => typeof r[name] === "function");
}

let cached: Promise<ChantProduct | undefined> | undefined;

/** chant's product pipeline, or undefined when the installed chant lacks it. */
export function chantProduct(): Promise<ChantProduct | undefined> {
  cached ??= (async () => {
    try {
      // @ts-ignore: the subpath is missing from chant 0.124.54 (chant#4550).
      const m: unknown = await import("@intentius/chant/ci-product");
      return isChantProduct(m) ? m : undefined;
    } catch {
      return undefined;
    }
  })();
  return cached;
}

/** Tests stand in a fake chant (or none, for the fallback). `reset` goes back to the real import. */
export function setChantProductForTests(fake: ChantProduct | undefined | "reset"): void {
  cached = fake === "reset" ? undefined : Promise.resolve(fake);
}
