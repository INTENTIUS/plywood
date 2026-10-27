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
 *   3. Each job line chant wrote as `chant run wave ...` becomes the line
 *      productPipelineJobs gave, with plywood's bin.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ChantProduct, ForgeKind, ProductPipelineJobs } from "./chant-product";
import type { ExitTable } from "./exit-codes";
import type { StageIo } from "./stages";
import { PRODUCT, type ProductWordsInput } from "./words";

/** Where chant's op-waves generator writes for each forge (chant run-generate.ts `DEFAULT_OP_PIPELINE_DIRS`). */
export const WAVES_OUTPUT_DIR: Readonly<Record<ForgeKind, string>> = {
  github: ".github/workflows",
  forgejo: ".forgejo/workflows",
  gitlab: ".",
};

/** The waves part of productPipelineJobs: the spec with plywood's names, its file, and a job per wave. */
export type WaveJobs = NonNullable<ProductPipelineJobs["waves"]>;

/** Each wave job's line as chant's generator writes it, and the line with plywood's bin. */
export function binLines(waves: Pick<WaveJobs, "jobs">, bin: string): Array<{ chant: string; product: string }> {
  const binArgs = bin.split(/\s+/).filter(Boolean);
  return waves.jobs.map((job) => {
    const own = job.command.slice(0, binArgs.length).join(" ") === binArgs.join(" ");
    const rest = own ? job.command.slice(binArgs.length) : job.command.slice(1);
    return { chant: ["chant", ...rest].join(" "), product: [...binArgs, ...rest].join(" ") };
  });
}

/** `text` with every chant wave line in place of plywood's. */
export function withBinLines(text: string, lines: ReadonlyArray<{ chant: string; product: string }>): string {
  // Longest first, so `... --wave 1` does not eat into `... --wave 1 --share 2`.
  const sorted = [...lines].sort((a, b) => b.chant.length - a.chant.length);
  return text.replace(/chant run wave [^\n"']*/g, (found) => {
    const hit = sorted.find((l) => found.trimEnd() === l.chant);
    return hit ? hit.product : found;
  });
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
 * Write the spec with plywood's names, have chant generate the waves
 * workflow, and put plywood's bin in its job lines. Returns chant's exit
 * code, or `failed` when no file came out.
 */
export async function writeWaveJobs(
  chant: ChantProduct,
  forge: ForgeKind,
  waves: WaveJobs,
  words: ProductWordsInput,
  table: ExitTable,
  io: StageIo,
): Promise<number> {
  const specPath = join(io.cwd, waves.specFile);
  const specText = JSON.stringify(waves.spec, null, 2) + "\n";
  const before = existsSync(specPath) ? readFileSync(specPath, "utf8") : undefined;
  if (before !== specText) {
    mkdirSync(dirname(specPath), { recursive: true });
    writeFileSync(specPath, specText);
    io.err(`${PRODUCT} ci: wrote ${waves.specFile} with plywood's op and gates; commit it with the workflow`);
  }
  const outDir = WAVES_OUTPUT_DIR[forge];
  const code = await chant.runChantInProcess(["run", "--generate", forge, "--spec", waves.specFile, "--output", outDir], words);
  if (code !== table.done) return code;
  const files = generatedFor(join(io.cwd, outDir), waves.specFile);
  if (files.length === 0) {
    io.err(`${PRODUCT} ci: chant wrote no waves workflow for ${waves.specFile} under ${outDir}`);
    return table.failed;
  }
  const lines = binLines(waves, words.bin);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const next = withBinLines(text, lines);
    if (next !== text) writeFileSync(file, next);
    io.err(`${PRODUCT} ci: waves workflow at ${file.slice(io.cwd.length + 1)}`);
  }
  if (forge === "gitlab") {
    io.err(`${PRODUCT} ci: GitLab reads one root file; include the waves file from .gitlab-ci.yml (include: local: <file>)`);
  }
  return table.done;
}
