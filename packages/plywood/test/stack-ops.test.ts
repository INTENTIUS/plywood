import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { parseConfig } from "../src/config/index";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { ADOPT_OP_FILE } from "../src/init/adopt";
import {
  approveRequestLine,
  cancelStack,
  destStackName,
  exportStack,
  moveStack,
  requestRules,
  resolveStack,
  rollbackStack,
  setChantStackOpsForTests,
  STACK_OPS_OP,
  type ChantStackOps,
  type StackOpOutcome,
} from "../src/stack-ops";
import type { StageIo } from "../src/stages";
import { approveTarget } from "../src/up";

const T = FALLBACK_EXIT;

function io(cwd: string, env: NodeJS.ProcessEnv = {}): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

function repo(yml: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-stack-ops-"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
  return dir;
}

const YML = "stacks:\n  shop/dev: { dir: infra }\n  shop/prod: { dir: infra }\n  web/prod: { dir: web, backend: file:///srv/state }\napproval: sealed\n";

/** A fake lexicon: records each call's options and answers with `outcome`. */
function fakeOps(outcome: StackOpOutcome<unknown> | Error) {
  const calls: Array<{ op: string; opts: Record<string, unknown> }> = [];
  const answer = (op: string) => async (opts: unknown) => {
    calls.push({ op, opts: opts as Record<string, unknown> });
    if (outcome instanceof Error) throw outcome;
    return outcome as never;
  };
  const ops: ChantStackOps = { gatedStackExport: answer("export"), gatedStackCancel: answer("cancel"), gatedStackMove: answer("move") };
  return { ops, calls };
}

function fakeChant(code = 0) {
  const calls: string[][] = [];
  const api = {
    assertProductWords: (w: unknown) => w,
    productPipelineJobs: () => ({}),
    approveLine: () => "",
    runChantInProcess: async (argv: string[]) => {
      calls.push(argv);
      return code;
    },
  } as unknown as ChantProduct;
  return { api, calls };
}

afterEach(() => {
  setChantStackOpsForTests("reset");
  setChantProductForTests("reset");
});

const URN = "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::site";

describe("the request's inputs", () => {
  it("resolves a listed stack's directory against plywood.yml, and refuses one stacks does not list", () => {
    const config = parseConfig(YML);
    expect(resolveStack(config, "/r/plywood.yml", "shop/dev")).toEqual({ key: "shop/dev", project: "shop", stack: "dev", dir: "/r/infra" });
    expect(resolveStack(config, "/r/plywood.yml", "web/prod")).toMatchObject({ dir: "/r/web", backend: "file:///srv/state" });
    expect(resolveStack(config, "/r/plywood.yml", "shop/qa")).toEqual({ error: expect.stringContaining("not under stacks") });
    expect(resolveStack(config, "/r/plywood.yml", "shop/qa", "elsewhere")).toMatchObject({ dir: "/r/elsewhere" });
    expect(resolveStack(config, "/r/plywood.yml", "dev")).toEqual({ error: expect.stringContaining("project/stack") });
  });

  it("takes plywood.yml's approval and rules, as chant's gated requests read them", () => {
    expect(requestRules(parseConfig("approval: sealed"))).toEqual({ mode: "sealed" });
    expect(requestRules(parseConfig("approval_rules: { 'shop/*': { quorum: 2 } }"))).toEqual({
      mode: "ledger",
      quorum: [{ targets: ["shop/*"], count: 2, notAuthor: true }],
    });
  });

  it("qualifies a destination in another project", () => {
    const config = parseConfig(YML);
    const s = resolveStack(config, "/r/plywood.yml", "shop/dev") as never;
    expect(destStackName(s, resolveStack(config, "/r/plywood.yml", "shop/prod") as never, config)).toBe("prod");
    expect(destStackName(s, resolveStack(config, "/r/plywood.yml", "web/prod") as never, config)).toBe("organization/web/prod");
    const cloud = parseConfig(`${YML}pulumi_cloud: { org: acme }\n`);
    const d = { key: "web/dev", project: "web", stack: "dev", dir: "/r/web" };
    expect(destStackName(s, d, cloud)).toBe("acme/web/dev");
  });

  it("prints an approve line plywood approve takes back as chant's op and gate", () => {
    const line = approveRequestLine("move:dev:prod", "sha256:ab", "sealed");
    expect(line).toBe(`plywood approve move:dev:prod --op ${STACK_OPS_OP} --plan sha256:ab --sign`);
    expect(approveTarget("move:dev:prod", { op: STACK_OPS_OP })).toEqual({ op: STACK_OPS_OP, gate: "move:dev:prod" });
  });
});

