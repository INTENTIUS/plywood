/**
 * Jobs of the team's own in the workflow file plywood writes. chant's
 * generator writes the whole file, so before it does, plywood takes each job
 * of the old file that the new one does not have and that runs no plywood
 * line, and puts it back after chant's jobs, as it was written, comments
 * and all. A second `plywood init` or `plywood ci` then keeps a job someone
 * added by hand and changes nothing else.
 *
 * The blocks are read as text by their indentation, so a job keeps its
 * formatting: under `jobs:` at two spaces on GitHub and Forgejo, and at the
 * top level on GitLab, where the keywords that are not jobs stay chant's.
 */
import type { ForgeKind } from "../chant-product";

/** The line above the jobs kept, which says where they come from. */
export const OWN_JOBS_LINE = "# Your own jobs, kept as they are by plywood init and plywood ci.";

/** GitLab's top-level keys that are not jobs. */
const GITLAB_KEYWORDS = new Set(["default", "include", "stages", "variables", "workflow", "image", "services", "cache", "before_script", "after_script", "spec"]);

/** The bin a generated job runs; a job that runs it is plywood's. */
const PLYWOOD_LINE = /\bplywood\b\s+(components|ci|run|lock|unlock|check|preview|up|drift)\b/;

const KEY = /^([A-Za-z0-9_.-]+|"[^"]+"|'[^']+'):(\s|$)/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isContent(line: string): boolean {
  const t = line.trim();
  return t !== "" && !t.startsWith("#");
}

/** Each job's block of lines, by name, in file order. */
export function jobBlocks(text: string, forge: ForgeKind): Map<string, string> {
  const lines = text.split("\n");
  const out = new Map<string, string>();
  let start = 0;
  let end = lines.length;
  let depth = 0;
  if (forge !== "gitlab") {
    const at = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
    if (at < 0) return out;
    start = at + 1;
    const next = lines.findIndex((l, i) => i > at && indentOf(l) === 0 && isContent(l));
    end = next < 0 ? lines.length : next;
    depth = 2;
  }
  let name: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (name !== undefined) {
      while (body.length > 0 && body[body.length - 1]!.trim() === "") body.pop();
      out.set(name, body.join("\n"));
    }
    name = undefined;
    body = [];
  };
  for (let i = start; i < end; i++) {
    const line = lines[i]!;
    if (isContent(line) && indentOf(line) === depth) {
      const m = KEY.exec(line.slice(depth));
      flush();
      if (m) {
        name = m[1]!.replace(/^["']|["']$/g, "");
        body = [line];
      }
      continue;
    }
    if (isContent(line) && indentOf(line) < depth) {
      flush();
      continue;
    }
    if (name !== undefined) body.push(line);
  }
  flush();
  if (forge === "gitlab") for (const k of [...out.keys()]) if (GITLAB_KEYWORDS.has(k)) out.delete(k);
  return out;
}

/** The jobs of `previous` that `generated` lacks and that run no plywood line: the team's own. */
export function ownJobs(previous: string, generated: string, forge: ForgeKind): Map<string, string> {
  const ours = jobBlocks(generated, forge);
  const out = new Map<string, string>();
  for (const [name, block] of jobBlocks(previous, forge)) {
    if (ours.has(name) || PLYWOOD_LINE.test(block)) continue;
    out.set(name, block);
  }
  return out;
}

/** `generated` with `own` put back after chant's jobs, under {@link OWN_JOBS_LINE}. */
export function withOwnJobs(generated: string, own: Map<string, string>, forge: ForgeKind): string {
  if (own.size === 0) return generated;
  const indent = forge === "gitlab" ? "" : "  ";
  const block = [`${indent}${OWN_JOBS_LINE}`, ...own.values()].join("\n");
  const lines = generated.replace(/\n+$/, "").split("\n");
  if (forge !== "gitlab") {
    const at = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
    if (at >= 0) {
      const next = lines.findIndex((l, i) => i > at && indentOf(l) === 0 && isContent(l));
      if (next >= 0) {
        let cut = next;
        while (cut > at + 1 && lines[cut - 1]!.trim() === "") cut--;
        return [...lines.slice(0, cut), block, ...lines.slice(cut)].join("\n") + "\n";
      }
    }
  }
  return [...lines, block].join("\n") + "\n";
}

/** The old file's own jobs carried into the new one; `previous` undefined means there was no file. */
export function keepOwnJobs(previous: string | undefined, generated: string, forge: ForgeKind): { text: string; kept: string[] } {
  if (previous === undefined) return { text: generated, kept: [] };
  const own = ownJobs(previous, generated, forge);
  return { text: withOwnJobs(generated, own, forge), kept: [...own.keys()] };
}
