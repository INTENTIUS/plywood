import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main, type Io } from "../src/cli";
import { needsChantMessage, setChantProductForTests, type ChantProduct, type ProductPipelineOptions } from "../src/chant-product";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { check, ci, pipelineShape, preview, type StageIo } from "../src/stages";
import { TIPS } from "../src/tips";
import { PRODUCT_WORDS, wordsForJobs } from "../src/words";

/** A fake chant: records each in-process call and answers with `code`. */
function fakeChant(code = 0) {
  const calls: Array<{ argv: string[]; words: unknown }> = [];
  const pipelines: Array<{ forge: string; env: string; options: ProductPipelineOptions }> = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: (forge, env, options) => {
      pipelines.push({ forge, env, options });
      const words = options.words as typeof PRODUCT_WORDS;
      return {
        words: { ...words, stages: { ...words.stages } },
        plan: { jobName: "plan", command: "npx --no-install plywood components pr-plan --gate up" },
        post: { command: "npx --no-install plywood components pr-post" },
        record: { jobName: "record", command: "npx --no-install plywood components pr-record" },
        comments: Object.fromEntries(Object.entries(words.commands).map(([typed, c]) => [c, `/plywood ${typed}`])),
      };
    },
    approveLine: () => "plywood approve up --plan sha256:x --sign",
    runChantInProcess: async (argv, words) => {
      calls.push({ argv, words });
      // The generator writes the file it is given, as chant's build does.
      const out = argv.indexOf("--output");
      if (code === 0 && argv[0] === "build" && out >= 0) {
        mkdirSync(dirname(argv[out + 1]!), { recursive: true });
        writeFileSync(argv[out + 1]!, "jobs:\n  plan:\n    steps:\n      - run: npx --no-install plywood components pr-plan\n");
      }
      return code;
    },
  };
  return { api, calls, pipelines };
}

function io(cwd: string, env: NodeJS.ProcessEnv = {}): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

/** A repository with plywood.yml holding `yml`. */
function repo(yml = "stacks:\n  shop/dev: {}\n  shop/prod: {}\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-stages-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  return dir;
}

afterEach(() => setChantProductForTests("reset"));

describe("words", () => {
  it("are chant#4550's plywood words, verbatim", () => {
    expect(PRODUCT_WORDS).toMatchObject({
      product: "plywood",
      stages: { plan: "preview", apply: "up" },
      op: "pulumi-up",
      prGate: "up",
      gateName: "wave-{k}",
      approval: "pull-request",
      bin: "npx --no-install plywood",
    });
  });

  it("leave out a comment command with no job", () => {
    expect(wordsForJobs(["plan"]).commands).toEqual({ preview: "plan" });
    expect(wordsForJobs(["plan", "apply", "lock", "unlock"]).commands).toEqual(PRODUCT_WORDS.commands);
  });
});

describe("feature-detect", () => {
  it("names the chant it needs when chant has no product pipeline", async () => {
    setChantProductForTests(undefined);
    const o = io(repo());
    expect(await preview(["--base", "main", "--pr", "3"], false, FALLBACK_EXIT, o)).toBe(FALLBACK_EXIT.failed);
    expect(o.stderr.join("\n")).toContain(needsChantMessage("plywood preview"));
    expect(o.stderr.join("\n")).toContain("chant >= the release after 0.124.54");
  });
});

