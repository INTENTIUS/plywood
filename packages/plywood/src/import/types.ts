/**
 * What each importer gives `plywood init --from` (plywood#21): plywood.yml
 * keys, and every setting of the source it could not carry, by name.
 * Importers read files in the repository and nothing else: no API call,
 * no engine, no git.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import type { Detected, DetectedProject } from "../init/detect";
import { isObject, type RawConfig } from "../config/types";

export const IMPORT_SOURCES = ["pulumi-actions", "deployments", "spacelift", "env0"] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

/** One setting the importer could not carry. */
export interface Unsupported {
  /** The file it is in, relative to the repository root. */
  file: string;
  /** The setting's name as the source spells it (`refresh`, `operationContext.preRunCommands`). */
  setting: string;
  /** Why, and what to do instead. */
  why: string;
}

export interface ImportResult {
  source: ImportSource;
  /** The files read, relative to the repository root. */
  files: string[];
  /** plywood.yml keys. `stacks` holds only what the source says beyond init's own detection. */
  keys: RawConfig;
  unsupported: Unsupported[];
  /** What carried over without a key, or needs a person (secrets to copy). */
  notes: string[];
}

/** An importer: the repository, what init detected, and the files `--from` named (empty: the source's usual places). */
export type Importer = (root: string, detected: Detected, files: readonly string[]) => ImportResult;

/** A YAML or JSON file in the repository, parsed. */
export function readDoc(root: string, file: string): unknown {
  return parseYAML(readFileSync(join(root, file), "utf8"));
}

/** The first of `names` present under `root`. */
export function firstPresent(root: string, names: readonly string[]): string | undefined {
  return names.find((n) => existsSync(join(root, n)));
}

/** A path joined and normalized as plywood.yml spells paths (`.` for the root). */
export function repoJoin(...parts: string[]): string {
  const out = posix.normalize(parts.filter((p) => p !== "" && p !== ".").join("/") || ".").replace(/^\.\//, "").replace(/\/+$/, "");
  return out === "" ? "." : out;
}

/** The project whose directory is `dir`. */
export function projectAt(detected: Detected, dir: string): DetectedProject | undefined {
  const want = repoJoin(dir);
  return detected.projects.find((p) => repoJoin(p.dir) === want);
}

/** A stack's plywood.yml settings, made on first use. */
export function stackEntry(keys: RawConfig, key: string): Record<string, unknown> {
  const stacks = (isObject(keys.stacks) ? keys.stacks : (keys.stacks = {})) as Record<string, Record<string, unknown>>;
  return (stacks[key] ??= {});
}

/** Adds stacks to `branches.<branch>`, without repeats. */
export function addBranch(keys: RawConfig, branch: string, stack: string): void {
  const branches = (isObject(keys.branches) ? keys.branches : (keys.branches = {})) as Record<string, string[]>;
  const list = (branches[branch] ??= []);
  if (!list.includes(stack)) list.push(stack);
}

/** A git ref as a branch name: `refs/heads/main` is `main`. */
export function branchOf(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}

/** Each key of `v` outside `known` as an unsupported setting under `prefix`. */
export function unknownSettings(v: Record<string, unknown>, known: readonly string[], file: string, prefix: string, why: string): Unsupported[] {
  return Object.keys(v)
    .filter((k) => !known.includes(k))
    .map((k) => ({ file, setting: prefix ? `${prefix}.${k}` : k, why }));
}

/** Lays one importer's keys over another's: mappings merge, the rest is replaced. */
export function mergeKeys(base: RawConfig, over: RawConfig): RawConfig {
  const out: RawConfig = structuredClone(base);
  for (const [k, v] of Object.entries(over)) {
    out[k] = isObject(v) && isObject(out[k]) ? mergeKeys(out[k] as RawConfig, v) : structuredClone(v);
  }
  return out;
}

/** The lines init prints for an import. */
export function importLines(r: ImportResult): string[] {
  const out = [`--from ${r.source}: read ${r.files.length ? r.files.join(", ") : "no file"}`];
  for (const n of r.notes) out.push(`  ${n}`);
  if (r.unsupported.length) out.push(`  ${r.unsupported.length} setting${r.unsupported.length === 1 ? "" : "s"} not carried:`);
  for (const u of r.unsupported) out.push(`    ${u.file}: ${u.setting}: ${u.why}`);
  return out;
}
