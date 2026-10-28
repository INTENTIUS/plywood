import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { needsChantMessage, setChantProductForTests, type ChantProduct, type PendingGateByPlan } from "../src/chant-product";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { refusalLine, refusalOf, REFUSALS } from "../src/refusals";
import { ci, type StageIo } from "../src/stages";
import { approvalStatusTarget, approve, approveTarget, carryArgv, override, readUpSpec, resume, up, upTargetByPlan, WAVES_SPEC_FILE } from "../src/up";
import { parseConfig } from "../src/config/index";
import { binLines, withBinLines } from "../src/waves-workflow";
import { PRODUCT_WORDS } from "../src/words";

/** A fake chant: records each in-process call and answers from `codes` in turn (then 0). */
function fakeChant(codes: number[] = [], onCall?: (argv: string[]) => void) {
  const calls: Array<{ argv: string[]; words: unknown }> = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: (_forge, _env, options) => {
      const words = options.words as typeof PRODUCT_WORDS;
      const spec = options.waves as { waves: Array<{ name: string }> } | undefined;
      return {
        words: { ...words, stages: { ...words.stages } },
        plan: { jobName: "plan", command: "npx --no-install plywood components pr-plan --gate up" },
        post: { command: "npx --no-install plywood components pr-post" },
        comments: Object.fromEntries(Object.entries(words.commands).map(([typed, c]) => [c, `/plywood ${typed}`])),
        ...(spec
          ? {
              waves: {
                spec: { ...spec, name: "pulumi-up", gateName: "wave-{k}", approvals: { pullRequest: { gate: "up" } } },
                specFile: WAVES_SPEC_FILE,
                jobs: spec.waves.map((_, i) => ({ command: ["npx", "--no-install", "plywood", "run", "wave", "--spec", WAVES_SPEC_FILE, "--wave", String(i + 1)] })),
              },
            }
          : {}),
      };
    },
    approveLine: () => "plywood approve up --plan sha256:x --sign",
    runChantInProcess: async (argv, words) => {
      calls.push({ argv, words });
      writeBuildOutput(argv);
      onCall?.(argv);
      return codes.shift() ?? 0;
    },
  };
  return { api, calls };
}

/** chant build writes its --output file; plywood ci fails when none comes out. */
function writeBuildOutput(argv: string[]): void {
  const i = argv.indexOf("--output");
  if (argv[0] !== "build" || i < 0) return;
  mkdirSync(dirname(argv[i + 1]!), { recursive: true });
  writeFileSync(argv[i + 1]!, "jobs: {}\n");
}

function io(cwd: string, env: NodeJS.ProcessEnv = {}): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

const SPEC = {
  name: "pulumi-up",
  op: "pulumi-up",
  gate: "up",
  step: { kind: "pulumi-up" },
  waves: [{ name: "dev", runs: [{ target: "shop/dev" }] }, { name: "prod", runs: [{ target: "shop/prod" }] }],
};

/** A repository with plywood.yml holding `yml` and, unless `spec` is null, the waves spec. */
function repo(yml = "stacks:\n  shop/dev: {}\n  shop/prod: {}\n", spec: unknown = SPEC): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-up-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  if (spec !== null) {
    mkdirSync(join(dir, ".chant/op-waves"), { recursive: true });
    writeFileSync(join(dir, WAVES_SPEC_FILE), JSON.stringify(spec));
  }
  return dir;
}

afterEach(() => setChantProductForTests("reset"));

