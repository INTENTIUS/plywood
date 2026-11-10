import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { CHANT_DEFAULTS } from "./chant-defaults";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { parseConfig } from "../src/config/index";
import { EXIT } from "../src/exit-codes";
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
  setChantStackLockReaderForTests,
  setChantStackOpsForTests,
  STACK_OPS_OP,
  cancelForge,
  type ChantStackOps,
} from "../src/stack-ops";
import { PulumiStackOpRefused } from "@intentius/chant-lexicon-pulumi";
import type { StageIo } from "../src/stages";
import { approveTarget } from "../src/up";

const T = EXIT;

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

/** A fake lexicon: records each call's options and answers with `outcome` (a `PulumiStackOpOutcome`, or a throw). */
function fakeOps(outcome: { status: string; digest: string; [k: string]: unknown } | Error) {
  const calls: Array<{ op: string; opts: Record<string, unknown> }> = [];
  const answer = (op: string) => async (opts: unknown) => {
    calls.push({ op, opts: opts as Record<string, unknown> });
    if (outcome instanceof Error) throw outcome;
    return outcome as never;
  };
  const ops: ChantStackOps = { gatedStackExport: answer("export"), gatedStackCancel: answer("cancel"), gatedStackMove: answer("move"), PulumiStackOpRefused };
  return { ops, calls };
}

function fakeChant(code = 0) {
  const calls: string[][] = [];
  const api = {
    assertProductWords: (w: unknown) => w,
    productPipelineJobs: () => ({}),
    approveLine: () => "",
    ...CHANT_DEFAULTS,
    runChantInProcess: async (argv: string[]) => {
      calls.push(argv);
      return code;
    },
  } as unknown as ChantProduct;
  return { api, calls };
}

