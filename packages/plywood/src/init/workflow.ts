/**
 * Writing the workflow file, for `plywood init` and `plywood ci` alike.
 * chant's generator writes the file in process with plywood's words
 * (chant#4550 ruling C); plywood holds no job YAML of its own. chant's
 * build keeps the team's own jobs from the old file (`--keep-own-jobs`,
 * chant#4769). Around that call this module puts the old file back when
 * chant fails, names the jobs kept, and says whether anything changed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { ChantProduct, ForgeKind } from "../chant-product";
import type { ProductWordsInput } from "../words";
import { jobBlocks, ownJobsOf } from "@intentius/chant/ci-own-jobs";
import { withNoteControl, type NoteControlStep } from "./note-control";
import { withRunGroup } from "./run-group";

export interface WriteWorkflowInput {
  /** Where the build runs: the repository root. */
  root: string;
  forge: ForgeKind;
  /** The file, relative to `root` or absolute. */
  output: string;
  /** chant's build argv without `--output`. */
  argv: string[];
  words: ProductWordsInput;
  /** chant's `post.control` (chant#4619): the note job's read of the control repo, placed before the post. */
  noteControl?: NoteControlStep;
}

export interface WriteWorkflowResult {
  code: number;
  file: string;
  status: "written" | "unchanged" | "failed";
  /** The team's own jobs carried over from the old file. */
  kept: string[];
}

export async function writeWorkflow(chant: Pick<ChantProduct, "runChantInProcess">, input: WriteWorkflowInput): Promise<WriteWorkflowResult> {
  const file = isAbsolute(input.output) ? input.output : join(input.root, input.output);
  const previous = existsSync(file) ? readFileSync(file, "utf8") : undefined;
  mkdirSync(dirname(file), { recursive: true });
  const code = await chant.runChantInProcess([...input.argv, "--keep-own-jobs", "--output", file], input.words);
  if (code !== 0 || !existsSync(file)) {
    if (previous !== undefined) writeFileSync(file, previous);
    return { code: code !== 0 ? code : 1, file, status: "failed", kept: [] };
  }
  const text = withRunGroup(withNoteControl(readFileSync(file, "utf8"), input.forge, input.noteControl), input.forge, "pull-request");
  writeFileSync(file, text);
  const kept = previous === undefined ? [] : keptJobs(previous, text, input.forge, input.words.bin);
  return { code, file, status: text === previous ? "unchanged" : "written", kept };
}

/** The jobs of `previous` that run neither chant nor plywood's bin and are in `written` as they were: the ones chant kept. */
function keptJobs(previous: string, written: string, forge: ForgeKind, bin: string | undefined): string[] {
  const now = jobBlocks(written, forge);
  return [...ownJobsOf(previous, "", forge, bin ? [bin] : [])].filter(([name, block]) => now.get(name) === block).map(([name]) => name);
}