describe("plywood approve", () => {
  it("records the pull request's up gate under op pr-<n>", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await approve(["up", "--pr", "12", "--plan", "sha256:abc", "--sign"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["approve", "pr-12", "up", "--plan", "sha256:abc", "--sign"]);
    expect(chant.calls[0]!.words).toBe(PRODUCT_WORDS);
  });

  it("reads PR_NUMBER, and takes pr-<n> or one stack's op", () => {
    expect(approveTarget("up", { pr: "7" })).toEqual({ op: "pr-7", gate: "up" });
    expect(approveTarget("up", { pr: "7", stack: "shop-dev" })).toEqual({ op: "pr-7-shop-dev", gate: "up" });
    expect(approveTarget("pr-12", {})).toEqual({ op: "pr-12", gate: "up" });
    expect(approveTarget("up", {})).toHaveProperty("error");
  });

  it("records a wave gate under op pulumi-up", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await approve(["wave-2", "--plan", "sha256:def"], false, FALLBACK_EXIT, io(repo(), { PR_NUMBER: "3" }))).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["approve", "pulumi-up", "wave-2", "--plan", "sha256:def"]);
  });

  it("passes --yes and --json, so chant's terminal confirmation (chant#4575) is skipped only when asked", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    await approve(["wave-1", "--plan", "sha256:x"], false, FALLBACK_EXIT, io(repo()));
    await approve(["wave-1", "--plan", "sha256:x", "--yes"], true, FALLBACK_EXIT, io(repo()));
    expect(chant.calls[0]!.argv).not.toContain("--yes");
    expect(chant.calls[1]!.argv).toEqual(["approve", "pulumi-up", "wave-1", "--plan", "sha256:x", "--yes", "--json"]);
  });

  it("needs --plan, so a moved preview is never approved in its place", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await approve(["wave-1"], false, FALLBACK_EXIT, o)).toBe(1);
    expect(o.stderr.join("\n")).toContain("--plan <digest>");
    expect(chant.calls).toEqual([]);
  });

  it("names the chant it needs on the published pin", async () => {
    setChantProductForTests(undefined);
    const o = io(repo());
    expect(await approve(["wave-1", "--plan", "sha256:x"], false, FALLBACK_EXIT, o)).toBe(1);
    expect(o.stderr.join("\n")).toContain(needsChantMessage("plywood approve"));
  });
});

/** The waves spec productWavesSpec writes for plywood: each wave takes the pull request's approval at up (chant#4550, ruling B). */
const PR_SPEC = { ...SPEC, approvals: { pullRequest: { gate: "up" } }, waves: SPEC.waves.map((w) => ({ ...w, approval: "pull-request" })) };

describe("plywood approve up on waves that take the pull request's approval (chant#4630 trace)", () => {
  // The merged pull-request wave reads approvals at up under the spec's op, pulumi-up
  // (chant op-waves-run.ts approveByPullRequest), and nothing in chant carries one from pr-<n>.
  it("records the approval under pr-<n> and again under pulumi-up, where the merged waves read it", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo(undefined, PR_SPEC));
    expect(await approve(["up", "--pr", "12", "--plan", "sha256:abc", "--sign"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.calls.map((c) => c.argv)).toEqual([
      ["approve", "pr-12", "up", "--plan", "sha256:abc", "--sign"],
      ["approve", "pulumi-up", "up", "--plan", "sha256:abc", "--sign", "--yes"],
    ]);
    expect(o.stderr.join("\n")).toContain("recorded the same approval under pulumi-up");
  });

  it("carries one stack's approval too, and never a wave gate, an expiry or a spec without pull-request waves", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    await approve(["up", "--pr", "12", "--stack", "shop-dev", "--plan", "sha256:abc", "--yes", "--resume"], false, FALLBACK_EXIT, io(repo(undefined, PR_SPEC)));
    expect(chant.calls.map((c) => c.argv)).toEqual([
      ["approve", "pr-12-shop-dev", "up", "--plan", "sha256:abc", "--yes", "--resume"],
      ["approve", "pulumi-up", "up", "--plan", "sha256:abc", "--yes"],
    ]);
    chant.calls.length = 0;
    await approve(["wave-1", "--plan", "sha256:abc"], false, FALLBACK_EXIT, io(repo(undefined, PR_SPEC)));
    await approve(["up", "--pr", "12", "--expire"], false, FALLBACK_EXIT, io(repo(undefined, PR_SPEC)));
    await approve(["up", "--pr", "12", "--plan", "sha256:abc"], false, FALLBACK_EXIT, io(repo()));
    expect(chant.calls.map((c) => c.argv[1])).toEqual(["pulumi-up", "pr-12", "pr-12"]);
  });

  it("carries nothing when chant refused the approval, and says so when the carry fails", async () => {
    const refused = fakeChant([3]);
    setChantProductForTests(refused.api);
    expect(await approve(["up", "--pr", "12", "--plan", "sha256:abc"], false, FALLBACK_EXIT, io(repo(undefined, PR_SPEC)))).toBe(3);
    expect(refused.calls).toHaveLength(1);
    const failing = fakeChant([0, 1]);
    setChantProductForTests(failing.api);
    const o = io(repo(undefined, PR_SPEC));
    expect(await approve(["up", "--pr", "12", "--plan", "sha256:abc"], false, FALLBACK_EXIT, o)).toBe(1);
    expect(o.stderr.join("\n")).toContain("plywood approve up --op pulumi-up --plan sha256:abc --yes");
  });

  it("keeps the line to run by hand as an approval of pulumi-up's up gate", () => {
    expect(approveTarget("up", { op: "pulumi-up" })).toEqual({ op: "pulumi-up", gate: "up" });
    expect(carryArgv(["--plan", "d", "--yes"])).toEqual(["approve", "pulumi-up", "up", "--plan", "d", "--yes"]);
  });
});

