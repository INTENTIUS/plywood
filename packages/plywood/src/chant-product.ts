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
  post: { command: string };
  record?: { jobName: string; command: string };
  applyBeforeMerge?: { jobName: string; command: string };
  comments: Partial<Record<ChantCommand, string>>;
  waves?: { spec: unknown; specFile: string; jobs: Array<{ command: string[] }> };
}

/** The options plywood passes to `productPipelineJobs`. */
export interface ProductPipelineOptions {
  words: ProductWordsInput | ProductWords;
  applyBeforeMerge?: boolean;
  locks?: "plan";
  branch?: string;
  waves?: unknown;
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
  /** Present when chant's notify has the relay and `chant notify relay` (chant#4611). */
  NOTIFY_RELAY_FLOOR?: string;
  /** chant's relay server (chant#4611); its presence says `notify relay` runs in process. */
  startRelayServer?: (...args: unknown[]) => unknown;
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