describe("plywood export", () => {
  it("waits for a second person, printing the approve line, with chant's waiting code", async () => {
    const dir = repo(YML);
    const { ops, calls } = fakeOps({ status: "waiting", digest: "sha256:e1", command: "chant approve pulumi-stack-ops dev --plan sha256:e1" });
    setChantStackOpsForTests(ops);
    const out = io(dir, { USER: "ana" });
    expect(await exportStack(["shop/dev", "--out", "/home/ana/dev.json"], false, T, out)).toBe(T.waiting);
    expect(calls[0]!.opts).toMatchObject({ by: "ana", stack: "dev", dir: join(dir, "infra"), out: "/home/ana/dev.json", op: STACK_OPS_OP, rules: { mode: "sealed" } });
    expect(out.stderr.join("\n")).toContain("plywood approve dev --op pulumi-stack-ops --plan sha256:e1 --sign");
  });

  it("reports the file once approved, and a refusal chant throws as failed", async () => {
    const dir = repo(YML);
    setChantStackOpsForTests(fakeOps({ status: "done", digest: "sha256:e1", result: { file: "/home/ana/dev.json", sha256: "ff", bytes: 10, resources: 3 } }).ops);
    const done = io(dir);
    expect(await exportStack(["shop/dev", "--out", "/home/ana/dev.json", "--by", "ana"], true, T, done)).toBe(T.done);
    expect(JSON.parse(done.stdout[0]!)).toMatchObject({ command: "export", ok: true, status: "done", result: { resources: 3 } });

    setChantStackOpsForTests(fakeOps(new Error("a stack export goes to the requester's machine only, and CI is set")).ops);
    const ci = io(dir, { CI: "true" });
    expect(await exportStack(["shop/dev", "--out", "/tmp/x.json"], false, T, ci)).toBe(T.failed);
    expect(ci.stderr.join("\n")).toContain("requester's machine only");
  });

  it("needs --out, and says so when the installed lexicon lacks the operations", async () => {
    const dir = repo(YML);
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops);
    const noOut = io(dir);
    expect(await exportStack(["shop/dev"], false, T, noOut)).toBe(T.failed);
    expect(noOut.stderr.join("\n")).toContain("--out <file>");
    setChantStackOpsForTests(undefined);
    const old = io(dir);
    expect(await exportStack(["shop/dev", "--out", "/tmp/x.json"], false, T, old)).toBe(T.failed);
    expect(old.stderr.join("\n")).toContain("chant#4578");
  });
});

describe("plywood cancel", () => {
  it("asks for the named lock, with the project for a file backend's lock path", async () => {
    const dir = repo(YML);
    const { ops, calls } = fakeOps({ status: "done", digest: "sha256:c", result: { lockChecked: true } });
    setChantStackOpsForTests(ops);
    const out = io(dir);
    expect(await cancelStack(["web/prod", "--lock", "abc123"], false, T, out)).toBe(T.done);
    expect(calls[0]!.opts).toMatchObject({ stack: "prod", lockId: "abc123", project: "web" });
    expect(out.env.PULUMI_BACKEND_URL).toBe("file:///srv/state");
    expect(out.stdout.join("\n")).toContain("Released lock abc123 on web/prod");
  });

  it("needs --lock", async () => {
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops);
    const out = io(repo(YML));
    expect(await cancelStack(["shop/dev"], false, T, out)).toBe(T.failed);
    expect(out.stderr.join("\n")).toContain("--lock <id>");
  });

  it("keeps the approver's refusal as a wait for another approval", async () => {
    setChantStackOpsForTests(fakeOps({ status: "refused", digest: "sha256:c", by: "ana", reason: "ana made the request", command: "" }).ops);
    const out = io(repo(YML));
    expect(await cancelStack(["shop/dev", "--lock", "l1", "--by", "ana"], false, T, out)).toBe(T.waiting);
    expect(out.stderr.join("\n")).toContain("ana made the request");
  });
});

