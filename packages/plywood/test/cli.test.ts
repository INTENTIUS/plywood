import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helpText, main, type Io } from "../src/cli";
import { FALLBACK_EXIT, exitCodes, isExitTable } from "../src/exit-codes";
import { VERBS } from "../src/words";
import { setChantProductForTests } from "../src/chant-product";

const RULED = ["check", "preview", "up", "drift", "approve", "override"];

function capture(): Io & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

describe("plywood CLI", () => {
  it("lists the ruled verbs in --help", async () => {
    expect(VERBS.map((v) => v.verb)).toEqual(RULED);
    const io = capture();
    expect(await main(["--help"], io)).toBe(0);
    for (const v of RULED) expect(io.stdout.join("\n")).toMatch(new RegExp(`^  ${v}\\s`, "m"));
    expect(helpText()).toContain("CI Automation for Pulumi");
  });

  it("prints one JSON object with --json", async () => {
    const io = capture();
    expect(await main(["apply", "--json"], io)).toBe(FALLBACK_EXIT.failed);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0])).toEqual({ command: "apply", ok: false, exitCode: 1, error: "unknown command 'apply'. Run 'plywood --help' for the commands." });
    expect(io.stderr).toEqual([]);
  });

  it("lists resume in --help and runs chant run resume through plywood's words (plywood#26)", async () => {
    expect(helpText()).toMatch(/^  resume \[--op <op>\] \[--wave <k>\]/m);
    const calls: string[][] = [];
    setChantProductForTests({
      assertProductWords: (w) => w as never,
      productPipelineJobs: () => ({}) as never,
      approveLine: () => "",
      runChantInProcess: async (argv) => (calls.push(argv), 0),
    });
    try {
      expect(await main(["resume", "--wave", "1"], capture())).toBe(0);
      expect(calls).toEqual([["run", "resume", "--op", "pulumi-up", "--gate", "wave-1"]]);
    } finally {
      setChantProductForTests("reset");
    }
  });

  it("exits 1 on an unknown command", async () => {
    const io = capture();
    expect(await main(["apply"], io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("unknown command 'apply'");
  });
});

describe("exit codes", () => {
  it("falls back to the table ruled on chant#4553", () => {
    expect(FALLBACK_EXIT).toEqual({ done: 0, failed: 1, drift: 2, waiting: 3, moved: 4, held: 5, superseded: 6, denied: 7, declined: 8 });
  });

  it("uses chant's table when chant has one, else the fallback", async () => {
    const { table, source } = await exitCodes();
    expect(isExitTable(table)).toBe(true);
    if (source === "fallback") expect(table).toBe(FALLBACK_EXIT);
    else expect(table.moved).not.toBe(table.waiting);
  });

  it("refuses a table missing a code", () => {
    expect(isExitTable({ ...FALLBACK_EXIT, moved: undefined })).toBe(false);
    expect(isExitTable(null)).toBe(false);
  });
});

describe("placement", () => {
  // plywood holds words; chant runs pulumi, plunge and git (CONTRIBUTING.md).
  // plywood upgrade (plywood#23) alone spawns, and only npm and npx.
  it("no module under src runs pulumi, plunge or git", () => {
    const src = join(import.meta.dirname, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(src, f), "utf8");
      if (f === "upgrade.ts") {
        expect([...text.matchAll(/\bexec\("([^"]+)"/g)].map((m) => m[1])).toEqual(["npm", "npm", "npx"]);
        continue;
      }
      expect(text, f).not.toMatch(/node:child_process|["']child_process["']|\bexeca\b|Bun\.spawn/);
    }
  });
});