describe("plywood approve posts plywood/approval again (chant#4630 ruling)", () => {
  const withFloor = (codes: number[] = []) => {
    const chant = fakeChant(codes);
    setChantProductForTests({ ...chant.api, APPROVAL_STATUS_FLOOR: "0.124.56", APPROVAL_STATUS_PULL_REQUEST_FLOOR: "0.124.56" });
    return chant;
  };
  const refresh = (branch: string, forge: string) => ["run", "wave", "--spec", WAVES_SPEC_FILE, "--approval-status", "--open", "--branch", branch, "--forge", forge];

  it("runs run wave --approval-status --open after it records, with the CI job's forge and target branch", async () => {
    const chant = withFloor();
    const o = io(repo(undefined, PR_SPEC), { GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" });
    expect(await approve(["up", "--pr", "12", "--plan", "sha256:abc"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.calls.map((c) => c.argv)[2]).toEqual(refresh("main", "github"));
    expect(o.stderr.join("\n")).toContain("posted plywood/approval again");
  });

  it("takes --forge and --branch over plywood.yml and the job", async () => {
    const chant = withFloor();
    const dir = repo("stacks:\n  shop/dev: {}\nforge:\n  kind: gitlab\n", PR_SPEC);
    await approve(["up", "--pr", "12", "--plan", "sha256:abc", "--forge", "forgejo", "--branch", "trunk"], false, FALLBACK_EXIT, io(dir, { GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" }));
    expect(chant.calls.at(-1)!.argv).toEqual(refresh("trunk", "forgejo"));
    expect(approvalStatusTarget({}, parseConfig("forge:\n  kind: gitlab\n").doc, { CI_DEFAULT_BRANCH: "main" })).toEqual({ forge: "gitlab", branch: "main" });
    expect(approvalStatusTarget({}, undefined, {})).toEqual({});
  });

  it("prints the line to run when the forge or branch is unknown, and a failed post keeps the approval's exit", async () => {
    const chant = withFloor();
    const o = io(repo(undefined, PR_SPEC));
    expect(await approve(["up", "--pr", "12", "--plan", "sha256:abc"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.calls).toHaveLength(2);
    expect(o.stderr.join("\n")).toContain("--approval-status --open --branch <target branch> --forge <forge>");
    const failing = withFloor([0, 0, 1]);
    const f = io(repo(undefined, PR_SPEC), { GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" });
    expect(await approve(["up", "--pr", "12", "--plan", "sha256:abc"], false, FALLBACK_EXIT, f)).toBe(0);
    expect(failing.calls).toHaveLength(3);
    expect(f.stderr.join("\n")).toContain("was not posted again (exit 1)");
  });

  it("posts nothing on a chant without the pull-request floor, or for a wave gate", async () => {
    const chant = fakeChant();
    setChantProductForTests({ ...chant.api, APPROVAL_STATUS_FLOOR: "0.124.56" });
    await approve(["up", "--pr", "12", "--plan", "sha256:abc"], false, FALLBACK_EXIT, io(repo(undefined, PR_SPEC), { GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" }));
    expect(chant.calls.map((c) => c.argv[0])).toEqual(["approve", "approve"]);
    const floored = withFloor();
    await approve(["wave-1", "--plan", "sha256:abc"], false, FALLBACK_EXIT, io(repo(undefined, PR_SPEC), { GITHUB_ACTIONS: "true", GITHUB_BASE_REF: "main" }));
    expect(floored.calls).toHaveLength(1);
  });
});

describe("plywood override", () => {
  it("is chant's policy-override approval with each rule and the reason", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const args = ["shop/prod", "--rule", "no-public-bucket", "--rule", "tags", "--reason", "launch day", "--sign"];
    expect(await override(args, false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["approve", "policy-override", "shop/prod", "--rule", "no-public-bucket", "--rule", "tags", "--reason", "launch day", "--sign"]);
  });

  it("needs a rule and a reason", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await override(["shop/prod", "--reason", "x"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
    expect(await override(["shop/prod", "--rule", "tags"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
    expect(chant.calls).toEqual([]);
  });
});

describe("plywood up", () => {
  it("runs each wave's chant run wave in order", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await up([], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls.map((c) => c.argv)).toEqual([
      ["run", "wave", "--spec", WAVES_SPEC_FILE, "--wave", "1"],
      ["run", "wave", "--spec", WAVES_SPEC_FILE, "--wave", "2"],
    ]);
  });

  it("stops at a wave that waits, and names the approve that clears it", async () => {
    const chant = fakeChant([FALLBACK_EXIT.waiting]);
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await up([], false, FALLBACK_EXIT, o)).toBe(FALLBACK_EXIT.waiting);
    expect(chant.calls).toHaveLength(1);
    expect(o.stderr.join("\n")).toContain("plywood approve wave-1 --plan <digest>");
  });

  it("runs one wave's job as a generated job does", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await up(["--wave", "2", "--share", "1", "--base", "HEAD^1"], true, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["run", "wave", "--spec", WAVES_SPEC_FILE, "--wave", "2", "--base", "HEAD^1", "--share", "1", "--json"]);
  });

  it("refuses a spec that does not apply through the pulumi-up step", () => {
    const dir = repo(undefined, { ...SPEC, step: { kind: "terraform-apply" } });
    expect(readUpSpec(dir)).toHaveProperty("error");
    expect(readUpSpec(repo(undefined, null))).toHaveProperty("error");
    expect(readUpSpec(repo())).toMatchObject({ step: { kind: "pulumi-up" } });
  });

  it("passes chant's code through: a held lock is 5", async () => {
    const chant = fakeChant([FALLBACK_EXIT.held]);
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await up(["--wave", "1"], false, FALLBACK_EXIT, o)).toBe(FALLBACK_EXIT.held);
    expect(o.stderr.join("\n")).toContain("/plywood unlock");
  });
});

describe("/plywood up before merge", () => {
  it("works only under apply.when: pull-request", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo(), { BASE_SHA: "abc" });
    expect(await up(["--pr", "4"], false, FALLBACK_EXIT, o)).toBe(1);
    expect(o.stderr.join("\n")).toContain("apply.when: pull-request");
    expect(chant.calls).toEqual([]);
  });

  it("runs chant's pr-apply --before-merge on the up gate", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const dir = repo("stacks:\n  shop/dev: {}\napply:\n  when: pull-request\nforge:\n  kind: forgejo\n");
    expect(await up(["--pr", "4"], false, FALLBACK_EXIT, io(dir, { BASE_SHA: "abc" }))).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["components", "pr-apply", "--before-merge", "--base", "abc", "--pr", "4", "--env", "production", "--gate", "up", "--forge", "forgejo"]);
  });
});

describe("refusals", () => {
  it("has a line for each refused exit code with the command that clears it", () => {
    for (const r of REFUSALS) expect(refusalOf(FALLBACK_EXIT[r], FALLBACK_EXIT)).toBe(r);
    expect(refusalOf(FALLBACK_EXIT.done, FALLBACK_EXIT)).toBeUndefined();
    expect(refusalLine("moved")).toContain("plywood approve up --plan <digest>");
    expect(refusalLine("denied")).toContain("plywood override <stack> --rule <id> --reason <text>");
    expect(refusalOf(9, FALLBACK_EXIT)).toBe("misplaced");
    expect(refusalLine("misplaced")).toContain("plywood ci");
  });

  it("passes a refused job guard's 9 through unchanged (chant#4624)", async () => {
    const chant = fakeChant([9]);
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await up(["--wave", "1"], false, FALLBACK_EXIT, o)).toBe(9);
    expect(o.stderr.join("\n")).toContain("chant's job guard");
  });
});

describe("wave jobs in the generated workflow", () => {
  it("puts plywood's bin in each chant run wave line", () => {
    const lines = binLines({ jobs: [{ command: ["npx", "--no-install", "plywood", "run", "wave", "--spec", "s.json", "--wave", "1"] }] }, PRODUCT_WORDS.bin);
    expect(lines).toEqual([{ chant: "chant run wave --spec s.json --wave 1", product: "npx --no-install plywood run wave --spec s.json --wave 1" }]);
    expect(withBinLines("      - run: chant run wave --spec s.json --wave 1\n", lines)).toBe("      - run: npx --no-install plywood run wave --spec s.json --wave 1\n");
  });

  it("writes the spec with plywood's names and has chant generate one job per wave", async () => {
    const dir = repo();
    const chant = fakeChant([], (argv) => {
      if (argv[0] !== "run") return;
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github/workflows/pulumi-up.yml"),
        `# generated. Regenerate with: chant run --generate github --spec ${WAVES_SPEC_FILE}\njobs:\n  a:\n    steps:\n      - run: chant run wave --spec ${WAVES_SPEC_FILE} --wave 1\n  b:\n    steps:\n      - run: chant run wave --spec ${WAVES_SPEC_FILE} --wave 2\n`,
      );
    });
    setChantProductForTests(chant.api);
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, io(dir))).toBe(0);
    expect(chant.calls.map((c) => c.argv[0])).toEqual(["build", "run"]);
    expect(chant.calls[1]!.argv).toEqual(["run", "--generate", "github", "--spec", WAVES_SPEC_FILE, "--output", ".github/workflows"]);
    // The pull request workflow has no /plywood up job when the waves update on merge.
    expect((chant.calls[0]!.words as typeof PRODUCT_WORDS).commands).not.toHaveProperty("up");
    const workflow = readFileSync(join(dir, ".github/workflows/pulumi-up.yml"), "utf8");
    expect(workflow).toContain("run: npx --no-install plywood run wave --spec");
    expect(workflow).not.toContain("run: chant run wave");
    expect(JSON.parse(readFileSync(join(dir, WAVES_SPEC_FILE), "utf8"))).toMatchObject({ approvals: { pullRequest: { gate: "up" } } });
  });
});

/** fakeChant with chant#4607's ci-product functions: pending gates from `pending`, and chant's --requires check. */
function chant4607(pending: PendingGateByPlan[] = [], codes: number[] = [], onCall?: (argv: string[]) => void) {
  const base = fakeChant(codes, onCall);
  const reads: Array<{ digest: string; options: unknown }> = [];
  const order = ["approved", "mergeable", "undiverged", "checks"];
  base.api.pendingGatesByPlan = async (digest, options) => {
    reads.push({ digest, options });
    return pending;
  };
  base.api.parseRequiresList = (values) => ({ checks: order.filter((n) => values.flatMap((v) => v.split(",")).includes(n)) });
  return { ...base, reads };
}

const gate = (op: string, pr: number, member?: string): PendingGateByPlan => ({ op, gate: "up", pr, ...(member ? { member } : {}), matched: "planDigest", timestamp: "2026-10-27T10:00:00Z" });

describe("plywood approve up without --pr (plywood#26, chant#4607)", () => {
  it("finds the pull request from the digest and approves its op", async () => {
    const chant = chant4607([gate("pr-12", 12)]);
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await approve(["up", "--plan", "sha256:abc"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(chant.reads[0]).toMatchObject({ digest: "sha256:abc", options: { pullRequestsOnly: true } });
    expect(chant.calls[0]!.argv).toEqual(["approve", "pr-12", "up", "--plan", "sha256:abc"]);
    expect(o.stderr.join("\n")).toContain("pull request 12");
  });

  it("takes one stack's op with --stack, and asks for the stack when several wait", async () => {
    const pending = [gate("pr-12-shop-dev", 12, "shop-dev"), gate("pr-12-shop-prod", 12, "shop-prod")];
    expect(await upTargetByPlan(chant4607(pending).api, "sha256:abc", { stack: "shop-prod" })).toEqual({ op: "pr-12-shop-prod", pr: 12 });
    expect(await upTargetByPlan(chant4607(pending).api, "sha256:abc")).toMatchObject({ error: expect.stringContaining("--stack") });
  });

  it("refuses a digest no gate waits on, or one two pull requests wait on", async () => {
    expect(await upTargetByPlan(chant4607([]).api, "sha256:abc")).toMatchObject({ error: expect.stringContaining("no pull request's up gate waits on sha256:abc") });
    expect(await upTargetByPlan(chant4607([gate("pr-3", 3), gate("pr-4", 4)]).api, "sha256:abc")).toMatchObject({ error: expect.stringContaining("pull requests 3, 4") });
  });

  it("keeps --pr required on a chant before chant#4607", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await approve(["up", "--plan", "sha256:abc"], false, FALLBACK_EXIT, o)).toBe(1);
    expect(o.stderr.join("\n")).toContain("--pr <n>");
    expect(chant.calls).toEqual([]);
  });

  it("does not read the ledger when --pr or PR_NUMBER names the pull request", async () => {
    const chant = chant4607([gate("pr-99", 99)]);
    setChantProductForTests(chant.api);
    expect(await approve(["up", "--plan", "sha256:abc"], false, FALLBACK_EXIT, io(repo(), { PR_NUMBER: "7" }))).toBe(0);
    expect(chant.reads).toEqual([]);
    expect(chant.calls[0]!.argv.slice(0, 3)).toEqual(["approve", "pr-7", "up"]);
  });
});

describe("plywood resume (plywood#26)", () => {
  it("runs chant run resume --op pulumi-up in process with plywood's words", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await resume([], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["run", "resume", "--op", "pulumi-up"]);
    expect(chant.calls[0]!.words).toBe(PRODUCT_WORDS);
  });

  it("names a wave's gate with --wave, takes another --op, and passes --dry-run and --json", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await resume(["--wave", "2", "--dry-run"], true, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(await resume(["--op", "plywood-adopt"], false, FALLBACK_EXIT, io(repo()))).toBe(0);
    expect(chant.calls.map((c) => c.argv)).toEqual([
      ["run", "resume", "--op", "pulumi-up", "--gate", "wave-2", "--dry-run", "--json"],
      ["run", "resume", "--op", "plywood-adopt"],
    ]);
  });

  it("adds the line plywood up adds to a refusal, and keeps chant's code", async () => {
    const chant = fakeChant([FALLBACK_EXIT.waiting]);
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await resume(["--wave", "1"], false, FALLBACK_EXIT, o)).toBe(FALLBACK_EXIT.waiting);
    expect(o.stderr.join("\n")).toContain(refusalLine("waiting", { wave: 1 }));
  });

  it("refuses a bad wave and unknown flags, and names the chant it needs on the pin", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    expect(await resume(["--wave", "0"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
    expect(await resume(["--force"], false, FALLBACK_EXIT, io(repo()))).toBe(1);
    expect(chant.calls).toEqual([]);
    setChantProductForTests(undefined);
    const o = io(repo());
    expect(await resume([], false, FALLBACK_EXIT, o)).toBe(FALLBACK_EXIT.failed);
    expect(o.stderr.join("\n")).toContain(needsChantMessage("plywood resume"));
  });
});

describe("apply.requires on chant#4607 (plywood#26)", () => {
  const yml = "stacks:\n  shop/dev: {}\napply:\n  when: pull-request\n  requires: [approved, checks]\n";

  it("passes a subset to pr-apply --before-merge as --requires", async () => {
    const chant = chant4607();
    setChantProductForTests(chant.api);
    expect(await up(["--pr", "4"], false, FALLBACK_EXIT, io(repo(yml), { BASE_SHA: "abc" }))).toBe(0);
    expect(chant.calls[0]!.argv).toEqual(["components", "pr-apply", "--before-merge", "--base", "abc", "--pr", "4", "--env", "production", "--gate", "up", "--forge", "github", "--requires", "approved,checks"]);
  });

  it("passes nothing for all four, and says a chant before chant#4607 asks all four", async () => {
    const all = chant4607();
    setChantProductForTests(all.api);
    expect(await up(["--pr", "4"], false, FALLBACK_EXIT, io(repo("stacks:\n  shop/dev: {}\napply:\n  when: pull-request\n"), { BASE_SHA: "abc" }))).toBe(0);
    expect(all.calls[0]!.argv).not.toContain("--requires");
    const old = fakeChant();
    setChantProductForTests(old.api);
    const o = io(repo(yml), { BASE_SHA: "abc" });
    expect(await up(["--pr", "4"], false, FALLBACK_EXIT, o)).toBe(0);
    expect(old.calls[0]!.argv).not.toContain("--requires");
    expect(o.stderr.join("\n")).toContain("asks all four checks");
  });
});

describe("wave jobs on chant#4607 (plywood#26)", () => {
  it("leaves the waves workflow as chant wrote it, with plywood's bin from chant's generator", async () => {
    const dir = repo();
    const text = `# generated. Regenerate with: chant run --generate github --spec ${WAVES_SPEC_FILE}\njobs:\n  a:\n    steps:\n      - run: npx --no-install plywood run wave --spec ${WAVES_SPEC_FILE} --wave 1\n`;
    const chant = chant4607([], [], (argv) => {
      if (argv[0] !== "run") return;
      mkdirSync(join(dir, ".github/workflows"), { recursive: true });
      writeFileSync(join(dir, ".github/workflows/pulumi-up.yml"), text);
    });
    setChantProductForTests(chant.api);
    expect(await ci(["--forge", "github"], false, FALLBACK_EXIT, io(dir))).toBe(0);
    expect(readFileSync(join(dir, ".github/workflows/pulumi-up.yml"), "utf8")).toBe(text);
  });
});

describe("records", () => {
  it("plywood makes no git writes: no module runs git or spawns a process", () => {
    // plywood upgrade spawns npm and npx (plywood#23); control prints the push for the person to run.
    const SPAWNS = new Set(["upgrade.ts"]);
    const HINT = "  push it: git push origin chant/lifecycle";
    const src = fileURLToPath(new URL("../src", import.meta.url));
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(d, e.name));
      }
    };
    walk(src);
    for (const f of files) {
      const text = readFileSync(f, "utf8").replaceAll(HINT, "");
      if (!SPAWNS.has(basename(f))) expect(text, f).not.toMatch(/from\s+["'](node:)?child_process["']/);
      expect(text, f).not.toMatch(/\bgit\s+(push|commit|update-ref|notes)\b/);
    }
  });
});
