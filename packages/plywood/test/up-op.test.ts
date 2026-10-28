/**
 * plywood#22: the waves spec names Op pulumi-up, and chant's waves generator
 * refuses a spec whose Op it cannot discover from a *.op.ts file. writeWaveJobs
 * writes ops/pulumi-up.op.ts before it runs the generator, and plywood's bin
 * resolves the chant imports in that file (and in the drift, review and adopt
 * Op files) from its own install when the repository has no chant.
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ChantProduct } from "../src/chant-product";
import { CHANT_SPECIFIER, chantResolveHook } from "../src/chant-resolve";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { UP_OP_FILE, unwrapWavesSpec, upOpFile, wavesEngine, wavesSpecText, writeUpOp, writeWaveJobs } from "../src/waves-workflow";
import { parseOpWavesSpec } from "@intentius/chant/op";
import { readUpSpec } from "../src/up";
import { readWavesSpec } from "../src/stages";
import { PRODUCT_WORDS } from "../src/words";

const SPEC = {
  name: "pulumi-up",
  op: "pulumi-up",
  step: { kind: "pulumi-up" },
  waves: [
    { name: "dev", runs: [{ target: "network/dev", input: { dir: "network", stack: "dev", member: "network", engine: "plunge" } }, { target: "app/dev", input: { dir: "app", stack: "dev", member: "app" } }] },
    { name: "prod", runs: [{ target: "app/prod", input: { dir: "app", stack: "prod", member: "app", engine: "pulumi", lockGrain: "resource" } }] },
  ],
};

describe("the pulumi-up Op file", () => {
  it("has the spec's Op name and a phase per wave with a preview of each run's stack", () => {
    const text = upOpFile(SPEC);
    expect(text).toContain('import { Op, phase } from "@intentius/chant/op";');
    expect(text).toContain('import { pulumiPreviewStep } from "@intentius/chant-lexicon-pulumi";');
    expect(text).toContain('  name: "pulumi-up",');
    expect(text).toContain(
      '    phase("dev", [pulumiPreviewStep("network", { dir: "network", stack: "dev", engine: "plunge", id: "dev-network-dev" }), pulumiPreviewStep("app", { dir: "app", stack: "dev", id: "dev-app-dev" })]),',
    );
    expect(text).toContain('    phase("prod", [pulumiPreviewStep("app", { dir: "app", stack: "prod", engine: "pulumi", id: "prod-app-prod" })]),');
    // Only the preview's own arguments; the step's apply settings stay in the spec.
    expect(text).not.toContain("lockGrain");
  });

  it("is the same text for the same spec, and writing it twice changes nothing the second time", () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-up-op-"));
    expect(upOpFile(SPEC)).toBe(upOpFile(structuredClone(SPEC)));
    expect(writeUpOp(root, SPEC)).toBe(true);
    expect(writeUpOp(root, SPEC)).toBe(false);
    expect(readFileSync(join(root, UP_OP_FILE), "utf8")).toBe(upOpFile(SPEC));
  });

  it("is on disk when chant's waves generator runs", async () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-up-op-"));
    let seen: string | undefined;
    const chant = {
      runChantInProcess: async (argv: string[]) => {
        seen = existsSync(join(root, UP_OP_FILE)) ? readFileSync(join(root, UP_OP_FILE), "utf8") : undefined;
        const file = join(root, argv[argv.indexOf("--output") + 1]!, "pulumi-up.yml");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `# chant run --generate forgejo --spec .chant/op-waves/pulumi-up.spec.json\njobs: {}\n`);
        return 0;
      },
    } as unknown as ChantProduct;
    const err: string[] = [];
    const waves = { spec: SPEC, specFile: ".chant/op-waves/pulumi-up.spec.json", jobs: [] };
    const code = await writeWaveJobs(chant, "forgejo", waves, PRODUCT_WORDS, FALLBACK_EXIT, { cwd: root, env: {}, out: () => {}, err: (s) => err.push(s) });
    expect(code).toBe(FALLBACK_EXIT.done);
    expect(seen).toBe(upOpFile(SPEC));
    expect(err.join("\n")).toContain(`wrote ${UP_OP_FILE}`);
  });
});

describe("the waves jobs' image and install lines (plywood#22)", () => {
  const engine = { image: "plywood-tutorial-job:local", beforeScript: ["install pulumi", "install plunge"] };

  it("wraps the spec with chant's options when there is an image or a line, and leaves it bare otherwise", () => {
    expect(JSON.parse(wavesSpecText(SPEC, engine))).toEqual({ waves: SPEC, options: engine });
    expect(JSON.parse(wavesSpecText(SPEC, { beforeScript: [] }))).toEqual(SPEC);
    expect(JSON.parse(wavesSpecText(SPEC))).toEqual(SPEC);
    expect(unwrapWavesSpec(JSON.parse(wavesSpecText(SPEC, engine)))).toEqual(SPEC);
    expect(unwrapWavesSpec(SPEC)).toEqual(SPEC);
  });

  it("takes plywood.yml's image and the engines' install lines, as the review and drift jobs do", () => {
    expect(wavesEngine({ image: "img@sha256:" + "a".repeat(64), engineSetup: ["l1"] })).toEqual({ image: "img@sha256:" + "a".repeat(64), beforeScript: ["l1"] });
    expect(wavesEngine({ engineSetup: ["l1"] })).toEqual({ beforeScript: ["l1"] });
    expect(wavesEngine({})).toEqual({});
  });

  it("chant's spec reader, the one its generator and wave jobs use, reads the wrapped file", () => {
    expect(parseOpWavesSpec(wavesSpecText(SPEC, engine), "test")).toMatchObject({ name: "pulumi-up", waves: [{ name: "dev" }, { name: "prod" }] });
  });

  it("writeWaveJobs writes the wrapped file chant's generator reads, and plywood's own readers unwrap it", async () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-up-op-"));
    let atGenerate: string | undefined;
    const chant = {
      runChantInProcess: async (argv: string[]) => {
        atGenerate = readFileSync(join(root, argv[argv.indexOf("--spec") + 1]!), "utf8");
        const file = join(root, argv[argv.indexOf("--output") + 1]!, "pulumi-up.yml");
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, `# chant run --generate forgejo --spec .chant/op-waves/pulumi-up.spec.json\njobs: {}\n`);
        return 0;
      },
    } as unknown as ChantProduct;
    const waves = { spec: SPEC, specFile: ".chant/op-waves/pulumi-up.spec.json", jobs: [] };
    const io = { cwd: root, env: {}, out: () => {}, err: () => {} };
    expect(await writeWaveJobs(chant, "forgejo", waves, PRODUCT_WORDS, FALLBACK_EXIT, io, engine)).toBe(FALLBACK_EXIT.done);
    expect(JSON.parse(atGenerate!)).toEqual({ waves: SPEC, options: engine });
    expect(readWavesSpec(root)).toEqual(SPEC);
    expect(readUpSpec(root)).toMatchObject({ name: "pulumi-up", step: { kind: "pulumi-up" } });
    // The same spec and engine a second time writes nothing new.
    const before = readFileSync(join(root, waves.specFile), "utf8");
    await writeWaveJobs(chant, "forgejo", waves, PRODUCT_WORDS, FALLBACK_EXIT, io, engine);
    expect(readFileSync(join(root, waves.specFile), "utf8")).toBe(before);
  });
});

describe("chant imports from plywood's install", () => {
  const from = "file:///opt/plywood/dist/plywood.mjs";
  const missing = () => Object.assign(new Error("Cannot find package"), { code: "ERR_MODULE_NOT_FOUND" });

  it("covers chant and its lexicons, with subpaths, and nothing else", () => {
    for (const s of ["@intentius/chant", "@intentius/chant/op", "@intentius/chant-lexicon-pulumi", "@intentius/chant-lexicon-pulumi/run"]) expect(CHANT_SPECIFIER.test(s)).toBe(true);
    for (const s of ["@intentius/chantx", "@intentius/plywood", "@pulumi/pulumi", "@intentius/chant-lexicon-"]) expect(CHANT_SPECIFIER.test(s)).toBe(false);
  });

  it("keeps the repository's own chant, and falls back to plywood's when the repository has none", () => {
    const hook = chantResolveHook(from);
    const own = hook("@intentius/chant/op", { parentURL: "file:///repo/ops/pulumi-up.op.ts" }, (s, c) => ({ url: `${c!.parentURL}#${s}` }));
    expect(own.url).toBe("file:///repo/ops/pulumi-up.op.ts#@intentius/chant/op");
    const parents: unknown[] = [];
    const fell = hook("@intentius/chant/op", { parentURL: "file:///repo/ops/pulumi-up.op.ts" }, (s, c) => {
      parents.push(c!.parentURL);
      if (c!.parentURL !== from) throw missing();
      return { url: `file:///opt/plywood/node_modules/${s}` };
    });
    expect(parents).toEqual(["file:///repo/ops/pulumi-up.op.ts", from]);
    expect(fell.url).toBe("file:///opt/plywood/node_modules/@intentius/chant/op");
  });

  it("leaves other packages and other failures as Node reports them", () => {
    const hook = chantResolveHook(from);
    expect(() => hook("@pulumi/pulumi", { parentURL: "file:///repo/index.ts" }, () => { throw missing(); })).toThrow("Cannot find package");
    const syntax = Object.assign(new Error("bad exports"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
    expect(() => hook("@intentius/chant/nope", { parentURL: "file:///repo/x.ts" }, () => { throw syntax; })).toThrow("bad exports");
  });
});
