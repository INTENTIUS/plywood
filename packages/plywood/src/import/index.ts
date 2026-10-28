/**
 * The importers behind `plywood init --from` (plywood#21), one per source:
 *
 *   pulumi-actions  GitHub Actions workflows using pulumi/actions (./pulumi-actions.ts)
 *   deployments     Pulumi Deployments settings files the user exported (./deployments.ts)
 *   spacelift       .spacelift/config.yml (./spacelift.ts)
 *   env0            env0.workflow.yml and env0.yml (./env0.ts)
 *
 * `--from` takes a source's name (its files are found where the source keeps
 * them), `<source>=<file>[,<file>]`, or a file, whose source its path says.
 * Each importer reads files in the repository only and returns plywood.yml
 * keys and the settings it could not carry, by name.
 */
import { basename } from "node:path";
import type { Detected } from "../init/detect";
import { importDeployments } from "./deployments";
import { importEnv0 } from "./env0";
import { importPulumiActions } from "./pulumi-actions";
import { importSpacelift } from "./spacelift";
import { IMPORT_SOURCES, type ImportResult, type ImportSource, type Importer } from "./types";

export { IMPORT_SOURCES, importLines, mergeKeys, type ImportResult, type ImportSource, type Unsupported } from "./types";

export const IMPORTERS: Readonly<Record<ImportSource, Importer>> = {
  "pulumi-actions": importPulumiActions,
  deployments: importDeployments,
  spacelift: importSpacelift,
  env0: importEnv0,
};

export interface FromFlag {
  source: ImportSource;
  files: string[];
}

/** The source a file's path names, if any. */
export function sourceOfFile(file: string): ImportSource | undefined {
  const name = basename(file);
  if (/(^|\/)\.(github|forgejo|gitea)\/workflows\//.test(file)) return "pulumi-actions";
  if (/^Pulumi\.[^.]+\.deploy\.(ya?ml|json)$/.test(name)) return "deployments";
  if (/(^|\/)\.spacelift\//.test(file)) return "spacelift";
  if (/^env0(\.workflow)?\.ya?ml$/.test(name)) return "env0";
  return undefined;
}

/** `--from`'s value, or why it is not one. */
export function parseFrom(value: string): FromFlag | { error: string } {
  const eq = value.indexOf("=");
  const head = eq >= 0 ? value.slice(0, eq) : value;
  if ((IMPORT_SOURCES as readonly string[]).includes(head)) {
    const files = eq >= 0 ? value.slice(eq + 1).split(",").map((f) => f.trim().replace(/^\.\//, "")).filter(Boolean) : [];
    if (eq >= 0 && files.length === 0) return { error: `--from ${head}= names no file` };
    return { source: head as ImportSource, files };
  }
  const file = value.replace(/^\.\//, "");
  const source = sourceOfFile(file);
  if (!source) return { error: `--from ${value} is not one of ${IMPORT_SOURCES.join(", ")}, and its path names none; give <source>=${value}` };
  return { source, files: [file] };
}

/** Runs the importer `--from` names. */
export function runImport(root: string, detected: Detected, from: FromFlag): ImportResult {
  try {
    return IMPORTERS[from.source](root, detected, from.files);
  } catch (e) {
    const file = from.files[0] ?? "(its files)";
    return { source: from.source, files: [], keys: {}, unsupported: [{ file, setting: "(file)", why: `could not be read: ${(e as Error).message}` }], notes: [] };
  }
}
