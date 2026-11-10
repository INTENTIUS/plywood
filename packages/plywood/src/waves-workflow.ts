/**
 * The update on merge in the generated workflow: one job per wave of
 * `.chant/op-waves/pulumi-up.spec.json`, from productPipelineJobs' `waves`
 * (chant#4550). Each job runs `plywood run wave --spec <file> --wave <k>`,
 * chant's op-wave job through plywood's bin, so each run applies through the
 * spec's pulumi-up step (chant#4541) and records on chant's ledger.
 *
 * `plywood ci` calls this after the pull request workflow is written:
 *   1. The spec file gets plywood's names (op pulumi-up, gates wave-{k}, and
 *      each wave's approval taken from the pull request's `up` gate), as
 *      productPipelineJobs returns it. The wave jobs read the file at base,
 *      so it is written beside the workflow and committed with it.
 *   2. chant's op-waves generator (`run --generate <forge> --spec <file>`)
 *      writes the waves workflow.
 *   2a. Before the generator runs, `ops/pulumi-up.op.ts` is written from
 *      the spec (plywood#22): chant's generator refuses a spec whose Op it
 *      cannot discover from a `*.op.ts` file, and chant ships no `pulumi-up`
 *      Op. The wave jobs plan and apply through the spec's step, so the Op's
 *      own phases are what `chant run pulumi-up` does by hand: a preview of
 *      each stack in wave order, which changes nothing.
 *   2b. The spec file is `{ "waves": <spec>, "options": { image, beforeScript, evidence } }`
 *      when plywood.yml names an image, the engines need install lines
 *      (plywood#22) or `evidence` names a runner identity (chant#4870), so the waves and plans workflows run in plywood's image
 *      with its install lines, as the pull request workflow does. chant's
 *      generator and its wave jobs read both forms (`parseOpWavesSpec`), and
 *      plywood's own readers unwrap it ({@link unwrapWavesSpec}).
 *   2c. The generator gives the Forgejo workflow a concurrency group per
 *      commit (`--run-group commit`, chant#4771; plywood#51), so Forgejo does
 *      not cancel a merge's wave jobs when the next merge lands.
 *   3. chant's generator writes the words' bin in the wave, resume and
 *      plans jobs itself (chant#4607, `OpWavesPipelineOptions.bin`), so the
 *      job lines are left as chant wrote them.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChantProduct, ForgeKind, ProductPipelineJobs } from "./chant-product";
import type { PipelineEvidence } from "@intentius/chant/ci-evidence-jobs";
import { chantPipelineOptions } from "./images";
import type { ExitTable } from "./exit-codes";
import type { StageIo } from "./stages";
import { OP_NAME, PRODUCT, type ProductWordsInput } from "./words";

/** Where chant's op-waves generator writes for each forge (chant run-generate.ts `DEFAULT_OP_PIPELINE_DIRS`). */
export const WAVES_OUTPUT_DIR: Readonly<Record<ForgeKind, string>> = {
  github: ".github/workflows",
  forgejo: ".forgejo/workflows",
  gitlab: ".",
};

/** The waves part of productPipelineJobs: the spec with plywood's names, its file, and a job per wave. */
export type WaveJobs = NonNullable<ProductPipelineJobs["waves"]>;

/** The Op the waves spec names, in the file chant's Op discovery reads (a `*.op.ts` beside chant.config.ts). */
export const UP_OP_FILE = "ops/pulumi-up.op.ts";

/** The image and the lines every waves job runs first: chant's `OpWavesPipelineOptions.image` and `beforeScript`; and its `evidence` (chant#4870). */
export interface WavesEngine {
  image?: string;
  beforeScript?: string[];
  /** plywood.yml `evidence`: each deciding wave job signs `plan:<wave>` and `policy:<wave>`. */
  evidence?: PipelineEvidence;
}

/** The waves jobs' image and lines from plywood's pipeline settings, as the review and drift jobs take them. */
export function wavesEngine(pipeline: { image?: string; engineSetup?: string[]; evidence?: PipelineEvidence }): WavesEngine {
  const o = chantPipelineOptions({ ...(pipeline.image ? { image: pipeline.image } : {}), ...(pipeline.engineSetup ? { engineSetup: pipeline.engineSetup } : {}) });
  return { ...(o.image ? { image: o.image } : {}), ...(o.beforeScript?.length ? { beforeScript: o.beforeScript } : {}), ...(pipeline.evidence ? { evidence: pipeline.evidence } : {}) };
}

/** The spec file's text: the bare spec, or `{ waves, options }` when there is an image, a line or a runner identity to hand chant's generator. */
export function wavesSpecText(spec: unknown, engine: WavesEngine = {}): string {
  const options = { ...(engine.image ? { image: engine.image } : {}), ...(engine.beforeScript?.length ? { beforeScript: engine.beforeScript } : {}), ...(engine.evidence ? { evidence: engine.evidence } : {}) };
  return JSON.stringify(Object.keys(options).length ? { waves: spec, options } : spec, null, 2) + "\n";
}

/** The spec inside a spec file's JSON, in either form. */
export function unwrapWavesSpec(doc: unknown): unknown {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return doc;
  const inner = (doc as { waves?: unknown }).waves;
  if (Array.isArray(inner)) return doc;
  return inner && typeof inner === "object" && Array.isArray((inner as { waves?: unknown }).waves) ? inner : doc;
}

interface SpecRun {
  target: string;
  input?: { dir?: unknown; stack?: unknown; member?: unknown; engine?: unknown };
}

