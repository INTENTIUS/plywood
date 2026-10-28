/**
 * The agent guard (plywood#19): an agent session never runs `pulumi up`,
 * `plunge up` or `pulumi destroy` itself. Updates go through a pull request
 * and plywood's gates, where a person approves the digest.
 *
 * Two layers, both in packages/plywood/templates/agent-guard/:
 *
 *   plywood-guard.mjs  a Claude Code PreToolUse hook on Bash: it reads the
 *                      tool call on stdin and blocks (exit 2, Claude Code's
 *                      block code) a command line that would update or
 *                      destroy a stack
 *   bin/pulumi, bin/plunge
 *                      wrappers put first on PATH in an agent session; with
 *                      PLYWOOD_AGENT_GUARD=1 (or CLAUDECODE=1) they refuse
 *                      the same subcommands and pass everything else to the
 *                      real binary further down PATH
 *
 *   plywood guard check <command line>   says whether the guard refuses it
 *   plywood guard install [--dir <d>]    writes .claude/hooks/plywood-guard.mjs
 *                                        and its PreToolUse entry in
 *                                        .claude/settings.json, and copies the
 *                                        wrappers to .plywood/agent-bin
 *
 * `guardVerdict` here and `verdict` in the hook template hold one rule;
 * test/guard.test.ts holds them to the same answers.
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExitTable } from "./exit-codes";
import { takeFlag, usage, type StageIo } from "./stages";
import { PRODUCT } from "./words";

/** The engines and the subcommands the guard refuses in an agent session. */
export const GUARDED: Readonly<Record<string, readonly string[]>> = {
  pulumi: ["up", "update", "destroy"],
  plunge: ["up", "update", "destroy"],
};

/** Global flags that take a value before the subcommand (`pulumi -C dir up`). */
const VALUED_GLOBALS = new Set(["-C", "--cwd", "-s", "--stack", "--color", "--config-file", "--logflow", "-v", "--verbose", "--tracing", "--profiling", "--memprofilerate"]);
/** Words that run the next word as the command. */
const LAUNCHERS = new Set(["env", "npx", "sudo", "command", "exec", "nohup", "time", "xargs"]);

/** Split a shell line into the simple commands it runs, roughly: on ;, &&, ||, |, newlines, $( and backticks. */
function segments(line: string): string[][] {
  return line
    .split(/\|\||&&|[;|\n`]|\$\(|\)/)
    .map((seg) => (seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, "")))
    .filter((t) => t.length > 0);
}

/** The refusal for a command line, or undefined when the guard lets it run. */
export function guardVerdict(line: string): { engine: string; subcommand: string; message: string } | undefined {
  for (const words of segments(line)) {
    let i = 0;
    while (i < words.length && (LAUNCHERS.has(words[i]!) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) || (words[i - 1] === "env" && words[i]!.startsWith("-")))) i++;
    const bin = (words[i] ?? "").split("/").pop()!;
    const refused = GUARDED[bin];
    if (!refused) continue;
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j]!;
      if (w.startsWith("-")) {
        if (VALUED_GLOBALS.has(w)) j++;
        continue;
      }
      if (refused.includes(w)) {
        return {
          engine: bin,
          subcommand: w,
          message: `${PRODUCT} guard: an agent session does not run '${bin} ${w}'. Open a pull request; ${PRODUCT} previews it, and the update runs after a person approves the digest.`,
        };
      }
      break;
    }
  }
  return undefined;
}

/** The guard's templates, shipped in the package beside dist/. */
export const GUARD_TEMPLATES = new URL("../templates/agent-guard/", import.meta.url);

/** The PreToolUse entry `plywood guard install` adds to .claude/settings.json. */
export const HOOK_COMMAND = 'node "$CLAUDE_PROJECT_DIR/.claude/hooks/plywood-guard.mjs"';

/** `settings` with the guard's PreToolUse hook on Bash, added once. */
export function withGuardHook(settings: Record<string, unknown>): Record<string, unknown> {
  const hooks = (typeof settings.hooks === "object" && settings.hooks !== null ? settings.hooks : {}) as Record<string, unknown>;
  const pre = Array.isArray(hooks.PreToolUse) ? [...(hooks.PreToolUse as unknown[])] : [];
  const has = JSON.stringify(pre).includes("plywood-guard.mjs");
  if (!has) pre.push({ matcher: "Bash", hooks: [{ type: "command", command: HOOK_COMMAND }] });
  return { ...settings, hooks: { ...hooks, PreToolUse: pre } };
}

/** `plywood guard check <command line>` or `plywood guard install [--dir <d>]`. */
export async function guard(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "check") {
    const line = (rest[0] === "--" ? rest.slice(1) : rest).join(" ");
    if (!line.trim()) return usage("guard check takes the command line to check", table, io);
    const v = guardVerdict(line);
    if (json) io.out(JSON.stringify({ command: "guard check", ok: !v, exitCode: v ? table.denied : table.done, refused: v ?? null }));
    else io.out(v ? v.message : `${PRODUCT} guard: '${line}' runs`);
    return v ? table.denied : table.done;
  }
  if (sub === "install") {
    const dirFlag = takeFlag(rest, "--dir");
    if (dirFlag.missing) return usage("--dir takes a directory", table, io);
    if (dirFlag.rest.length) return usage(`guard install does not take ${dirFlag.rest.join(" ")}`, table, io);
    const root = dirFlag.value ? join(io.cwd, dirFlag.value) : io.cwd;
    const written: string[] = [];
    const hookDir = join(root, ".claude/hooks");
    mkdirSync(hookDir, { recursive: true });
    copyFileSync(new URL("plywood-guard.mjs", GUARD_TEMPLATES), join(hookDir, "plywood-guard.mjs"));
    written.push(".claude/hooks/plywood-guard.mjs");
    const settingsFile = join(root, ".claude/settings.json");
    let settings: Record<string, unknown> = {};
    if (existsSync(settingsFile)) {
      try {
        settings = JSON.parse(readFileSync(settingsFile, "utf8")) as Record<string, unknown>;
      } catch (e) {
        return usage(`.claude/settings.json is not JSON (${(e as Error).message}); fix it, then run this again`, table, io);
      }
    }
    writeFileSync(settingsFile, JSON.stringify(withGuardHook(settings), null, 2) + "\n");
    written.push(".claude/settings.json");
    const binDir = join(root, ".plywood/agent-bin");
    mkdirSync(binDir, { recursive: true });
    for (const name of Object.keys(GUARDED)) {
      const to = join(binDir, name);
      copyFileSync(new URL(`bin/${name}`, GUARD_TEMPLATES), to);
      chmodSync(to, 0o755);
      written.push(`.plywood/agent-bin/${name}`);
    }
    if (json) io.out(JSON.stringify({ command: "guard install", ok: true, exitCode: table.done, written }));
    else {
      for (const f of written) io.err(`${PRODUCT} guard: wrote ${f}`);
      io.err(`${PRODUCT} guard: an agent session that runs outside Claude Code puts .plywood/agent-bin first on PATH and sets PLYWOOD_AGENT_GUARD=1`);
    }
    return table.done;
  }
  return usage(`guard takes check <command line> or install [--dir <d>]`, table, io);
}
