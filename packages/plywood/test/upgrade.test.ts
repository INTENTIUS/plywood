import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FALLBACK_EXIT } from "../src/exit-codes";
import {
  imageNote,
  moveDeclarationPins,
  movedRange,
  movePackagePins,
  parseUpgradeArgs,
  upgrade,
  viewRelease,
  type Exec,
  type UpgradeIo,
} from "../src/upgrade";

const PKG = {
  name: "shop",
  private: true,
  devDependencies: {
    "@intentius/plywood": "0.1.0",
    "@intentius/chant": "0.124.54",
    "@intentius/chant-lexicon-pulumi": "^0.124.54",
    "@pulumi/aws": "^7.0.0",
  },
};
const DECL = {
  name: "shop",
  schema: 1,
  members: [{ name: "shop", dir: ".", kind: "pulumi" }],
  pins: [{ package: "@intentius/chant-lexicon-pulumi", version: "0.124.54" }],
};

/** A repository plywood init has set up: package.json, chant.workspace.json, plywood.yml and a lock file. */
function fixtureRepo(plywoodYml = "stacks:\n  dev: {}\n"): string {
  const root = mkdtempSync(join(tmpdir(), "plywood-upgrade-"));
  writeFileSync(join(root, "package.json"), `${JSON.stringify(PKG, null, 2)}\n`);
  writeFileSync(join(root, "chant.workspace.json"), `${JSON.stringify(DECL, null, 2)}\n`);
  writeFileSync(join(root, "plywood.yml"), plywoodYml);
  writeFileSync(join(root, "package-lock.json"), "{}\n");
  return root;
}

/** npm and npx stand-ins: npm view answers from `releases`, npm install writes the new plywood into node_modules. */
function fakeExec(releases: Record<string, { version: string; chant: string }>, calls: string[], ciCode = 0): Exec {
  return async (bin, args, opts) => {
    calls.push(`${bin} ${args.join(" ")}`);
    if (bin === "npm" && args[0] === "view") {
      const spec = args[1].replace("@intentius/plywood@", "");
      const r = releases[spec];
      if (!r) return { code: 1, stdout: "", stderr: "npm error code E404" };
      return { code: 0, stdout: JSON.stringify({ version: r.version, dependencies: { "@intentius/chant": r.chant, "@intentius/chant-lexicon-pulumi": r.chant } }), stderr: "" };
    }
    if (bin === "npm" && args[0] === "install") {
      const want = JSON.parse(readFileSync(join(opts.cwd, "package.json"), "utf8")).devDependencies["@intentius/plywood"];
      mkdirSync(join(opts.cwd, "node_modules/@intentius/plywood"), { recursive: true });
      writeFileSync(join(opts.cwd, "node_modules/@intentius/plywood/package.json"), JSON.stringify({ version: want }));
      return { code: 0, stdout: "", stderr: "" };
    }
    if (bin === "npx") return { code: ciCode, stdout: "", stderr: "" };
    return { code: 127, stdout: "", stderr: `${bin} not faked` };
  };
}

function io(cwd: string, exec: Exec, out: string[] = [], err: string[] = []): UpgradeIo {
  return { cwd, env: {}, out: (s) => out.push(s), err: (s) => err.push(s), exec };
}

const RELEASES = { latest: { version: "0.2.0", chant: "0.125.0" }, "0.2.0": { version: "0.2.0", chant: "0.125.0" } };

describe("plywood upgrade's pieces", () => {
  it("parses a version, the chant override and the switches", () => {
    expect(parseUpgradeArgs(["v0.2.0", "--chant", "0.125.1", "--no-install"])).toEqual({ version: "0.2.0", chant: "0.125.1", install: false, dryRun: false });
    expect(parseUpgradeArgs([])).toEqual({ install: true, dryRun: false });
    expect(parseUpgradeArgs(["0.2"])).toHaveProperty("error");
    expect(parseUpgradeArgs(["0.2.0", "0.3.0"])).toHaveProperty("error");
    expect(parseUpgradeArgs(["--chant"])).toHaveProperty("error");
    expect(parseUpgradeArgs(["--force"])).toHaveProperty("error");
  });

  it("keeps a range's ^ or ~ and leaves a tag or path alone", () => {
    expect(movedRange("0.1.0", "0.2.0")).toBe("0.2.0");
    expect(movedRange("^0.1.0", "0.2.0")).toBe("^0.2.0");
    expect(movedRange("~0.1.0", "0.2.0")).toBe("~0.2.0");
    expect(movedRange("latest", "0.2.0")).toBeUndefined();
    expect(movedRange("file:../plywood", "0.2.0")).toBeUndefined();
  });

  it("moves plywood and every chant package in package.json, and nothing else", () => {
    const r = movePackagePins(JSON.stringify(PKG, null, 2), "package.json", "0.2.0", "0.125.0");
    const pkg = JSON.parse(r.text);
    expect(pkg.devDependencies).toEqual({ "@intentius/plywood": "0.2.0", "@intentius/chant": "0.125.0", "@intentius/chant-lexicon-pulumi": "^0.125.0", "@pulumi/aws": "^7.0.0" });
    expect(r.moves.map((m) => m.name)).toEqual(["@intentius/plywood", "@intentius/chant", "@intentius/chant-lexicon-pulumi"]);
    expect(r.left).toEqual([]);
  });

  it("names a range it cannot move", () => {
    const r = movePackagePins(JSON.stringify({ devDependencies: { "@intentius/plywood": "next" } }), "package.json", "0.2.0", "0.125.0");
    expect(r.moves).toEqual([]);
    expect(r.left[0]).toMatch(/'next'.*by hand/);
  });

  it("moves chant.workspace.json's chant pins", () => {
    const r = moveDeclarationPins(JSON.stringify(DECL, null, 2), "chant.workspace.json", "0.125.0");
    expect(JSON.parse(r.text).pins).toEqual([{ package: "@intentius/chant-lexicon-pulumi", version: "0.125.0" }]);
    expect(r.moves).toEqual([{ file: "chant.workspace.json", name: "@intentius/chant-lexicon-pulumi", from: "0.124.54", to: "0.125.0" }]);
  });

  it("notes an image key the upgrade does not move", () => {
    expect(imageNote({}, "0.2.0")).toBeUndefined();
    expect(imageNote({ image: "ghcr.io/intentius/plywood-pulumi:0.2.0-pulumi3.272.0@sha256:" + "a".repeat(64) }, "0.2.0")).toBeUndefined();
    expect(imageNote({ image: "ghcr.io/intentius/plywood-pulumi:0.1.0-pulumi3.272.0" }, "0.2.0")).toMatch(/0\.2\.0 image/);
    expect(imageNote({ image: { name: "ghcr.io/acme/ci:1" } }, "0.2.0")).toMatch(/rebuild it FROM/);
  });

  it("reads the release and its chant from npm view, and says when npm has none", async () => {
    const calls: string[] = [];
    expect(await viewRelease(fakeExec(RELEASES, calls), "/", {})).toEqual({ version: "0.2.0", chant: "0.125.0" });
    expect(calls).toEqual(["npm view @intentius/plywood@latest version dependencies --json"]);
    expect(await viewRelease(fakeExec(RELEASES, []), "/", {}, "9.9.9")).toEqual({ error: "npm has no @intentius/plywood@9.9.9" });
  });
});