describe("plywood move", () => {
  it("names both stacks and the URNs, under the gate move:<source>:<dest>", async () => {
    const { ops, calls } = fakeOps({ status: "waiting", digest: "sha256:m", command: "" });
    setChantStackOpsForTests(ops);
    const out = io(repo(YML));
    expect(await moveStack([URN, "--from", "shop/dev", "--to", "shop/prod"], true, T, out)).toBe(T.waiting);
    expect(calls[0]!.opts).toMatchObject({ source: { member: "shop/dev", stack: "dev" }, dest: { member: "shop/prod", stack: "prod" }, urns: [URN] });
    expect(JSON.parse(out.stdout[0]!)).toMatchObject({ gate: "move:dev:prod", approve: `plywood approve move:dev:prod --op ${STACK_OPS_OP} --plan sha256:m --sign` });
  });

  it("refuses a non-URN, one stack twice, and two backends", async () => {
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops);
    const dir = repo(YML);
    expect(await moveStack(["site", "--from", "shop/dev", "--to", "shop/prod"], false, T, io(dir))).toBe(T.failed);
    expect(await moveStack([URN, "--from", "shop/dev", "--to", "shop/dev"], false, T, io(dir))).toBe(T.failed);
    const two = repo("stacks:\n  a/x: { backend: file:///one }\n  b/y: { backend: file:///two }\n");
    const out = io(two);
    expect(await moveStack([URN, "--from", "a/x", "--to", "b/y"], false, T, out)).toBe(T.failed);
    expect(out.stderr.join("\n")).toContain("different backends");
  });

  it("onto plunge runs the adopt Op init wrote, and needs it", async () => {
    const chant = fakeChant(T.waiting);
    setChantProductForTests(chant.api);
    const none = io(repo(YML));
    expect(await moveStack(["shop/dev", "--onto", "plunge"], false, T, none)).toBe(T.failed);
    expect(none.stderr.join("\n")).toContain("init --engine plunge");
    const out = io(repo(YML, { [ADOPT_OP_FILE]: "export {};\n" }));
    expect(await moveStack(["shop/dev", "--onto", "plunge"], false, T, out)).toBe(T.waiting);
    expect(chant.calls).toEqual([["run", "plywood-adopt"]]);
  });
});

describe("plywood rollback", () => {
  it("rolls one stack back to its previous release as its component", async () => {
    const chant = fakeChant(T.waiting);
    setChantProductForTests(chant.api);
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops, true);
    const out = io(repo(YML));
    expect(await rollbackStack(["shop/prod", "--dry-run"], false, T, out)).toBe(T.waiting);
    expect(chant.calls).toEqual([["components", "rollback", "prod", "--component", "shop-prod", "--dry-run"]]);
    expect(out.stderr.join("\n")).toContain("release gate");
  });

  it("rolls an environment back to a release, and refuses a stack with --release", async () => {
    const chant = fakeChant(0);
    setChantProductForTests(chant.api);
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops, true);
    const dir = repo(YML);
    expect(await rollbackStack(["--release", "shop-2026-10-27", "--env", "prod"], true, T, io(dir))).toBe(T.done);
    expect(chant.calls).toEqual([["components", "rollback", "prod", "--release", "shop-2026-10-27", "--json"]]);
    const out = io(dir);
    expect(await rollbackStack(["shop/prod", "--release", "r1"], false, T, out)).toBe(T.failed);
    expect(out.stderr.join("\n")).toContain("--env prod");
  });

  it("says so when the installed lexicon cannot roll a stack back", async () => {
    setChantProductForTests(fakeChant().api);
    setChantStackOpsForTests(undefined, false);
    const out = io(repo(YML));
    expect(await rollbackStack(["shop/prod"], false, T, out)).toBe(T.failed);
    expect(out.stderr.join("\n")).toContain("chant#4542");
  });
});
