/**
 * `plywood ci` under plywood.yml's `promotion` (plywood#156): writes
 * `.chant/pipeline.ts` from plywood.yml (src/pipeline.ts) and has chant's
 * pipeline generator write the first stage's waves workflow and the promote
 * workflow from the folded spec, in place of the waves workflow of
 * `.chant/op-waves/pulumi-up.spec.json`. The wave jobs read their stage's
 * spec with `plywood pipeline spec --stage <stage>`, which folds the file
 * at base, so the gates a merge reads are the committed file's.
 *
 * Every job of the pipeline, the first stage's waves and each promote,
 * recheck and agent job, runs in plywood's image with plywood.yml's engine
 * install lines (`image` and `beforeScript`, chant#5425), as the waves
 * workflow outside a pipeline does.
 *
 * `plywood ci --check` runs chant's `checkPipelineFile` and changes nothing.
 */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { ChantProduct, ForgeKind } from "./chant-product";
import type { ChantSettings } from "./chant-config";
import { agentOf } from "./config/agents";
import type { RawConfig } from "./config/types";
import type { ExitTable } from "./exit-codes";
import { chantPipelineOptions } from "./images";
import { detect } from "./init/detect";
import { stepInput, type InitStack } from "./init/render";
import { withJobSettings } from "./jobs";
import { chantPipeline, PIPELINE_FILE, PIPELINE_SOURCE, pipelineFile, stagesByEnv, stageWaves, withCanaryWave, type SpecWave } from "./pipeline";
import type { StageIo } from "./stages";
import { verifyFailedFacts } from "./agent-triggers";
import { rejectCommentWorkflow, REJECT_WORKFLOW } from "./reject-comment";
import { generatedFor, WAVES_OUTPUT_DIR } from "./waves-workflow";
import { BIN, OP_NAME, PRODUCT, type ProductWordsInput } from "./words";

export interface PipelineJobsInput {
  doc: RawConfig;
  settings: ChantSettings;
  forge: ForgeKind;
  /** The waves spec, with the hooks and the job settings on it, as `plywood ci` hands the waves generator. */
  spec: Record<string, unknown>;
  words: ProductWordsInput;
  /** The waves spec's `control`, from src/control.ts `wavesControl`. */
  control?: Record<string, unknown>;
  /** `--check`: compare the committed file and write nothing. */
  check: boolean;
  /** The pull request workflow's environment (`--env`), which the reject comment job takes. Default the first stage. */
  env?: string;
  /** The stacks `plywood init` settles (src/init.ts `initStacks`), given by the caller. */
  stacks: readonly InitStack[];
}

/** Every stage's waves, with plywood.yml's job settings worked out for the stage's stacks. */
export function pipelineWaves(i: Pick<PipelineJobsInput, "doc" | "settings" | "forge" | "spec" | "stacks">): { waves: Record<string, SpecWave[]>; problems: string[] } {
  const byKey = new Map(i.stacks.map((s) => [s.key, s]));
  const staged = stagesByEnv(i.doc, i.stacks, (key) => stepInput(byKey.get(key)!));
  if (staged.problems.length) return { waves: {}, problems: staged.problems };
  const first = withCanaryWave(Array.isArray(i.spec.waves) ? (i.spec.waves as SpecWave[]) : [], i.doc);
  const { waves, problems } = stageWaves(first, [...staged.byEnv.keys()], staged.byEnv);
  const jobs = i.settings.pipeline.jobs;
  if (jobs) for (const [env, w] of Object.entries(waves)) waves[env] = withJobSettings({ ...i.spec, waves: w }, jobs, i.forge).waves as SpecWave[];
  return { waves, problems };
}

/** The stacks for `plywood ci`: the ones `plywood init` finds in the repository with plywood.yml's settings. */
export async function repositoryStacks(cwd: string, doc: RawConfig, settings: ChantSettings): Promise<InitStack[]> {
  const { initStacks } = await import("./init");
  return initStacks(detect(cwd), doc, settings.members);
}

/**
 * Write (or with `check`, compare) `.chant/pipeline.ts` and the pipeline's
 * workflows. Returns chant's exit code.
 */