describe("plywood upgrade on a fixture repository", () => {
  it("moves the pins, installs, and writes the workflow again with the new plywood: one diff", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    const err: string[] = [];
    expect(await upgrade([], false, FALLBACK_EXIT, io(root, fakeExec(RELEASES, calls), [], err))).toBe(FALLBACK_EXIT.done);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@intentius/plywood"]).toBe("0.2.0");
    expect(JSON.parse(readFileSync(join(root, "chant.workspace.json"), "utf8")).pins[0].version).toBe("0.125.0");
    expect(calls).toEqual([
      "npm view @intentius/plywood@latest version dependencies --json",
      "npm install --no-audit --no-fund",
      "npx --no-install plywood ci",
    ]);
    expect(err.join("\n")).toMatch(/Open one pull request with package.json, chant.workspace.json, package-lock.json/);
  });

  it("a second run moves nothing", async () => {
    const root = fixtureRepo();
    await upgrade(["0.2.0"], false, FALLBACK_EXIT, io(root, fakeExec(RELEASES, [])));
    const before = readFileSync(join(root, "package.json"), "utf8");
    const out: string[] = [];
    expect(await upgrade(["0.2.0"], true, FALLBACK_EXIT, io(root, fakeExec(RELEASES, []), out))).toBe(FALLBACK_EXIT.done);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(JSON.parse(out[0]).moves).toEqual([]);
  });

  it("--dry-run writes and runs nothing past npm view", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    const before = readFileSync(join(root, "package.json"), "utf8");
    const out: string[] = [];
    expect(await upgrade(["--dry-run"], true, FALLBACK_EXIT, io(root, fakeExec(RELEASES, calls), out))).toBe(FALLBACK_EXIT.done);
    expect(readFileSync(join(root, "package.json"), "utf8")).toBe(before);
    expect(calls).toHaveLength(1);
    const doc = JSON.parse(out[0]);
    expect(doc.dryRun).toBe(true);
    expect(doc.moves).toHaveLength(4);
    expect(doc.steps.ci.command).toBe("npx --no-install plywood ci");
  });

  it("--no-install writes the files and prints the commands left", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    const err: string[] = [];
    expect(await upgrade(["0.2.0", "--no-install", "--chant", "0.125.3"], false, FALLBACK_EXIT, io(root, fakeExec(RELEASES, calls), [], err))).toBe(FALLBACK_EXIT.done);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).devDependencies["@intentius/chant"]).toBe("0.125.3");
    expect(calls).toHaveLength(1);
    expect(err.join("\n")).toMatch(/left to run: npm install/);
  });

  it("passes --forge and --env to plywood ci, and its failure through", async () => {
    const root = fixtureRepo();
    const calls: string[] = [];
    expect(await upgrade(["--forge", "gitlab", "--env", "staging"], false, FALLBACK_EXIT, io(root, fakeExec(RELEASES, calls, 3)))).toBe(3);
    expect(calls[2]).toBe("npx --no-install plywood ci --forge gitlab --env staging");
  });

  it("refuses a repository with no plywood dependency, and a release npm lacks", async () => {
    const empty = mkdtempSync(join(tmpdir(), "plywood-upgrade-none-"));
    writeFileSync(join(empty, "package.json"), "{}\n");
    const err: string[] = [];
    expect(await upgrade([], false, FALLBACK_EXIT, io(empty, fakeExec(RELEASES, []), [], err))).toBe(FALLBACK_EXIT.failed);
    expect(err[0]).toMatch(/depends on @intentius\/plywood/);
    const root = fixtureRepo();
    expect(await upgrade(["9.9.9"], false, FALLBACK_EXIT, io(root, fakeExec(RELEASES, [])))).toBe(FALLBACK_EXIT.failed);
  });
});
