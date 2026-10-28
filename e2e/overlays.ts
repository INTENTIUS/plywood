/**
 * Overlays: the files a scenario step lays over the shop repository
 * (e2e/scenarios/overlays/<name>.json), and the base overlays a BREAK arm
 * lays over main before its pull requests open
 * (e2e/scenarios/base-overlays/<name>.json).
 *
 * The stack files carry the passphrase salt `stack init` wrote at seed
 * time, so an overlay never holds a whole stack file. It names keys to set
 * in a file of the seeded repository, lines to append, or whole files:
 *
 *   { "set":    { "Pulumi.dev.yaml": { "corpus:eventsRetentionSeconds": "7200" } },
 *     "append": { "plywood.yml": "locks: { grain: stack }\n" },
 *     "files":  { "notes.txt": "..." } }
 *
 * `set` changes one line per key and keeps the rest, so two pull requests
 * that set keys the seed wrote far apart merge without a conflict.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface OverlaySpec {
  set?: Record<string, Record<string, string>>;
  append?: Record<string, string>;
  files?: Record<string, string>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** `text` with each `key: value` line's value replaced, quoted. Throws on a key the file lacks. */
export function setYamlKeys(text: string, kv: Record<string, string>, file = "the file"): string {
  let out = text;
  for (const [key, value] of Object.entries(kv)) {
    const re = new RegExp(`^(\\s*${escapeRe(key)}:)[ \\t].*$`, "m");
    if (!re.test(out)) throw new Error(`${file} has no ${key} line to set`);
    out = out.replace(re, `$1 ${JSON.stringify(value)}`);
  }
  return out;
}

/** The files an overlay writes, read against the seeded repository at `repoDir`. */
export function overlayFiles(spec: OverlaySpec, repoDir: string): Record<string, string> {
  const read = (path: string): string => {
    const p = join(repoDir, ...path.split("/"));
    if (!existsSync(p)) throw new Error(`the seeded repository has no ${path}`);
    return readFileSync(p, "utf8");
  };
  const out: Record<string, string> = {};
  for (const [path, kv] of Object.entries(spec.set ?? {})) out[path] = setYamlKeys(out[path] ?? read(path), kv, path);
  for (const [path, lines] of Object.entries(spec.append ?? {})) {
    const before = out[path] ?? read(path);
    out[path] = `${before.endsWith("\n") ? before : `${before}\n`}${lines}`;
  }
  Object.assign(out, spec.files ?? {});
  return out;
}

/** Read an overlay file by name from `dir`. */
export function readOverlay(dir: string, name: string): OverlaySpec {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`"${name}" is not an overlay name`);
  const p = join(dir, `${name}.json`);
  if (!existsSync(p)) throw new Error(`no overlay ${name} in ${dir}`);
  return JSON.parse(readFileSync(p, "utf8")) as OverlaySpec;
}