export async function writePipelineJobs(chant: ChantProduct, i: PipelineJobsInput, table: ExitTable, io: StageIo): Promise<number> {
  const { waves, problems } = pipelineWaves(i);
  if (problems.length) {
    for (const p of problems) io.err(`${PRODUCT} ci: promotion: ${p}`);
    return table.failed;
  }
  let file: Awaited<ReturnType<typeof pipelineFile>>;
  try {
    file = await pipelineFile({ doc: i.doc, waves, spec: i.spec, ...(i.control ? { control: i.control } : {}) });
  } catch (e) {
    io.err(`${PRODUCT} ci: ${PIPELINE_SOURCE.config}: ${(e as Error).message}`);
    return table.failed;
  }
  const helpers = await chantPipeline();
  if (i.check) {
    const r = helpers.checkPipelineFile(io.cwd, file.text, { command: PIPELINE_SOURCE.command });
    if (r.status === "current") {
      io.err(`${PRODUCT} ci --check: ${r.file} is what plywood.yml writes`);
      return table.done;
    }
    io.err(`${PRODUCT} ci --check: ${r.message}`);
    if (r.status === "stale") for (const line of r.diff) io.err(`  ${line}`);
    return table.failed;
  }
  if (helpers.writePipelineFile(io.cwd, file.text)) io.err(`${PRODUCT} ci: wrote ${PIPELINE_FILE} from plywood.yml's promotion and stage keys; commit it with the workflow`);
  return generatePipelineJobs(chant, file.declaration, i, table, io);
}

/**
 * chant's pipeline generator's options from plywood.yml, apart from the
 * cloud identities and the config sets read from the repository: plywood's
 * bin and words, the runner identity, plywood's image (its plunge image
 * under plunge) and the engine install lines for the wave jobs and every
 * promote job (chant#5425), and the failed-verify facts for
 * agent.verify-failed.
 */
export function pipelineGenerateOptions(i: Pick<PipelineJobsInput, "doc" | "settings" | "words">): Record<string, unknown> {
  const facts = verifyFailedFacts(agentOf(i.doc));
  const evidence = i.settings.pipeline.evidence;
  const engine = chantPipelineOptions(i.settings.pipeline);
  return {
    bin: BIN,
    words: i.words,
    ...(evidence ? { evidence } : {}),
    ...(engine.image ? { image: engine.image } : {}),
    ...(engine.beforeScript?.length ? { beforeScript: engine.beforeScript } : {}),
    ...(facts ? { agentFacts: { triggers: ["verify-failed"], ...facts } } : {}),
  };
}

