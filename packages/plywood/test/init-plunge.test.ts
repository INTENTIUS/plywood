import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setChantProductForTests } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { engineOf } from "../src/config/engine";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { initLines, runInit, type InitIo, type InitOptions } from "../src/init";
import { ADOPT_OP_FILE, adoptCommand, adoptGate, adoptLines, adoptOpFile, setChantAdoptForTests, stacksToAdopt, type AdoptPreview, type AdoptView, type ChantAdopt } from "../src/init/adopt";
import { setBucketCheckForTests, type BucketReport } from "../src/init/backend";
import { MOVE_A_STACK_GUIDE, plungeKeys, plungeUrlOf } from "../src/init/engine";

function io(cwd: string, env: NodeJS.ProcessEnv = {}): InitIo {
  return { cwd, env, out: () => undefined, err: () => undefined };
}

const OPTS: InitOptions = { env: "production", bucketCheck: true, dryRun: false, yes: true, engine: "plunge" };

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "plywood-plunge-"));
  mkdirSync(join(root, ".git", "refs", "remotes", "origin"), { recursive: true });
  writeFileSync(join(root, ".git", "config"), '[remote "origin"]\n\turl = git@github.com:acme/shop.git\n');
  writeFileSync(join(root, ".git", "refs", "remotes", "origin", "HEAD"), "ref: refs/remotes/origin/main\n");
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

const FLOCI = "s3://state/shop?region=us-east-1&endpoint=localhost:4566&disableSSL=true&s3ForcePathStyle=true";
const FLOCI_ENV = { AWS_ACCESS_KEY_ID: "test", AWS_SECRET_ACCESS_KEY: "test" };

const ON_FILE = {
  "infra/Pulumi.yaml": "name: shop\nruntime: nodejs\nbackend:\n  url: file:///srv/state\n",
  "infra/Pulumi.dev.yaml": "",
  "infra/Pulumi.prod.yaml": "",
};

const ON_FLOCI = {
  "infra/Pulumi.yaml": `name: shop\nruntime: nodejs\nbackend:\n  url: ${FLOCI}\n`,
  "infra/Pulumi.dev.yaml": "",
};

/** A fake adopt preview, recording each call. */
function fakeAdopt(view: (stack: string) => AdoptView | Error, hasOp = true): ChantAdopt & { calls: Array<{ dir: string; stack: string; backend: string }> } {
  const calls: Array<{ dir: string; stack: string; backend: string }> = [];
  return {
    calls,
    hasOp,
    async preview(input) {
      calls.push(input);
      const v = view(input.stack);
      if (v instanceof Error) throw v;
      return v;
    },
  };
}

const wouldAdopt = (stack: string): AdoptView => ({
  stack,
  status: "would-adopt",
  checkpoint: { digest: "sha256:abc" },
  resources: [
    { urn: "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::site", type: "aws:s3/bucket:Bucket", id: "site", fate: "marker" },
    { urn: "urn:pulumi:dev::shop::pulumi:pulumi:Stack::shop-dev", type: "pulumi:pulumi:Stack", id: "", fate: "record" },
  ],
  refusals: [],
});

afterEach(() => {
  setChantProductForTests("reset");
  setBucketCheckForTests("reset");
  setChantAdoptForTests("reset");
});

describe("plunge URLs", () => {
  it("gives file, s3, azblob and gs backends their plunge+ form and points Pulumi Cloud at the move guide", () => {
    expect(plungeUrlOf("file:///srv/state")).toEqual({ url: "plunge+file:///srv/state" });
    expect(plungeUrlOf(FLOCI)).toEqual({ url: `plunge+${FLOCI}` });
    expect(plungeUrlOf("azblob://state")).toEqual({ url: "plunge+azblob://state" });
    expect(plungeUrlOf("gs://state/p")).toEqual({ url: "plunge+gs://state/p" });
    expect(plungeUrlOf("plunge+s3://state")).toEqual({ url: "plunge+s3://state" });
    expect(plungeUrlOf(undefined)).toEqual({ pointer: expect.stringContaining(MOVE_A_STACK_GUIDE) });
    expect(plungeUrlOf("https://api.pulumi.com")).toEqual({ pointer: expect.stringContaining("Pulumi Cloud") });
    expect(plungeUrlOf("postgres://db/state")).toEqual({ pointer: expect.stringContaining("no plunge+ form for postgres") });
  });

  it("writes one backend when the stacks share it, else one per stack, and engine only when every stack moves", () => {
    const s = (key: string, url?: string) => ({ key, project: key.split("/")[0]!, stack: key.split("/")[1]!, dir: "infra", source: "Pulumi.yaml" as const, ...(url ? { url } : { pointer: "is on Pulumi Cloud" }) });
    expect(plungeKeys([s("shop/dev", "plunge+file:///a"), s("shop/prod", "plunge+file:///a")])).toEqual({ engine: "plunge", backend: "plunge+file:///a" });
    expect(plungeKeys([s("shop/dev", "plunge+file:///a"), s("net/dev", "plunge+s3://b")])).toEqual({
      engine: "plunge",
      stacks: { "shop/dev": { dir: "infra", backend: "plunge+file:///a" }, "net/dev": { dir: "infra", backend: "plunge+s3://b" } },
    });
    expect(plungeKeys([s("shop/dev", "plunge+file:///a"), s("cloud/dev")])).toEqual({ stacks: { "shop/dev": { dir: "infra", backend: "plunge+file:///a" } } });
    expect(plungeKeys([s("cloud/dev")])).toEqual({});
  });
});