/** A step id from a wave and a run's target: lower case, `-` for anything else. */
function stepId(wave: string, target: string): string {
  return `${wave}-${target}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * `ops/pulumi-up.op.ts` for a waves spec: the Op the spec names, with a phase
 * per wave and in it a `pulumiPreview` of each run's stack, from the same
 * input the spec's `pulumi-up` step gets (member, dir, stack, engine).
 */
export function upOpFile(spec: unknown): string {
  const s = (spec ?? {}) as { op?: unknown; waves?: Array<{ name?: unknown; runs?: SpecRun[] }> };
  const op = typeof s.op === "string" && s.op !== "" ? s.op : OP_NAME;
  const taken = new Set<string>();
  const phases: string[] = [];
  for (const [i, w] of (s.waves ?? []).entries()) {
    const name = typeof w.name === "string" && w.name !== "" ? w.name : `wave-${i + 1}`;
    const steps: string[] = [];
    for (const run of w.runs ?? []) {
      const input = run.input ?? {};
      if (typeof input.member !== "string" || typeof input.dir !== "string") continue;
      let id = stepId(name, run.target);
      for (let n = 2; taken.has(id); n++) id = `${stepId(name, run.target)}-${n}`;
      taken.add(id);
      const opts = [
        `dir: ${JSON.stringify(input.dir)}`,
        ...(typeof input.stack === "string" ? [`stack: ${JSON.stringify(input.stack)}`] : []),
        ...(input.engine === "pulumi" || input.engine === "plunge" ? [`engine: ${JSON.stringify(input.engine)}`] : []),
        `id: ${JSON.stringify(id)}`,
      ];
      steps.push(`pulumiPreviewStep(${JSON.stringify(input.member)}, { ${opts.join(", ")} })`);
    }
    if (steps.length > 0) phases.push(`    phase(${JSON.stringify(name)}, [${steps.join(", ")}]),`);
  }
  return [
    `// Written by '${PRODUCT} init' and '${PRODUCT} ci' from .chant/op-waves/${OP_NAME}.spec.json, and written again on each run: edit plywood.yml, not this file.`,
    `// The waves workflow runs under this Op's name: each wave job previews and updates its stacks through the spec's`,
    `// pulumi-up step and records the runs under ${op}. chant's generator needs the Op to exist. Run by hand`,
    `// (npx chant run ${op}), it previews each stack in wave order and changes nothing.`,
    `import { Op, phase } from "@intentius/chant/op";`,
    `import { pulumiPreviewStep } from "@intentius/chant-lexicon-pulumi";`,
    "",
    "export default Op({",
    `  name: ${JSON.stringify(op)},`,
    `  overview: "The stacks ${PRODUCT}'s waves update on merge, previewed in wave order",`,
    `  labels: { Surface: "${PRODUCT}-up" },`,
    "  phases: [",
    ...phases,
    "  ],",
    "});",
    "",
  ].join("\n");
}

/** Write `ops/pulumi-up.op.ts` for `spec` under `cwd`; true when the file changed. */
export function writeUpOp(cwd: string, spec: unknown): boolean {
  const path = join(cwd, UP_OP_FILE);
  const text = upOpFile(spec);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/** The files chant's generator wrote for `specFile`: those whose header names `--spec <specFile>`. */
function generatedFor(dir: string, specFile: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => join(dir, f))
    .filter((p) => (readFileSync(p, "utf8").split("\n", 1)[0] ?? "").includes(`--spec ${specFile}`));
}

/**
 * Write the spec with plywood's names and have chant generate the waves
 * workflow. Returns chant's exit
 * code, or `failed` when no file came out.
 */
export async function writeWaveJobs(
  chant: ChantProduct,
  forge: ForgeKind,
  waves: WaveJobs,
  words: ProductWordsInput,
  table: ExitTable,
  io: StageIo,
  engine: WavesEngine = {},
): Promise<number> {
  const specPath = join(io.cwd, waves.specFile);
  const specText = wavesSpecText(waves.spec, engine);
  const before = existsSync(specPath) ? readFileSync(specPath, "utf8") : undefined;
  if (before !== specText) {
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, specText);
    io.err(`${PRODUCT} ci: wrote ${waves.specFile} with plywood's op and gates; commit it with the workflow`);
  }
  // plywood#22: chant's generator discovers the Op the spec names from a *.op.ts file, so it is written first.
  if (writeUpOp(io.cwd, waves.spec)) io.err(`${PRODUCT} ci: wrote ${UP_OP_FILE}, the Op the waves spec names; commit it with the workflow`);
  const outDir = WAVES_OUTPUT_DIR[forge];
  const code = await chant.runChantInProcess(["run", "--generate", forge, "--spec", waves.specFile, "--run-group", "commit", "--output", outDir], words);
  if (code !== table.done) return code;
  const files = generatedFor(join(io.cwd, outDir), waves.specFile);
  if (files.length === 0) {
    io.err(`${PRODUCT} ci: chant wrote no waves workflow for ${waves.specFile} under ${outDir}`);
    return table.failed;
  }
  for (const file of files) {
    io.err(`${PRODUCT} ci: waves workflow at ${file.slice(io.cwd.length + 1)}`);
  }
  if (forge === "gitlab") {
    io.err(`${PRODUCT} ci: GitLab reads one root file; include the waves file from .gitlab-ci.yml (include: local: <file>)`);
  }
  return table.done;
}