/** chant's pipeline generator, in process with plywood's words and bin, and the workflows it returns written under the forge's directory. */
async function generatePipelineJobs(chant: ChantProduct, declaration: unknown, i: PipelineJobsInput, table: ExitTable, io: StageIo): Promise<number> {
  const { asPipelineSpec, pipelineStageSpecFile, stageWavesSpec } = await chantPipeline();
  const { generatePipeline } = await import("@intentius/chant/pipeline/generate");
  const { GENERATED_MARKER } = await import("@intentius/chant/discovery/files");
  const { declaredCloudIdentityDeclaration, declaredEnvironmentSets } = await import("@intentius/chant/workspace/ci-cloud-identity");
  const [identity, environmentSets] = await Promise.all([declaredCloudIdentityDeclaration(io.cwd), declaredEnvironmentSets(io.cwd)]);
  const result = await generatePipeline(asPipelineSpec(structuredClone(declaration)), i.forge, {
    ...pipelineGenerateOptions(i),
    ...(identity ? { identity } : {}),
    ...(environmentSets ? { environmentSets } : {}),
  } as never);
  if (!result.success) {
    io.err(`${PRODUCT} ci: chant's pipeline generator: ${result.error ?? "it wrote nothing"}`);
    return table.failed;
  }
  const outDir = WAVES_OUTPUT_DIR[i.forge];
  for (const f of result.files ?? []) {
    const path = join(outDir, f.name);
    const text = `# ${GENERATED_MARKER}. Regenerate with: ${PRODUCT} ci\n${f.yaml}`;
    const at = join(io.cwd, path);
    if (existsSync(at) && readFileSync(at, "utf8") === text) continue;
    mkdirSync(dirname(at), { recursive: true });
    writeFileSync(at, text);
    io.err(`${PRODUCT} ci: pipeline workflow at ${path.replace(/^\.\//, "")}`);
  }
  const first = declarationFirst(declaration);
  const stageSpec = stageSpecFile(asPipelineSpec(structuredClone(declaration)), first, { pipelineStageSpecFile, stageWavesSpec });
  const stageAt = join(io.cwd, stageSpec.path);
  if (!existsSync(stageAt) || readFileSync(stageAt, "utf8") !== stageSpec.text) {
    mkdirSync(dirname(stageAt), { recursive: true });
    writeFileSync(stageAt, stageSpec.text);
    io.err(`${PRODUCT} ci: wrote ${stageSpec.path}, the ${first} stage's waves its pull request plans job reads; commit it with the workflow`);
  }
  if (ignoreWaveWorkDirs(io.cwd)) io.err(`${PRODUCT} ci: added ${WAVE_WORK_DIRS} to .gitignore, so the release cut after the ${first} stage's last wave reads a clean tree; commit it with the workflow`);
  // The waves workflow `plywood ci` wrote before promotion: the first stage's workflow runs the merge in its place.
  for (const replaced of generatedFor(join(io.cwd, outDir), WAVES_SPEC)) {
    unlinkSync(replaced);
    io.err(`${PRODUCT} ci: removed ${relative(io.cwd, replaced)}, the waves workflow the ${first} stage's workflow replaces`);
  }
  // chant#5354: `/plywood reject` on a pull request, answered by chant's comment job (src/reject-comment.ts); on GitLab the note poll answers it.
  const engine = chantPipelineOptions(i.settings.pipeline);
  let reject: string | undefined;
  try {
    reject = rejectCommentWorkflow(chant, { forge: i.forge, env: i.env ?? declarationFirst(declaration), words: i.words, ...(engine.image ? { image: engine.image } : {}), ...(engine.beforeScript?.length ? { beforeScript: engine.beforeScript } : {}) });
  } catch (e) {
    io.err(`${PRODUCT} ci: /${PRODUCT} reject: ${(e as Error).message}`);
    return table.failed;
  }
  if (reject !== undefined) {
    const path = join(outDir, REJECT_WORKFLOW);
    const text = `# ${GENERATED_MARKER}. Regenerate with: ${PRODUCT} ci\n${reject}`;
    const at = join(io.cwd, path);
    if (!existsSync(at) || readFileSync(at, "utf8") !== text) {
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, text);
      io.err(`${PRODUCT} ci: /${PRODUCT} reject workflow at ${path.replace(/^\.\//, "")}`);
    }
  }
  if (i.forge === "gitlab") io.err(`${PRODUCT} ci: GitLab reads one root file; include the pipeline's files from .gitlab-ci.yml (include: local: <file>)`);
  io.err(`${PRODUCT} ci: the merge updates ${declarationFirst(declaration)} and cuts a release; '${PRODUCT} promote --to <env>' carries it on through each stage's gate`);
  return table.done;
}

/** The waves spec `plywood init` writes, whose workflow the pipeline's first stage replaces. */
const WAVES_SPEC = `.chant/op-waves/${OP_NAME}.spec.json`;

/**
 * The first stage's op-waves spec at the path its workflows name, as
 * `plywood pipeline spec --stage <first>` prints it. The merge's wave jobs
 * render it there with `--render-spec`; the pull request's plans job reads
 * the file as it is (chant `opWavesRecordPlansCommand`), so plywood writes it
 * with `.chant/pipeline.ts`.
 */
export function stageSpecFile<S>(
  spec: S,
  first: string,
  chant: { pipelineStageSpecFile: (spec: S, stage: string) => string; stageWavesSpec: (spec: S, stage: string) => unknown },
): { path: string; text: string } {
  return { path: chant.pipelineStageSpecFile(spec, first), text: `${JSON.stringify(chant.stageWavesSpec(spec, first), null, 2)}\n` };
}

/** The directories a wave job writes its plans and outcomes under, beside each spec file. */
export const WAVE_WORK_DIRS = ".chant/op-waves/*/";

/**
 * Add {@link WAVE_WORK_DIRS} to the repository's .gitignore. The first
 * stage's last wave cuts the release in the same job, after the apply, and
 * chant's cut refuses a tree with an untracked file (release-worktree-dirty),
 * which the wave's own plans would be. True when the file changed.
 */
export function ignoreWaveWorkDirs(cwd: string): boolean {
  const path = join(cwd, ".gitignore");
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (before.split(/\r?\n/).some((l) => l.trim() === WAVE_WORK_DIRS)) return false;
  writeFileSync(path, `${before}${before === "" || before.endsWith("\n") ? "" : "\n"}${WAVE_WORK_DIRS}\n`);
  return true;
}

function declarationFirst(declaration: unknown): string {
  const stages = (declaration as { stages?: Array<{ name: string }> }).stages ?? [];
  return stages[0]?.name ?? "the first environment";
}
