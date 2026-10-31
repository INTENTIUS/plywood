// vitest globalSetup: the test run must leave the checkout as it found it.
// A test that runs chant's in-process generator writes under process.cwd(), so
// one that forgets to chdir into a temp directory drops workflows into the
// repository (0f8d285 committed two). This fails the run and names the files.
import { execFileSync } from "node:child_process";

const status = () => {
  try {
    return execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { encoding: "utf8" }).split("\n").filter(Boolean);
  } catch {
    return undefined;
  }
};

let before;

export function setup() {
  before = status();
}

export function teardown() {
  if (!before) return;
  const after = status();
  if (!after) return;
  const known = new Set(before);
  const added = after.filter((l) => !known.has(l));
  if (added.length > 0) throw new Error(`the tests changed the checkout; a test wrote outside its temp directory:\n${added.join("\n")}`);
}
