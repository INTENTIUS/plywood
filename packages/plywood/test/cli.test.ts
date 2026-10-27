import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { helpText, main, type Io } from "../src/cli";
import { FALLBACK_EXIT, exitCodes, isExitTable } from "../src/exit-codes";
import { VERBS } from "../src/words";

const RULED = ["check", "preview", "up", "drift", "approve", "override"];
/** The verbs later units build (plywood#7, #8). */
const NOT_BUILT = ["up", "drift", "approve", "override"];

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
    expect(helpText()).toContain("Pull request automation for Pulumi");
  });

  it.each(NOT_BUILT)("%s says it is not built yet and exits with chant's failed code", async (verb) => {
    const io = capture();
    expect(await main([verb], io)).toBe(FALLBACK_EXIT.failed);
    expect(io.stderr.join("\n")).toBe(`plywood: plywood ${verb} is not built yet.`);
    expect(io.stdout).toEqual([]);
  });

  it("prints one JSON object with --json", async () => {
    const io = capture();
    expect(await main(["up", "--json"], io)).toBe(1);
    expect(io.stdout).toHaveLength(1);
    expect(JSON.parse(io.stdout[0])).toEqual({ command: "up", ok: false, exitCode: 1, error: "plywood up is not built yet." });
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
  it("no module under src runs pulumi, plunge or git", () => {
    const src = join(import.meta.dirname, "../src");
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const text = readFileSync(join(src, f), "utf8");
      expect(text, f).not.toMatch(/node:child_process|["']child_process["']|\bexeca\b|Bun\.spawn/);
    }
  });
});
