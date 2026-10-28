/**
 * plywood.yml: plywood's keys in snake_case, each wrapping chant's
 * (plywood#2 ruling A). This module finds and parses the file, runs every
 * group's checks, and composes the JSON schema. src/chant-config.ts turns a
 * clean config into chant's settings.
 *
 * Each group of keys has its own module; GROUPS lists them in the order
 * they translate (stacks before engine, which fills each stack's engine;
 * images after routing, since it reads each stack's engine and the forge).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseYAML } from "@intentius/chant/yaml";
import { agents } from "./agents";
import { apply } from "./apply";
import { approval } from "./approval";
import { chantKeys } from "./chant-keys";
import { control } from "./control";
import { drift } from "./drift";
import { engine } from "./engine";
import { identity } from "./identity";
import { images } from "./images";
import { jobs } from "./jobs";
import { later } from "./later";
import { locks } from "./locks";
import { observe } from "./observe";
import { policy } from "./policy";
import { reviewStacks } from "./review-stacks";
import { routing } from "./routing";
import { stacks } from "./stacks";
import { error, isObject, type ConfigGroup, type ConfigProblem, type JsonSchema, type RawConfig } from "./types";

export type { ConfigGroup, ConfigProblem, RawConfig } from "./types";

export const GROUPS: readonly ConfigGroup[] = [chantKeys, stacks, engine, apply, locks, approval, policy, identity, reviewStacks, observe, drift, agents, routing, images, jobs, control, later];

/** The names chant's pulumi lexicon also looks for (chant#4559, member-engine.ts `PLYWOOD_FILES`). */
export const CONFIG_NAMES = ["plywood.yml", "plywood.yaml"] as const;

export interface PlywoodConfig {
  /** The file read, or undefined for a config given as text. */
  file?: string;
  doc: RawConfig;
}

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly problems: ConfigProblem[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Every top-level key some group owns. */
export function knownKeys(): Set<string> {
  return new Set(GROUPS.flatMap((g) => g.keys));
}

/**
 * The nearest plywood.yml from `dir` up to the repository root (the first
 * directory holding `.git`), as chant's pulumi lexicon searches.
 */
export function findConfig(dir: string): string | undefined {
  let cur = resolve(dir);
  for (let depth = 0; depth < 32; depth++) {
    for (const name of CONFIG_NAMES) {
      const file = join(cur, name);
      if (existsSync(file)) return file;
    }
    const parent = dirname(cur);
    if (existsSync(join(cur, ".git")) || parent === cur) return undefined;
    cur = parent;
  }
  return undefined;
}

/** Parses plywood.yml text. An empty file is an empty config; a file that is not a mapping is refused. */
export function parseConfig(text: string, file?: string): PlywoodConfig {
  let doc: unknown;
  try {
    doc = text.trim() === "" ? {} : parseYAML(text);
  } catch (e) {
    throw new ConfigError(`${file ?? "plywood.yml"}: ${(e as Error).message}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isObject(doc)) throw new ConfigError(`${file ?? "plywood.yml"}: the file must be a mapping of plywood keys`);
  return { ...(file ? { file } : {}), doc };
}

/** Reads plywood.yml at `file`. */
export function loadConfig(file: string): PlywoodConfig {
  return parseConfig(readFileSync(file, "utf8"), file);
}

/** Every problem in the config: unknown keys, then each group's checks. */
export function checkConfig(config: PlywoodConfig): ConfigProblem[] {
  const known = knownKeys();
  const out: ConfigProblem[] = [];
  for (const key of Object.keys(config.doc)) {
    if (key === "ci" || key.startsWith("ci.")) continue;
    if (!known.has(key)) out.push(error(key, `is not a plywood key; the keys are ${[...known].sort().join(", ")}`));
  }
  for (const g of GROUPS) out.push(...g.check(config.doc));
  return out;
}

/** The JSON schema of plywood.yml, composed from every group's keys. */
export function plywoodSchema(): JsonSchema {
  const properties: Record<string, JsonSchema> = {};
  for (const g of GROUPS) Object.assign(properties, g.schema);
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: "https://intentius.io/plywood/plywood.schema.json",
    title: "plywood.yml",
    description: "plywood's config. Each key wraps a chant setting; plywood sets chant's keys from it, so a ci. key is refused.",
    $comment: "Generated from packages/plywood/src/config by scripts/build-schema.mjs; edit the group modules, then run npm run schema.",
    type: "object",
    additionalProperties: false,
    properties,
  };
}