describe("plywood preview", () => {
  it("runs chant's pr-plan with plywood's words and gate", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await preview(["--base", "abc", "--pr", "7", "--forge", "forgejo"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls).toEqual([
      { argv: ["components", "pr-plan", "--base", "abc", "--pr", "7", "--gate", "up", "--forge", "forgejo"], words: PRODUCT_WORDS },
    ]);
  });

  it("narrows to one stack, positional or --stack", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    await preview(["dev", "--base", "abc", "--pr", "7"], false, FALLBACK_EXIT, io(repo()));
    await preview(["--stack", "dev", "--base", "abc", "--pr", "7"], false, FALLBACK_EXIT, io(repo()));
    for (const c of chant.calls) expect(c.argv.slice(c.argv.indexOf("--member"), c.argv.indexOf("--member") + 2)).toEqual(["--member", "dev"]);
  });

  it("reads BASE_SHA and PR_NUMBER as a generated job sets them", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    await preview([], false, FALLBACK_EXIT, io(repo(), { BASE_SHA: "b", PR_NUMBER: "9" }));
    expect(chant.calls[0]!.argv).toEqual(["components", "pr-plan", "--base", "b", "--pr", "9", "--gate", "up"]);
  });

  it("passes chant's exit code through: a CrossGuard denial is 7", async () => {
    setChantProductForTests(fakeChant(7).api);
    expect(await preview(["--base", "a", "--pr", "1"], false, FALLBACK_EXIT, io(repo()))).toBe(7);
  });

  it("refuses --target until chant's pr-plan passes it on", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await preview(["--base", "a", "--pr", "1", "--target", "urn:x"], false, FALLBACK_EXIT, o)).toBe(1);
    expect(chant.calls).toEqual([]);
    expect(o.stderr.join("\n")).toContain("chant#4620");
  });

  it("passes each --target to pr-plan on a chant with chant#4620, beside a named stack (plywood#28)", async () => {
    const chant = fakeChant();
    setChantProductForTests({ ...chant.api, prCommentPreviewJob: () => undefined, PR_PREVIEW_FLOOR: "0.124.55" });
    const urn = "urn:pulumi:prod::shop::aws:sqs/queue:Queue::events";
    expect(await preview(["shop/prod", "--base", "a", "--pr", "1", "--target", urn, "--target", "urn:y"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    const argv = chant.calls[0]!.argv;
    expect(argv).toEqual(expect.arrayContaining(["--member", "shop/prod", "--target", urn, "--target", "urn:y"]));
    expect(argv.filter((a) => a === "shop/prod")).toHaveLength(1);
  });

  it("still refuses --refresh, and a --target with no value", async () => {
    setChantProductForTests({ ...fakeChant().api, prCommentPreviewJob: () => undefined, PR_PREVIEW_FLOOR: "0.124.55" });
    expect(await preview(["--base", "a", "--pr", "1", "--refresh"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
    expect(await preview(["--base", "a", "--pr", "1", "--target"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
  });

  it("needs a base and a pull request", async () => {
    setChantProductForTests(fakeChant().api);
    expect(await preview(["--pr", "1"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
    expect(await preview(["--base", "a"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
  });
});

describe("plywood check", () => {
  it("checks plywood.yml, then runs chant's check stage at base", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await check(["--base", "abc", "shop/dev"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls).toEqual([{ argv: ["ci", "check", "--base", "abc", "shop/dev"], words: PRODUCT_WORDS }]);
  });

  it("fails with chant's code when a user hook fails", async () => {
    setChantProductForTests(fakeChant(1).api);
    expect(await check(["--base", "abc"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
  });

  it("stops at a bad plywood.yml before any hook runs", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await check(["--base", "abc"], false, FALLBACK_EXIT, io(repo("ci:\n  workflow: x\n")))).toBe(1);
    expect(chant.calls).toEqual([]);
  });
});

describe("plywood ci", () => {
  it("has a preview job, and lock jobs when locks are taken at preview", () => {
    expect(pipelineShape({}, "github", undefined)).toEqual({ jobs: ["plan", "lock", "unlock"], applyBeforeMerge: false, waves: false, locks: "plan" });
    expect(pipelineShape({}, "gitlab", undefined)).toEqual({ jobs: ["plan"], applyBeforeMerge: false, waves: false });
    expect(pipelineShape({ apply: { when: "pull-request" } }, "github", undefined).jobs).toContain("apply");
    expect(pipelineShape({ locks: { when: "up" } }, "github", {}).jobs).toEqual(["plan", "apply"]);
  });

  it("checks the words against productPipelineJobs, then has chant's generator write the file", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const dir = repo();
    expect(await ci(["--forge", "forgejo"], false, FALLBACK_EXIT, io(dir))).toBe(0);
    expect(chant.pipelines).toHaveLength(1);
    expect(chant.pipelines[0]!.options).toMatchObject({ locks: "plan", words: { commands: { preview: "plan", lock: "lock", unlock: "unlock" } } });
    expect(chant.calls[0]!.argv).toEqual([
      "build", ".", "--components", "--generate", "forgejo", "--pr-loop", "--env", "production", "--gate", "up",
      "--output", join(dir, ".forgejo/workflows/plywood.yml"),
    ]);
  });

  it("asks for the /plywood preview comment's jobs on a chant with chant#4620 (plywood#28), and not before", async () => {
    const chant = fakeChant();
    setChantProductForTests({ ...chant.api, prCommentPreviewJob: () => undefined, PR_PREVIEW_FLOOR: "0.124.55" });
    const dir = repo();
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, io(dir))).toBe(0);
    expect(chant.pipelines[0]!.options.previewComment).toBe(true);
    expect(chant.calls[0]!.argv).toContain("--preview-comment");
    const old = fakeChant();
    setChantProductForTests(old.api);
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(old.pipelines[0]!.options.previewComment).toBeUndefined();
    expect(old.calls[0]!.argv).not.toContain("--preview-comment");
  });

  it("writes nothing with --dry-run", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await ci(["--dry-run"], true, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.calls).toEqual([]);
    expect(JSON.parse(o.stdout[0]!)).toMatchObject({ command: "ci", forge: "github", comments: { plan: "/plywood preview" } });
  });
});

describe("the bin", () => {
  it("passes chant's verbs a generated job runs to chant with plywood's words", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const c: Io = { out: () => {}, err: () => {} };
    await main(["components", "pr-post", "--pr", "1"], c);
    await main(["ci", "run", "plan", "--in-place"], c);
    expect(chant.calls.map((x) => x.argv)).toEqual([
      ["components", "pr-post", "--pr", "1"],
      ["ci", "run", "plan", "--in-place"],
    ]);
    for (const x of chant.calls) expect(x.words).toBe(PRODUCT_WORDS);
  });

  it("prints the tips", async () => {
    const out: string[] = [];
    expect(await main(["tips"], { out: (s) => out.push(s), err: () => {} })).toBe(0);
    for (const t of TIPS) expect(out.join("\n")).toContain(t.id);
    expect(await main(["tips", "nope"], { out: () => {}, err: () => {} })).toBe(1);
  });
});
