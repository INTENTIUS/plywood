/**
 * The note job's read of the control repo (plywood#28, chant#4619). With a
 * control repo in plywood.yml, the note marks each cross-stack edge `stale`
 * or `current` from the control repo's apply records, and for that the note
 * job reads the control repo's `chant/lifecycle` before `pr-post`. chant's
 * generator writes that step itself when its loop names a control repo, but
 * `plywood ci` runs the generator over argv, which carries no control repo.
 * So plywood takes the step chant hands back as `productPipelineJobs(...).post.control`
 * and puts it into the generated note job, just before the post. The step is
 * chant's: its name, its environment and its script. plywood places it and
 * adds nothing.
 *
 * A chant before chant#4619 hands back no step, and the file stays as
 * chant wrote it: every edge then reads `unknown`. A note job that already
 * has the step, from a chant whose generator reads the control repo itself,
 * is left alone.
 */
import { emitYAML } from "@intentius/chant/yaml";
import type { ForgeKind } from "../chant-product";

/** chant's `ControlNoteCheckout` (control/dispatch.ts): the step that reads the control repo's records. */
export interface NoteControlStep {
  stepName: string;
  env: Record<string, string>;
  script: string;
}

/** The note job chant's pull request generator writes (`PR_PLAN_NOTE_JOB`). */
export const NOTE_JOB = "plan-note";

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The lines of the job `name` in `lines`: [start, end), or undefined. Jobs sit at `depth` spaces. */
function jobRange(lines: readonly string[], name: string, depth: number): [number, number] | undefined {
  const head = new RegExp(`^${" ".repeat(depth)}${name}:\\s*(#.*)?$`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.trim() === "" || l.trimStart().startsWith("#")) continue;
    if (indentOf(l) <= depth) {
      end = i;
      break;
    }
  }
  return [start, end];
}

/**
 * `text` with `step` in the note job, before the line that posts the note.
 * Unchanged when there is no step, no note job, no post line, or the job
 * already reads the control repo.
 */
export function withNoteControl(text: string, forge: ForgeKind, step: NoteControlStep | undefined): string {
  if (!step) return text;
  const lines = text.split("\n");
  const range = jobRange(lines, NOTE_JOB, forge === "gitlab" ? 0 : 2);
  if (!range) return text;
  const [start, end] = range;
  const job = lines.slice(start, end);
  if (job.some((l) => l.includes(step.stepName)) || job.some((l) => l.includes("CHANT_CONTROL_DIR="))) return text;
  if (forge === "gitlab") {
    // The script's items sit at four spaces; the step's script goes in as one more item, before pr-post's.
    const at = job.findIndex((l) => /^ {4}- /.test(l) && l.includes("components pr-post"));
    if (at < 0) return text;
    const item = emitYAML([step.script], 2).replace(/^\n/, "");
    return [...lines.slice(0, start + at), ...item.split("\n"), ...lines.slice(start + at)].join("\n");
  }
  // GitHub and Forgejo: steps at six spaces; the post step's name starts with "Post the plan note".
  const at = job.findIndex((l) => /^ {6}- name: Post the plan note\b/.test(l));
  if (at < 0) return text;
  const item = emitYAML([{ name: step.stepName, if: "always()", ...(Object.keys(step.env).length ? { env: step.env } : {}), run: step.script }], 3).replace(/^\n/, "");
  return [...lines.slice(0, start + at), ...item.split("\n"), ...lines.slice(start + at)].join("\n");
}
