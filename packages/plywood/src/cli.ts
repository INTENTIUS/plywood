/**
 * The plywood CLI. Each verb hands plywood's words to chant, which runs the
 * stage in process (chant#4550 ruling C). No verb is wired to chant yet:
 * each says so and exits with chant's `failed` code. `config check` reads
 * plywood.yml (src/config-check.ts).
 *
 * Every command takes `--json`, which prints one JSON object on stdout in
 * place of the text.
 */
import { configCheck } from "./config-check";
import { exitCodes, type ExitTable } from "./exit-codes";
import { PRODUCT, TAGLINE, VERBS, type Verb } from "./words";

declare const __PLYWOOD_VERSION__: string | undefined;

/** The package version, set by scripts/build-cli.mjs. */
export const VERSION = typeof __PLYWOOD_VERSION__ === "string" ? __PLYWOOD_VERSION__ : "0.0.0-dev";

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

const stdio: Io = {
  out: (s) => process.stdout.write(s + "\n"),
  err: (s) => process.stderr.write(s + "\n"),
};

export function helpText(): string {
  const width = Math.max(...VERBS.map((v) => v.verb.length));
  return [
    `${PRODUCT}: ${TAGLINE}`,
    "",
    `Usage: ${PRODUCT} <command> [--json]`,
    "",
    "Commands:",
    ...VERBS.map((v) => `  ${v.verb.padEnd(width)}  ${v.summary}`),
    "",
    "Config:",
    "  config check [--file <path>]  check plywood.yml and print the settings in force",
    "",
    "Options:",
    "  --json     print one JSON object on stdout",
    "  --help     show this help",
    "  --version  print the version",
  ].join("\n");
}

/** Runs one command line (without the node and script arguments) and returns its exit code. */
export async function main(argv: string[], io: Io = stdio): Promise<number> {
  const { table, source } = await exitCodes();
  const json = argv.includes("--json");
  const args = argv.filter((a) => a !== "--json");
  const verb = args[0];
  const emit = (envelope: Record<string, unknown>, text: string, toErr = false): void => {
    if (json) io.out(JSON.stringify(envelope));
    else (toErr ? io.err : io.out)(text);
  };

  if (verb === undefined || verb === "--help" || verb === "-h" || verb === "help") {
    emit({ command: "help", ok: true, exitCode: table.done, verbs: VERBS }, helpText());
    return table.done;
  }
  if (verb === "--version" || verb === "-v") {
    emit({ command: "version", ok: true, exitCode: table.done, version: VERSION, exitCodes: source }, VERSION);
    return table.done;
  }
  if (verb === "config") return config(args.slice(1), table, emit);
  const known = VERBS.find((v) => v.verb === verb);
  if (!known) {
    // A usage error is chant's `failed`, 1 (chant#4553 ruling C).
    const message = `unknown command '${verb}'. Run '${PRODUCT} --help' for the commands.`;
    emit({ command: verb, ok: false, exitCode: table.failed, error: message }, `${PRODUCT}: ${message}`, true);
    return table.failed;
  }
  return notBuilt(known.verb, table.failed, emit);
}

function notBuilt(
  verb: Verb,
  code: number,
  emit: (envelope: Record<string, unknown>, text: string, toErr?: boolean) => void,
): number {
  const message = `${PRODUCT} ${verb} is not built yet.`;
  emit({ command: verb, ok: false, exitCode: code, error: message }, `${PRODUCT}: ${message}`, true);
  return code;
}

type Emit = (envelope: Record<string, unknown>, text: string, toErr?: boolean) => void;

/** `plywood config check [--file <path>]`. A config with an error exits with chant's `failed`. */
function config(args: string[], table: ExitTable, emit: Emit): number {
  const [sub, ...rest] = args;
  const command = `config ${sub ?? ""}`.trim();
  const fileAt = rest.indexOf("--file");
  const file = fileAt >= 0 ? rest[fileAt + 1] : undefined;
  if (sub !== "check" || (fileAt >= 0 && !file)) {
    const message = sub !== "check" ? `unknown config command '${sub ?? ""}'. Run '${PRODUCT} config check'.` : "--file takes a path";
    emit({ command, ok: false, exitCode: table.failed, error: message }, `${PRODUCT}: ${message}`, true);
    return table.failed;
  }
  const r = configCheck(process.cwd(), file);
  const code = r.ok ? table.done : table.failed;
  emit({ command, ok: r.ok, exitCode: code, ...r.envelope }, r.lines.join("\n"), !r.ok);
  return code;
}
