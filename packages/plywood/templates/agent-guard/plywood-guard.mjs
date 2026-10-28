#!/usr/bin/env node
// plywood's agent guard, a Claude Code PreToolUse hook on Bash (plywood#19).
// Written by `plywood guard install`; `plywood guard install` writes it again.
// It blocks a command line that runs `pulumi up`, `pulumi destroy` or
// `plunge up` (and `update`, their alias): an agent opens a pull request,
// and the update runs after a person approves its digest. Exit 2 is Claude
// Code's code for a blocked call; its stderr goes back to the agent.

const GUARDED = { pulumi: ["up", "update", "destroy"], plunge: ["up", "update", "destroy"] };
const VALUED_GLOBALS = new Set(["-C", "--cwd", "-s", "--stack", "--color", "--config-file", "--logflow", "-v", "--verbose", "--tracing", "--profiling", "--memprofilerate"]);
const LAUNCHERS = new Set(["env", "npx", "sudo", "command", "exec", "nohup", "time", "xargs"]);

function segments(line) {
  return line
    .split(/\|\||&&|[;|\n`]|\$\(|\)/)
    .map((seg) => (seg.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).map((t) => t.replace(/^['"]|['"]$/g, "")))
    .filter((t) => t.length > 0);
}

/** The refused engine and subcommand, or undefined. Kept in step with src/guard.ts `guardVerdict`. */
export function verdict(line) {
  for (const words of segments(line)) {
    let i = 0;
    while (i < words.length && (LAUNCHERS.has(words[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || (words[i - 1] === "env" && words[i].startsWith("-")))) i++;
    const bin = (words[i] ?? "").split("/").pop();
    const refused = GUARDED[bin];
    if (!refused) continue;
    for (let j = i + 1; j < words.length; j++) {
      const w = words[j];
      if (w.startsWith("-")) {
        if (VALUED_GLOBALS.has(w)) j++;
        continue;
      }
      if (refused.includes(w)) return { engine: bin, subcommand: w };
      break;
    }
  }
  return undefined;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let call;
  try {
    call = JSON.parse(input);
  } catch {
    return 0;
  }
  const command = call?.tool_input?.command;
  if (typeof command !== "string") return 0;
  const v = verdict(command);
  if (!v) return 0;
  process.stderr.write(`plywood guard: an agent session does not run '${v.engine} ${v.subcommand}'. Open a pull request; plywood previews it, and the update runs after a person approves the digest.\n`);
  return 2;
}

if (process.argv[1] && import.meta.url.endsWith("/plywood-guard.mjs") && process.argv[1].endsWith("plywood-guard.mjs")) {
  main().then((code) => process.exit(code));
}
