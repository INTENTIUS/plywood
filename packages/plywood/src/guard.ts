/**
 * The agent guard (plywood#19): an agent session never runs `pulumi up`,
 * `plunge up` or `pulumi destroy` itself, nor plywood's own verbs that
 * update, approve, override or move a stack. Updates go through a pull
 * request and plywood's gates, where a person approves the digest.
 *
 * The guard is chant's (`installAgentGuard` and `agentGuard` from
 * `@intentius/chant/ci-product`, chant#4770), shared with terragucci. plywood
 * gives its words and rules:
 *
 *   plywood guard check <command line>   says whether the guard refuses it
 *   plywood guard install [--dir <d>]    writes .claude/hooks/plywood-guard.mjs
 *                                        and its PreToolUse entry in
 *                                        .claude/settings.json, and the
 *                                        pulumi and plunge wrappers in
 *                                        .plywood/agent-bin
 */
import { join } from "node:path";
import { agentGuard, installAgentGuard, type AgentGuardSpec } from "@intentius/chant/ci-product";
import type { ExitTable } from "./exit-codes";
import { takeFlag, usage, type StageIo } from "./stages";
import { PRODUCT } from "./words";

const engine = { refuse: ["up", "update", "destroy"], valuedFlags: ["-C", "--cwd", "-s", "--stack", "--color", "--config-file", "--logflow", "-v", "--verbose", "--tracing", "--profiling", "--memprofilerate"] };

/** plywood's words and rules for chant's agent guard. */
export const GUARD: AgentGuardSpec = {
  words: { product: PRODUCT, refusal: `an agent session does not run '{what}'. Open a pull request; ${PRODUCT} previews it, and the update runs after a person approves the digest.` },
  rules: {
    engines: { pulumi: engine, plunge: engine },
    product: { commands: [["up"], ["resume"], ["approve"], ["override"], ["cancel"], ["move"], ["rollback"], ["action"]], flagValues: [["--respond", "up"]] },
    wrapperExit: 1,
  },
};

/** `plywood guard check <command line>` or `plywood guard install [--dir <d>]`. */
export async function guard(args: string[], json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const [sub, ...rest] = args;
  if (sub === "check") {
    const line = (rest[0] === "--" ? rest.slice(1) : rest).join(" ");
    if (!line.trim()) return usage("guard check takes the command line to check", table, io);
    const v = agentGuard(GUARD, { repo: io.cwd }).checkCommand(line, io.cwd);
    const refused = v ? { engine: v.bin, subcommand: v.command, message: v.message } : null;
    if (json) io.out(JSON.stringify({ command: "guard check", ok: !v, exitCode: v ? table.denied : table.done, refused }));
    else io.out(v ? v.message : `${PRODUCT} guard: '${line}' runs`);
    return v ? table.denied : table.done;
  }
  if (sub === "install") {
    const dirFlag = takeFlag(rest, "--dir");
    if (dirFlag.missing) return usage("--dir takes a directory", table, io);
    if (dirFlag.rest.length) return usage(`guard install does not take ${dirFlag.rest.join(" ")}`, table, io);
    const root = dirFlag.value ? join(io.cwd, dirFlag.value) : io.cwd;
    let written: string[];
    try {
      written = installAgentGuard({ ...GUARD, repo: root, install: "project" }).written;
    } catch (e) {
      return usage((e as Error).message, table, io);
    }
    if (json) io.out(JSON.stringify({ command: "guard install", ok: true, exitCode: table.done, written }));
    else {
      for (const f of written) io.err(`${PRODUCT} guard: wrote ${f}`);
      io.err(`${PRODUCT} guard: an agent session that runs outside Claude Code puts .plywood/agent-bin first on PATH`);
    }
    return table.done;
  }
  return usage(`guard takes check <command line> or install [--dir <d>]`, table, io);
}