describe("plywood init --engine plunge", () => {
  it("gives file:// stacks a plunge+ URL in plywood.yml, leaves Pulumi.yaml alone, and chant reads engine plunge", async () => {
    setChantProductForTests(undefined);
    const adopt = fakeAdopt(wouldAdopt);
    setChantAdoptForTests(adopt);
    const root = repo(ON_FILE);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(r.ok).toBe(true);
    const yml = readFileSync(join(root, "plywood.yml"), "utf8");
    const doc = parseConfig(yml);
    expect(doc.doc).toMatchObject({ engine: "plunge", backend: "plunge+file:///srv/state" });
    expect(checkConfig(doc).filter((p) => p.severity === "error")).toEqual([]);
    expect(engineOf(doc.doc)).toMatchObject({ engine: "plunge" });
    expect(readFileSync(join(root, "infra/Pulumi.yaml"), "utf8")).toBe(ON_FILE["infra/Pulumi.yaml"]);
    expect(adopt.calls.map((c) => [c.stack, c.backend])).toEqual([
      ["dev", "plunge+file:///srv/state"],
      ["prod", "plunge+file:///srv/state"],
    ]);
    expect(adopt.calls[0]!.dir).toBe(join(root, "infra"));
    const text = initLines(r).join("\n");
    expect(text).toContain("shop/dev: would adopt 2 resources (marker 1, record 1)");
    expect(r.adopt.map((p) => p.view?.status)).toEqual(["would-adopt", "would-adopt"]);
  });

  it("gives a floci S3 stack its plunge+ URL and checks the bucket, printing the lifecycle fix", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(fakeAdopt(wouldAdopt));
    const report: BucketReport = {
      store: "s3",
      bucket: "state",
      namespaces: ["shop/.pulumi"],
      correct: false,
      settings: [{ setting: "lifecycle", verdict: "fail", found: "no rule expires noncurrent versions", unwaivable: false, fix: "aws s3api put-bucket-lifecycle-configuration --bucket state" }],
    };
    const asked: Array<Record<string, unknown>> = [];
    setBucketCheckForTests({ checkBucket: async (t) => (asked.push(t), report) });
    const root = repo(ON_FLOCI);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root, FLOCI_ENV));
    expect(parseConfig(readFileSync(join(root, "plywood.yml"), "utf8")).doc).toMatchObject({ engine: "plunge", backend: `plunge+${FLOCI}` });
    expect(asked[0]).toMatchObject({ store: "s3", bucket: "state", endpoint: "http://localhost:4566" });
    expect(initLines(r).join("\n")).toContain("aws s3api put-bucket-lifecycle-configuration --bucket state");
    expect(r.exitCode).toBe(FALLBACK_EXIT.done);
  });

  it("writes the adopt Op for the stacks not adopted yet, with each stack's backend", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(fakeAdopt((stack) => (stack === "prod" ? { ...wouldAdopt(stack), status: "already-adopted" } : wouldAdopt(stack))));
    const root = repo(ON_FILE);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(r.files.find((f) => f.file === ADOPT_OP_FILE)).toMatchObject({ status: "written" });
    const op = readFileSync(join(root, ADOPT_OP_FILE), "utf8");
    expect(op).toBe(adoptOpFile([{ member: "shop", dir: "infra", stack: "dev", url: "plunge+file:///srv/state" }]));
    expect(op).toContain('import { PulumiAdoptOp } from "@intentius/chant-lexicon-pulumi";');
    expect(r.todo.join("\n")).toContain(adoptGate("shop", "dev", true));
    expect(r.todo.join("\n")).not.toContain("npm i -D");
  });

  it("leaves a refused stack out of the adopt Op and names plunge's refusals", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(
      fakeAdopt((stack) =>
        stack === "dev"
          ? { ...wouldAdopt(stack), status: "refused", refusals: [{ code: "foreign-records", reason: "the stack already has plunge records" }] }
          : wouldAdopt(stack),
      ),
    );
    const root = repo(ON_FILE);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(readFileSync(join(root, ADOPT_OP_FILE), "utf8")).toBe(adoptOpFile([{ member: "shop", dir: "infra", stack: "prod", url: "plunge+file:///srv/state" }]));
    const text = initLines(r).join("\n");
    expect(text).toContain("shop/dev: plunge refuses to adopt it, so the adopt Op leaves it out:");
    expect(text).toContain("foreign-records: the stack already has plunge records");
    expect(r.todo.join("\n")).toContain(adoptGate("shop", "prod", true));
  });

  it("writes no adopt Op when every stack is refused or adopted", () => {
    const stacks = [{ key: "a/dev" }, { key: "a/prod" }, { key: "a/qa" }];
    const view = (status: string) => ({ ...wouldAdopt("x"), status }) as AdoptPreview["view"];
    expect(
      stacksToAdopt(stacks, [
        { key: "a/dev", backend: "b", command: "x", view: view("refused") },
        { key: "a/prod", backend: "b", command: "y", view: view("already-adopted") },
        { key: "a/qa", backend: "b", command: "z", error: "not run" },
      ]),
    ).toEqual([{ key: "a/qa" }]);
  });

  it("a second run writes nothing", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(fakeAdopt(wouldAdopt));
    const root = repo(ON_FILE);
    await runInit(OPTS, FALLBACK_EXIT, io(root));
    const again = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(again.files.filter((f) => f.status === "written")).toEqual([]);
  });

  it("prints a refused preview and still exits 0", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(
      fakeAdopt((stack) => ({ ...wouldAdopt(stack), status: "refused", refusals: [{ code: "pending-operations", reason: "the checkpoint has 1 pending operation" }] })),
    );
    const root = repo(ON_FILE);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(initLines(r).join("\n")).toContain("pending-operations: the checkpoint has 1 pending operation");
    expect(r.exitCode).toBe(FALLBACK_EXIT.done);
  });

  it("names the command when plunge is not on PATH", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(fakeAdopt(() => new Error("the plunge binary was not found on PATH")));
    const root = repo(ON_FILE);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    const text = initLines(r).join("\n");
    expect(text).toContain("not previewed; the plunge binary was not found on PATH");
    expect(text).toContain(adoptCommand({ dir: "infra", stack: "dev" }, "plunge+file:///srv/state"));
  });

  it("on a lexicon without adopt support, prints each preview command and skips the Op", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(undefined);
    const root = repo(ON_FILE);
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(r.notes.join("\n")).toContain("chant#4562");
    expect(r.notes.join("\n")).toContain("plunge stack adopt --json --stack dev");
    expect(r.files.find((f) => f.file === ADOPT_OP_FILE)).toMatchObject({ status: "skipped" });
  });

  it("points a Pulumi Cloud stack at the move guide and writes no engine", async () => {
    setChantProductForTests(undefined);
    const adopt = fakeAdopt(wouldAdopt);
    setChantAdoptForTests(adopt);
    const root = repo({ "infra/Pulumi.yaml": "name: shop\nruntime: nodejs\n", "infra/Pulumi.dev.yaml": "" });
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    const doc = parseConfig(readFileSync(join(root, "plywood.yml"), "utf8")).doc;
    expect(doc.engine).toBeUndefined();
    expect(doc.backend).toBeUndefined();
    expect(r.notes.join("\n")).toContain(MOVE_A_STACK_GUIDE);
    expect(adopt.calls).toEqual([]);
  });

  it("with a kept plywood.yml, names the keys to set and changes nothing", async () => {
    setChantProductForTests(undefined);
    setChantAdoptForTests(fakeAdopt(wouldAdopt));
    const root = repo({ ...ON_FILE, "plywood.yml": "gate: always\n" });
    const r = await runInit(OPTS, FALLBACK_EXIT, io(root));
    expect(readFileSync(join(root, "plywood.yml"), "utf8")).toBe("gate: always\n");
    expect(r.notes.join("\n")).toContain("backend: plunge+file:///srv/state");
  });

  it("adopt lines cover each status", () => {
    const chant = fakeAdopt(wouldAdopt);
    const lines = adoptLines(
      [
        { key: "a/dev", backend: "plunge+file:///a", command: "x", view: { ...wouldAdopt("dev"), status: "already-adopted" } },
        { key: "a/prod", backend: "plunge+file:///a", command: "y", error: "boom" },
      ],
      chant,
    );
    expect(lines).toEqual([
      "Adopt previews (plunge stack adopt --json, which writes nothing):",
      "  a/dev: already on plunge's records (2 resources)",
      "  a/prod: not previewed; boom. Run it by hand: y",
    ]);
  });
});
