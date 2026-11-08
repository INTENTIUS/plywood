/**
 * The note job's read of the control repo (plywood#28): with a control repo
 * in plywood.yml, plywood hands it to chant's build as `--control` and
 * `--control-setting` (chant#4772), and the note job chant writes reads the
 * control repo's records before the post.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chantProduct, setChantProductForTests } from "../src/chant-product";
import { controlBuildArgv } from "../src/config/control";
import { parseConfig } from "../src/config/index";
import { EXIT } from "../src/exit-codes";
import { runInit } from "../src/init";

afterEach(() => setChantProductForTests("reset"));

describe("controlBuildArgv", () => {
  it("names the repo and each setting, with the member from the target unless plywood.yml names one", () => {
    expect(controlBuildArgv(parseConfig("control: github.com/acme/control\n").doc, "shop")).toEqual([
      "--control", "github.com/acme/control", "--control-setting", "member=shop", "--control-setting", "op=pulumi-up",
    ]);
    const doc = parseConfig("control:\n  repo: github.com/acme/control\n  member: web\n  read_token_secret: CONTROL_READ\n").doc;
    expect(controlBuildArgv(doc, "shop")).toEqual([
      "--control", "github.com/acme/control", "--control-setting", "member=web", "--control-setting", "op=pulumi-up", "--control-setting", "readTokenSecret=CONTROL_READ",
    ]);
    expect(controlBuildArgv(parseConfig("stacks: {}\n").doc, "shop")).toEqual([]);
  });
});

const real = await chantProduct();

describe.runIf(real !== undefined)("the note job chant writes with plywood.yml's control repo", () => {
  it("reads the control repo's records before the post, on GitHub", async () => {
    setChantProductForTests("reset");
    const dir = mkdtempSync(join(tmpdir(), "plywood-note-control-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: nodejs\n");
    writeFileSync(join(dir, "Pulumi.dev.yaml"), "config: {}\n");
    writeFileSync(join(dir, "package.json"), '{"name":"shop","private":true}\n');
    writeFileSync(join(dir, "plywood.yml"), "control: github.com/acme/control\n");
    const err: string[] = [];
    const was = process.cwd();
    process.chdir(dir);
    const r = await runInit({ env: "production", bucketCheck: false, dryRun: false, yes: true, forge: "github" }, EXIT, { cwd: dir, env: {}, out: () => {}, err: (s) => err.push(s) }).finally(() => process.chdir(was));
    expect(r.ok, JSON.stringify([r.notes, r.files, err])).toBe(true);
    const file = join(dir, ".github/workflows/plywood.yml");
    expect(existsSync(file)).toBe(true);
    const text = readFileSync(file, "utf8");
    const note = text.slice(text.indexOf("\n  plan-note:"));
    expect(note).toContain("CHANT_CONTROL_DIR=");
    expect(note.indexOf("CHANT_CONTROL_DIR=")).toBeLessThan(note.indexOf("components pr-post"));
  }, 60_000);
});