afterEach(() => {
  setChantStackOpsForTests("reset");
  setChantStackLockReaderForTests("reset");
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

  it("asks for the version --version names (chant#4808)", async () => {
    const { ops, calls } = fakeOps({ status: "waiting", digest: "sha256:e2", command: "" });
    setChantStackOpsForTests(ops);
    expect(await exportStack(["shop/dev", "--out", "/home/ana/dev.json", "--version", "42"], false, T, io(repo(YML)))).toBe(T.waiting);
    expect(calls[0]!.opts).toMatchObject({ stack: "dev", version: "42" });
    const none = fakeOps({ status: "waiting", digest: "sha256:e3", command: "" });
    setChantStackOpsForTests(none.ops);
    await exportStack(["shop/dev", "--out", "/home/ana/dev.json"], false, T, io(repo(YML)));
    expect(none.calls[0]!.opts).not.toHaveProperty("version");
  });

  it("needs --out, and says so when the installed lexicon lacks the operations", async () => {
    const dir = repo(YML);
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops);
    const noOut = io(dir);
    expect(await exportStack(["shop/dev"], false, T, noOut)).toBe(T.failed);
    expect(noOut.stderr.join("\n")).toContain("--out <file>");
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
    setChantStackLockReaderForTests(async () => ({ checked: false, ids: [] }));
    const out = io(repo(YML));
    expect(await cancelStack(["shop/dev"], false, T, out)).toBe(T.failed);
    expect(out.stderr.join("\n")).toContain("--lock <id>");
  });

  it("passes the forge plywood.yml names, else the one origin names, for chant's read of the live runs (chant#4808)", () => {
    expect(cancelForge(parseConfig("forge: { kind: forgejo, url: https://code.acme.dev }\n"), mkdtempSync(join(tmpdir(), "plywood-stack-ops-")))).toEqual({ kind: "forgejo", url: "https://code.acme.dev" });
    const dir = mkdtempSync(join(tmpdir(), "plywood-stack-ops-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, ".git", "config"), '[remote "origin"]\n\turl = git@gitlab.acme.dev:infra/shop.git\n');
    expect(cancelForge(parseConfig(""), dir)).toEqual({ kind: "gitlab", url: "https://gitlab.acme.dev" });
    expect(cancelForge(parseConfig(""), mkdtempSync(join(tmpdir(), "plywood-stack-ops-")))).toEqual({});
  });

  it("sends that forge with the request", async () => {
    const { ops, calls } = fakeOps({ status: "waiting", digest: "sha256:c", command: "" });
    setChantStackOpsForTests(ops);
    expect(await cancelStack(["shop/dev", "--lock", "l1"], false, T, io(repo(`${YML}forge: { kind: github }\n`)))).toBe(T.waiting);
    expect(calls[0]!.opts).toMatchObject({ forge: { kind: "github" } });
  });

  it("is chant's held while a run that may hold the lock is alive, and failed for any other refusal", async () => {
    setChantStackOpsForTests(fakeOps(new PulumiStackOpRefused("live-run", "run 12 started before the lock and is still running")).ops);
    const live = io(repo(YML));
    expect(await cancelStack(["shop/dev", "--lock", "l1"], true, T, live)).toBe(T.held);
    expect(JSON.parse(live.stdout[0]!)).toMatchObject({ ok: false, exitCode: T.held, refusal: "live-run" });
    setChantStackOpsForTests(fakeOps(new PulumiStackOpRefused("held", "run 12 came back before the release; the approval stands")).ops);
    expect(await cancelStack(["shop/dev", "--lock", "l1"], false, T, io(repo(YML)))).toBe(T.held);
    setChantStackOpsForTests(fakeOps(new PulumiStackOpRefused("lock-gone", "the stack no longer holds l1")).ops);
    expect(await cancelStack(["shop/dev", "--lock", "l1"], false, T, io(repo(YML)))).toBe(T.failed);
  });

  it("keeps the approver's refusal as a wait for another approval", async () => {
    setChantStackOpsForTests(fakeOps({ status: "refused", digest: "sha256:c", by: "ana", reason: "ana made the request", command: "" }).ops);
    const out = io(repo(YML));
    expect(await cancelStack(["shop/dev", "--lock", "l1", "--by", "ana"], false, T, out)).toBe(T.waiting);
    expect(out.stderr.join("\n")).toContain("ana made the request");
  });
});

describe("plywood cancel with chant's lock reader (plywood#26, chant#4615)", () => {
  it("reads the one lock a file:// backend holds when --lock is left out", async () => {
    const { ops, calls } = fakeOps({ status: "done", digest: "sha256:c", result: { lockChecked: true } });
    setChantStackOpsForTests(ops);
    const asked: unknown[] = [];
    setChantStackLockReaderForTests(async (o) => (asked.push(o), { checked: true, backend: "file:///srv/state", ids: ["lock-7"] }));
    const out = io(repo(YML));
    expect(await cancelStack(["web/prod"], false, T, out)).toBe(T.done);
    expect(asked[0]).toMatchObject({ stack: "prod", project: "web" });
    expect(calls[0]!.opts).toMatchObject({ stack: "prod", lockId: "lock-7" });
    expect(out.stderr.join("\n")).toContain("web/prod holds lock lock-7");
  });

  it("refuses no lock, two locks, and a backend the reader cannot list, and runs nothing", async () => {
    const { ops, calls } = fakeOps({ status: "spent", digest: "x" });
    setChantStackOpsForTests(ops);
    for (const [answer, words] of [
      [{ checked: true, ids: [] }, "holds no lock"],
      [{ checked: true, ids: ["a", "b"] }, "holds 2 locks (a, b)"],
      [{ checked: false, backend: "s3://state", ids: [] }, "s3://state"],
    ] as const) {
      setChantStackLockReaderForTests(async () => ({ ...answer, ids: [...answer.ids] }));
      const out = io(repo(YML));
      expect(await cancelStack(["web/prod"], false, T, out)).toBe(T.failed);
      expect(out.stderr.join("\n")).toContain(words);
    }
    expect(calls).toEqual([]);
  });

  it("takes --lock over the reader", async () => {
    const { ops, calls } = fakeOps({ status: "done", digest: "sha256:c", result: { lockChecked: true } });
    setChantStackOpsForTests(ops);
    let read = false;
    setChantStackLockReaderForTests(async () => ((read = true), { checked: true, ids: ["other"] }));
    expect(await cancelStack(["web/prod", "--lock", "mine"], false, T, io(repo(YML)))).toBe(T.done);
    expect(read).toBe(false);
    expect(calls[0]!.opts).toMatchObject({ lockId: "mine" });
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

  it("is chant's moved when a stack changed after the approval, and nothing was moved (chant#4808)", async () => {
    setChantStackOpsForTests(fakeOps({ status: "failed", digest: "sha256:m", check: "moved", error: "the state of shop/dev changed since the plan, so nothing was moved" }).ops);
    const out = io(repo(YML));
    expect(await moveStack([URN, "--from", "shop/dev", "--to", "shop/prod"], true, T, out)).toBe(T.moved);
    expect(JSON.parse(out.stdout[0]!)).toMatchObject({ status: "failed", check: "moved", exitCode: T.moved });
    setChantStackOpsForTests(fakeOps({ status: "failed", digest: "sha256:m", error: "pulumi state move failed" }).ops);
    expect(await moveStack([URN, "--from", "shop/dev", "--to", "shop/prod"], false, T, io(repo(YML)))).toBe(T.failed);
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
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops);
    const out = io(repo(YML));
    expect(await rollbackStack(["shop/prod", "--dry-run"], false, T, out)).toBe(T.waiting);
    expect(chant.calls).toEqual([["components", "rollback", "prod", "--component", "shop-prod", "--dry-run"]]);
    expect(out.stderr.join("\n")).toContain("release gate");
  });

  it("rolls an environment back to a release, and refuses a stack with --release", async () => {
    const chant = fakeChant(0);
    setChantProductForTests(chant.api);
    setChantStackOpsForTests(fakeOps({ status: "spent", digest: "x" }).ops);
    const dir = repo(YML);
    expect(await rollbackStack(["--release", "shop-2026-10-27", "--env", "prod"], true, T, io(dir))).toBe(T.done);
    expect(chant.calls).toEqual([["components", "rollback", "prod", "--release", "shop-2026-10-27", "--json"]]);
    const out = io(dir);
    expect(await rollbackStack(["shop/prod", "--release", "r1"], false, T, out)).toBe(T.failed);
    expect(out.stderr.join("\n")).toContain("--env prod");
  });

});
