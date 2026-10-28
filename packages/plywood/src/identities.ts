/**
 * `plywood config identities [--file <plywood.yml>] [--env <env>]` and
 * `plywood forge check`.
 *
 * `config identities` reads plywood.yml as chant will: the `ci.identity`
 * block it renders (src/config/identity.ts), and for each stack plywood.yml
 * lists, the preview and up identity each cloud gives it, first match wins,
 * with chant's own target glob (`targetGlobMatch`, @intentius/chant/ci-identity).
 * It reads nothing from a forge or a cloud.
 *
 * `forge check`, which holds the identities next to the forge's environments,
 * protected branches and each cloud's trust policy, needs a read in chant
 * core that terragucci and plywood share. chant has none yet, so it says so
 * and exits with chant's `failed` code; plywood keeps no copy of
 * terragucci's.
 */
import { targetGlobMatch } from "@intentius/chant/ci-identity";
import { toChantSettings } from "./chant-config";
import { chantIdentityOf, IDENTITY_CLOUDS, pulumiCloudOf, stackIdentities, type IdentityCloud } from "./config/identity";
import { checkConfig, ConfigError, findConfig, loadConfig, type PlywoodConfig } from "./config/index";
import { stacksOf } from "./config/stacks";
import type { ExitTable } from "./exit-codes";
import { takeFlag, usage, type StageIo } from "./stages";
import { CLOUD_NAMES, NO_IDENTITY, PRODUCT } from "./words";

export interface StackIdentityRow {
  stack: string;
  cloud: IdentityCloud;
  preview: string;
  up: string;
  rule: string;
}

/** Each listed stack's identities for `env`, one row per cloud that names one. */
export function identityRows(config: PlywoodConfig, env: string): StackIdentityRow[] {
  const doc = config.doc;
  const out: StackIdentityRow[] = [];
  for (const stack of Object.keys(stacksOf(doc))) {
    const ids = stackIdentities(doc, stack, env, targetGlobMatch);
    for (const cloud of IDENTITY_CLOUDS) {
      const id = ids[cloud];
      if (id) out.push({ stack, cloud, preview: id.preview, up: id.up, rule: id.rule });
    }
  }
  return out;
}

/** The text lines for `rows`. */
export function identityLines(config: PlywoodConfig, env: string, rows: readonly StackIdentityRow[]): string[] {
  const doc = config.doc;
  const block = chantIdentityOf(doc);
  if (!block) return [`${config.file ?? "plywood.yml"}: no identity; every job runs as ${NO_IDENTITY}`];
  const lines = [`${config.file ?? "plywood.yml"}: identities in environment ${env}`];
  const clouds = Object.keys(block.cloud) as IdentityCloud[];
  lines.push(`  clouds  ${clouds.map((c) => CLOUD_NAMES[c]).join(", ")}`);
  if (clouds.includes("pulumi")) {
    const p = pulumiCloudOf(doc);
    lines.push(`  Pulumi Cloud  ${p.org}${p.apiUrl ? ` at ${p.apiUrl}` : ""}; ESC environments open with each job's own token`);
  }
  const stacks = Object.keys(stacksOf(doc));
  if (stacks.length === 0) lines.push("  plywood.yml lists no stacks; the rules apply to each stack plywood init finds");
  for (const stack of stacks) {
    lines.push(`  ${stack}`);
    for (const cloud of clouds) {
      const r = rows.find((x) => x.stack === stack && x.cloud === cloud);
      lines.push(r ? `    ${CLOUD_NAMES[cloud].padEnd(12)} preview ${r.preview}, up ${r.up} (${r.rule})` : `    ${CLOUD_NAMES[cloud].padEnd(12)} ${NO_IDENTITY}`);
    }
  }
  lines.push("  The preview job trades its OIDC token before checkout, and no later step holds a forge token.");
  return lines;
}

/** `plywood config identities [--file <path>] [--env <env>]`. */
export function configIdentities(args: string[], json: boolean, table: ExitTable, io: StageIo): number {
  const file = takeFlag(args, "--file");
  const env = takeFlag(file.rest, "--env");
  if (file.missing || env.missing) return usage(`${file.missing ? "--file" : "--env"} takes a value`, table, io);
  if (env.rest.length) return usage(`config identities does not take ${env.rest.join(" ")}`, table, io);
  const path = file.value ?? findConfig(io.cwd);
  if (!path) return usage(`no plywood.yml in ${io.cwd} or above it; run '${PRODUCT} init', or pass --file`, table, io);
  let config: PlywoodConfig;
  try {
    config = loadConfig(path);
  } catch (e) {
    return usage(e instanceof ConfigError ? e.message : `${path}: ${(e as Error).message}`, table, io);
  }
  const errors = checkConfig(config).filter((p) => p.severity === "error");
  if (errors.length) {
    for (const p of errors) io.err(`${path}: ${p.key} ${p.message}`);
    if (json) io.out(JSON.stringify({ command: "config identities", ok: false, exitCode: table.failed, file: path, problems: errors }));
    return table.failed;
  }
  const environment = env.value ?? "production";
  const rows = identityRows(config, environment);
  if (json) io.out(JSON.stringify({ command: "config identities", ok: true, exitCode: table.done, file: path, env: environment, identity: toChantSettings(config).ci.identity ?? null, stacks: rows }));
  else for (const line of identityLines(config, environment, rows)) io.out(line);
  return table.done;
}

/** The message `plywood forge check` prints until chant core holds the read. */
export const FORGE_CHECK_MESSAGE =
  `${PRODUCT} forge check holds the identities next to the forge's environments, protected branches and each cloud's trust policy. ` +
  `That read belongs in chant core, shared with terragucci, and no chant has it yet. Run '${PRODUCT} config identities' for what the jobs will hold.`;

/** `plywood forge check`: not in chant yet. */
export function forgeCheck(args: string[], json: boolean, table: ExitTable, io: StageIo): number {
  if (args[0] !== "check") return usage(`unknown forge command '${args[0] ?? ""}'. Run '${PRODUCT} forge check'.`, table, io);
  if (json) io.out(JSON.stringify({ command: "forge check", ok: false, exitCode: table.failed, error: FORGE_CHECK_MESSAGE }));
  else io.err(`${PRODUCT}: ${FORGE_CHECK_MESSAGE}`);
  return table.failed;
}
