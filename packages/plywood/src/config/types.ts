/**
 * The shapes every config group shares. plywood.yml is read in groups, one
 * module per group of keys under src/config/, and src/config/index.ts lists
 * them. A unit that adds keys adds a group file and one line in the index.
 *
 * Each group owns its keys four ways: the JSON schema for them (composed into
 * plywood.schema.json by scripts/build-schema.mjs), the checks the schema
 * cannot make, the defaults, and the translation into chant's settings
 * (src/chant-config.ts). plywood holds the words and the defaults; chant
 * runs every stage with the settings (CONTRIBUTING.md).
 */
import type { ChantSettings } from "../chant-config";

/** A JSON schema fragment, as the group writes it. */
export type JsonSchema = Record<string, unknown>;

/** plywood.yml as parsed, before any check. */
export type RawConfig = Record<string, unknown>;

export interface ConfigProblem {
  /** The key path, as plywood.yml spells it (`locks.grain`, `stacks.shop/dev.gate`). */
  key: string;
  message: string;
  /** `error` fails `plywood config check`; `warning` is printed and the check passes. */
  severity: "error" | "warning";
}

export interface ConfigGroup {
  /** The group's name, for messages and the schema's comment. */
  name: string;
  /** The top-level keys the group owns. */
  keys: readonly string[];
  /** The JSON schema of each key the group owns. */
  schema: Readonly<Record<string, JsonSchema>>;
  /** The checks the schema cannot make. `doc` is the whole file, so a group can read a key another group owns. */
  check(doc: RawConfig): ConfigProblem[];
  /** Writes the group's part of chant's settings from a config that checked clean. */
  translate(doc: RawConfig, out: ChantSettings): void;
}

export function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function error(key: string, message: string): ConfigProblem {
  return { key, message, severity: "error" };
}

export function warning(key: string, message: string): ConfigProblem {
  return { key, message, severity: "warning" };
}

/** A problem when `v` is set and is none of `allowed`. */
export function oneOf(v: unknown, allowed: readonly string[], key: string): ConfigProblem[] {
  if (v === undefined || (typeof v === "string" && allowed.includes(v))) return [];
  return [error(key, `is ${JSON.stringify(v)}; give one of ${allowed.join(", ")}`)];
}

/** Problems for keys of `v` outside `allowed`. */
export function onlyKeys(v: Record<string, unknown>, allowed: readonly string[], key: string): ConfigProblem[] {
  return Object.keys(v)
    .filter((k) => !allowed.includes(k))
    .map((k) => error(`${key}.${k}`, `is not a key of ${key}; its keys are ${allowed.join(", ")}`));
}

/** A problem when `v` is set and is not a mapping. */
export function mapping(v: unknown, key: string): ConfigProblem[] {
  return v === undefined || isObject(v) ? [] : [error(key, "must be a mapping")];
}

/** Problems when `v` is set and is not a list of strings. */
export function stringList(v: unknown, key: string): ConfigProblem[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((s) => typeof s !== "string")) return [error(key, "must be a list of strings")];
  return [];
}

/** A backend URL, at the top level or per stack. */
export const BACKEND_SCHEMA: JsonSchema = {
  type: "string",
  description: "The backend URL. A plunge+ URL (plunge+file://, plunge+s3://) picks the plunge engine.",
};
