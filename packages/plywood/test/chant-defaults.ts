import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ChantProduct } from "../src/chant-product";

/**
 * The parts of chant's product pipeline a test fake does not care about,
 * answered as a repository with none of them set would be.
 */
export const CHANT_DEFAULTS = {
  pendingGatesByPlan: async () => [],
  parseRequiresList: (values: readonly string[]) => ({ checks: values.flatMap((v) => v.split(",")) }),
  productWavesSpec: (spec: Record<string, unknown>) => spec,
  productDriftAgent: (_words: unknown, _op: string, options?: Record<string, unknown>) => ({ on: "drift", ...(options ?? {}) }),
  opWavesPostsApprovalStatus: () => false,
  productActionFromEnv: () => ({ kind: "refused" as const, reason: "no action was asked" }),
  configureOtlp: () => undefined,
} satisfies Partial<ChantProduct>;

/** A chant with only those parts, for a function that reads no more of it. */
export const STUB_CHANT = CHANT_DEFAULTS as unknown as ChantProduct;

/**
 * A chant whose generators write a placeholder file where chant's would, so
 * a test of `plywood init` gets past the workflow steps without chant's own
 * generator. A relative output is under `root()`, the test's repository.
 */
export function writingChant(root: () => string): ChantProduct {
  return {
    ...CHANT_DEFAULTS,
    assertProductWords: (w) => w as never,
    productPipelineJobs: (_forge, _env, options) => {
      const words = options.words as { product: string; stages: Record<string, string>; commands: Record<string, never>; prGate?: string };
      return {
        words: { ...words, stages: { ...words.stages }, prGate: words.prGate ?? "up" },
        plan: { jobName: "plan", command: "npx --no-install plywood components pr-plan --gate up" },
        post: { command: "npx --no-install plywood components pr-post" },
        comments: {},
        ...(options.waves ? { waves: { spec: options.waves, specFile: ".chant/op-waves/pulumi-up.spec.json", jobs: [{ command: ["npx", "--no-install", "plywood", "run", "wave"] }] } } : {}),
      };
    },
    approveLine: () => "",
    runChantInProcess: async (argv) => {
      const out = argv.indexOf("--output");
      if (out < 0) return 0;
      const target = isAbsolute(argv[out + 1]!) ? argv[out + 1]! : join(root(), argv[out + 1]!);
      if (argv[0] === "run") {
        const spec = argv[argv.indexOf("--spec") + 1]!;
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "pulumi-up-waves.yml"), `# chant run --generate --spec ${spec}\njobs: {}\n`);
      } else {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, "jobs: {}\n");
      }
      return 0;
    },
  };
}
