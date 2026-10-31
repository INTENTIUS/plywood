import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chantProduct, setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { runInit } from "../src/init";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { isCron } from "../src/config/drift";
import {
  drift,
  driftMember,
  DRIFT_OP_FILE,
  DRIFT_SPEC_FILE,
  driftFingerprint,
  driftOpFile,
  driftOpSpec,
  driftRows,
  setDriftForgeForTests,
  SNAPSHOTS_FETCH,
  wavesHolding,
  writeDriftJobs,
  type DriftDoc,
  type DriftForge,
} from "../src/drift";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { installLine, TOOL_VERSIONS } from "../src/images";
import type { StageIo } from "../src/stages";
import { driftIssueMarker, driftOpName, PRODUCT_WORDS } from "../src/words";

const URN = "urn:pulumi:dev::shop::aws:sqs/queue:Queue::orders";

const DRIFTED: DriftDoc = {
  records: [
    { address: URN, status: "drifted", observedAt: "2026-10-27T06:00:00Z", attributes: [{ path: "visibilityTimeoutSeconds" }] },
    { address: "urn:pulumi:dev::shop::aws:s3/bucket:Bucket::site", status: "in-sync", observedAt: "2026-10-27T06:00:00Z" },
  ],
};
const CLEAN: DriftDoc = { records: [{ address: URN, status: "in-sync", observedAt: "2026-10-27T07:00:00Z" }] };
const CART_CLEAN: DriftDoc = { records: [{ address: "urn:pulumi:prod::cart::aws:sqs/queue:Queue::orders", status: "in-sync", observedAt: "2026-10-27T07:00:00Z" }] };

/**
 * A fake chant that writes `docs[member]` where `workspace drift -o` asks, and records each call.
 * Like chant's command (workspace/drift-cli.ts), it takes a workspace member of the declaration
 * and refuses anything else with `member-required`; a stack key is not a member (plywood#50).
 * With `--stack` (chant 0.124.59) it reads that stack's export, and answers `no-drift-read`
 * naming the stack when `stored` lists the member's exports and the stack is not among them.
 */
function fakeChant(docs: Record<string, DriftDoc | "fail">, declared: readonly string[] = ["shop", "cart"], stored: Record<string, readonly string[]> = {}) {
  const calls: string[][] = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: () => {
      throw new Error("not used");
    },
    approveLine: () => "",
    runChantInProcess: async (argv) => {
      calls.push(argv);
      if (argv[0] === "workspace" && argv[1] === "drift") {
        const member = argv[argv.indexOf("--member") + 1]!;
        if (!declared.includes(member)) {
          writeFileSync(argv[argv.indexOf("-o") + 1]!, JSON.stringify({ error: { code: "member-required", message: `--member ${member} is not a member of w; it declares ${declared.join(", ")}` } }));
          return 1;
        }
        const stack = argv.includes("--stack") ? argv[argv.indexOf("--stack") + 1]! : undefined;
        if (stack !== undefined && stored[member] && !stored[member]!.includes(stack)) {
          writeFileSync(argv[argv.indexOf("-o") + 1]!, JSON.stringify({ error: { code: "no-drift-read", message: `the store holds no export for stack ${stack} of ${member}` } }));
          return 1;
        }
        const doc = docs[member];
        if (doc === "fail" || doc === undefined) return 1;
        writeFileSync(argv[argv.indexOf("-o") + 1]!, JSON.stringify(doc));
      }
      return 0;
    },
  };
  return { api, calls };
}

/** A fake forge that keeps issues by marker, as chant's trackIssue does. */
function fakeForge() {
  const open = new Map<string, { number: number; title: string; body: string }>();
  let next = 1;
  const actions: string[] = [];
  const forge: DriftForge = {
    runUrl: "http://127.0.0.1:3000/run/1",
    async trackIssue(marker, finding, opts) {
      const mine = open.get(marker);
      if (finding === null) {
        if (!mine) return { action: "none" };
        if (!opts?.closeOnClear) return { action: "left", number: mine.number };
        open.delete(marker);
        actions.push(`closed ${mine.number}`);
        return { action: "closed", number: mine.number };
      }
      if (!mine) {
        const n = next++;
        open.set(marker, { number: n, ...finding });
        actions.push(`opened ${n}`);
        return { action: "opened", number: n };
      }
      if (opts?.sameWhen && mine.title === finding.title && mine.body.includes(opts.sameWhen)) return { action: "unchanged", number: mine.number };
      Object.assign(mine, finding);
      actions.push(`updated ${mine.number}`);
      return { action: "updated", number: mine.number };
    },
  };
  return { forge, open, actions };
}

function io(cwd: string): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env: {}, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

/** A repository as `plywood init` leaves it: plywood.yml, and a workspace declaring one member per project. */
function repo(yml: string, members: Array<[string, string]> = [["shop", "shop"], ["cart", "cart"]]): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-drift-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  writeFileSync(join(dir, "chant.workspace.json"), JSON.stringify({ name: "w", schema: 1, members: members.map(([name, d]) => ({ name, dir: d, kind: "pulumi" })) }));
  return dir;
}

const YML = 'stacks:\n  shop/dev: { dir: shop }\n  cart/prod: { dir: cart }\ndrift:\n  schedule: "0 6 * * *"\n';

afterEach(() => {
  setChantProductForTests("reset");
  setDriftForgeForTests("reset");
});

describe("drift config", () => {
  it("takes a cron schedule, stacks and a response", () => {
    const c = parseConfig(`${YML}  stacks: [shop/dev]\nrespond:\n  drift: up\n`);
    expect(checkConfig(c).filter((p) => p.severity === "error")).toEqual([]);
    expect(toChantSettings(c).pipeline.drift).toEqual({ schedule: "0 6 * * *", stacks: ["shop/dev"], respond: "up" });
  });

  it("refuses a schedule that is not cron and a response it does not know", () => {
    const keys = checkConfig(parseConfig('drift: { schedule: "daily" }\nrespond: { drift: email }\n')).filter((p) => p.severity === "error").map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["drift.schedule", "respond.drift"]));
    expect(isCron("*/15 0-6 * * 1,3")).toBe(true);
    expect(isCron("0 6 * *")).toBe(false);
  });
});

describe("plywood drift", () => {
  it("reads each stack through chant's workspace drift and exits with chant's drift code", async () => {
    const chant = fakeChant({ shop: DRIFTED, cart: CART_CLEAN });
    setChantProductForTests(chant.api);
    const out = io(repo(YML));
    const code = await drift([], true, FALLBACK_EXIT, out);
    expect(code).toBe(FALLBACK_EXIT.drift);
    expect(chant.calls.map((a) => a.slice(0, 6))).toEqual([
      ["workspace", "drift", "--member", "shop", "--stack", "dev"],
      ["workspace", "drift", "--member", "cart", "--stack", "prod"],
    ]);
    const env = JSON.parse(out.stdout[0]!);
    expect(env.stacks[0]).toMatchObject({ stack: "shop/dev", drifted: 1, rows: [{ urn: URN, attributes: ["visibilityTimeoutSeconds"] }] });
    expect(env.stacks[1]).toMatchObject({ stack: "cart/prod", drifted: 0 });
  });

  it("opens one issue naming the URN and attribute, edits it on a new finding, and a clean run closes it", async () => {
    const dir = repo(YML);
    const f = fakeForge();
    setDriftForgeForTests(async () => f.forge);
    setChantProductForTests(fakeChant({ shop: DRIFTED }).api);
    expect(await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir))).toBe(FALLBACK_EXIT.drift);
    const issue = f.open.get(driftIssueMarker("shop/dev"))!;
    expect(issue.body).toContain(URN);
    expect(issue.body).toContain("visibilityTimeoutSeconds");

    // The same finding leaves it alone; a changed one edits it.
    await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir));
    const changed: DriftDoc = { records: [{ ...DRIFTED.records![0]!, attributes: [{ path: "delaySeconds" }] }] };
    setChantProductForTests(fakeChant({ shop: changed }).api);
    await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir));

    setChantProductForTests(fakeChant({ shop: CLEAN }).api);
    expect(await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir))).toBe(FALLBACK_EXIT.done);
    expect(f.actions).toEqual(["opened 1", "updated 1", "closed 1"]);
  });

  it("exits failed when a read cannot run, and maps --op back to its stack", async () => {
    const chant = fakeChant({ shop: "fail" });
    setChantProductForTests(chant.api);
    expect(await drift(["--op", driftOpName("shop/dev")], false, FALLBACK_EXIT, io(repo(YML)))).toBe(FALLBACK_EXIT.failed);
    expect(chant.calls).toHaveLength(1);
    expect(chant.calls[0]!.slice(0, 6)).toEqual(["workspace", "drift", "--member", "shop", "--stack", "dev"]);
    expect(await drift(["--op", "plywood-drift-nope"], false, FALLBACK_EXIT, io(repo(YML)))).toBe(FALLBACK_EXIT.failed);
  });

  it("with respond up, updates the waves holding the drifted stacks", () => {
    const doc = parseConfig("waves: [[shop/dev], [shop/prod]]\n").doc;
    expect(wavesHolding(doc, ["shop/prod"])).toEqual([2]);
    expect(wavesHolding({}, ["shop/prod"])).toBe("all");
  });

  it("says the product pipeline is missing on a chant without it", async () => {
    setChantProductForTests(undefined);
    const out = io(repo(YML));
    expect(await drift([], false, FALLBACK_EXIT, out)).toBe(FALLBACK_EXIT.failed);
    expect(out.stderr.join("\n")).toContain("chant#4550");
  });
});

describe("the member a stack is read under (plywood#50)", () => {
  it("is the workspace member of the stack's project, not the stack key", async () => {
    // As plywood init writes it: one member for the project, none for each stack.
    const dir = repo('stacks:\n  shop/prod-us: { dir: "." }\n  shop/prod-eu: { dir: "." }\n', [["shop", "."]]);
    const doc = parseConfig('stacks:\n  shop/prod-us: { dir: "." }\n  shop/prod-eu: { dir: "." }\n').doc;
    expect(driftMember(dir, doc, "shop/prod-us")).toBe("shop");
    const chant = fakeChant({ shop: { records: [{ address: "urn:pulumi:prod-us::shop::aws:sqs/queue:Queue::events", status: "drifted", attributes: [{ path: "messageRetentionSeconds" }] }] } }, ["shop"]);
    setChantProductForTests(chant.api);
    const out = io(dir);
    expect(await drift(["--op", driftOpName("shop/prod-us")], true, FALLBACK_EXIT, out)).toBe(FALLBACK_EXIT.drift);
    expect(chant.calls[0]!.slice(0, 6)).toEqual(["workspace", "drift", "--member", "shop", "--stack", "prod-us"]);
    expect(JSON.parse(out.stdout[0]!).stacks[0]).toMatchObject({ stack: "shop/prod-us", ok: true, drifted: 1 });
  });

  it("takes the declaration's member for the stack's directory, then one named for the project, then the only one, else the project", () => {
    const doc = parseConfig("stacks:\n  Shop App/dev: { dir: infra }\n  Shop App/prod: {}\n").doc;
    const root = (members: Array<[string, string]>) => repo("", members);
    expect(driftMember(root([["web", "infra"], ["Shop App", "other"]]), doc, "Shop App/dev")).toBe("web");
    expect(driftMember(root([["web", "x"], ["Shop App", "other"]]), doc, "Shop App/prod")).toBe("Shop App");
    expect(driftMember(root([["web", "x"], ["shop-app", "other"]]), doc, "Shop App/prod")).toBe("shop-app");
    expect(driftMember(root([["only", "x"]]), doc, "Shop App/prod")).toBe("only");
    expect(driftMember(root([["a", "x"], ["b", "y"]]), doc, "Shop App/prod")).toBe("Shop App");
    expect(driftMember(mkdtempSync(join(tmpdir(), "plywood-drift-")), doc, "Shop App/prod")).toBe("Shop App");
  });

  it("passes each stack of a project to chant, and fails the read of one the store holds no export for", async () => {
    const dir = repo('stacks:\n  shop/dev: { dir: shop }\n  shop/prod: { dir: shop }\n');
    const chant = fakeChant({ shop: DRIFTED }, ["shop", "cart"], { shop: ["dev"] });
    setChantProductForTests(chant.api);
    const out = io(dir);
    expect(await drift([], true, FALLBACK_EXIT, out)).toBe(FALLBACK_EXIT.failed);
    expect(chant.calls.map((a) => a.slice(0, 6))).toEqual([
      ["workspace", "drift", "--member", "shop", "--stack", "dev"],
      ["workspace", "drift", "--member", "shop", "--stack", "prod"],
    ]);
    const [dev, prod] = JSON.parse(out.stdout[0]!).stacks;
    expect(dev).toMatchObject({ stack: "shop/dev", ok: true, drifted: 1 });
    expect(prod).toMatchObject({ stack: "shop/prod", ok: false, drifted: 0 });
    expect(prod.error).toContain("no-drift-read");
    expect(prod.error).toContain("stack prod");
  });
});

const real = await chantProduct();

describe.runIf(real !== undefined)("against the installed chant's workspace drift (plywood#50)", () => {
  it("finds the member plywood init declares for a stack of its project", async () => {
    setChantProductForTests("reset");
    const dir = mkdtempSync(join(tmpdir(), "plywood-drift-real-"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "Pulumi.yaml"), "name: shop\nruntime: nodejs\n");
    for (const s of ["dev", "prod-us"]) writeFileSync(join(dir, `Pulumi.${s}.yaml`), "config: {}\n");
    writeFileSync(join(dir, "package.json"), '{"name":"shop","private":true}\n');
    const was = process.cwd();
    process.chdir(dir);
    try {
      const init = await runInit({ env: "production", bucketCheck: false, dryRun: false, yes: true, forge: "forgejo" }, FALLBACK_EXIT, { cwd: dir, env: {}, out: () => {}, err: () => {} });
      expect(init.ok).toBe(true);
      const out = io(dir);
      await drift(["shop/prod-us"], true, FALLBACK_EXIT, out);
      const read = JSON.parse(out.stdout[0]!).stacks[0] as { ok: boolean; error?: string };
      // With no stored export and no pulumi the read cannot run, but it gets as far as the member's own read.
      expect(read.error ?? "").not.toContain("member-required");
      expect(read.error ?? "").not.toContain("is not a member");
    } finally {
      process.chdir(was);
    }
  }, 60_000);
});

describe("drift rows and fingerprint", () => {
  it("counts drifted and missing, and fingerprints the same finding the same way", () => {
    const rows = driftRows({ records: [...DRIFTED.records!, { address: "urn:x", status: "missing" }] });
    expect(rows.map((r) => r.status)).toEqual(["drifted", "missing"]);
    expect(driftFingerprint(rows)).toBe(driftFingerprint(driftRows({ records: [...DRIFTED.records!, { address: "urn:x", status: "missing" }] })));
  });
});

describe("the scheduled drift jobs", () => {
  it("writes one PulumiWatchOp per stack and a spec that runs plywood drift", () => {
    const doc = parseConfig(YML).doc;
    const op = driftOpFile(doc, ["shop/dev"], "0 6 * * *");
    expect(op).toContain('PulumiWatchOp({ name: "plywood-drift-shop-dev", member: "shop/dev", dir: "shop", stack: "dev", schedule: "0 6 * * *" })');
    const spec = driftOpSpec(doc, "github", ["shop/dev"], "0 6 * * *");
    expect(spec.ops).toEqual([{ name: "plywood-drift-shop-dev", trigger: { kind: "cron", schedule: "0 6 * * *" }, findingMode: "issue" }]);
    expect(spec.options.runCommand).toEqual(["npx", "--no-install", "plywood", "drift", "--op", "{name}", "--forge", "github"]);
    expect(spec.options.beforeScript).toEqual([SNAPSHOTS_FETCH, installLine("pulumi", TOOL_VERSIONS.pulumi)]);
  });

  it("has chant generate the jobs from the spec", async () => {
    const dir = repo(YML);
    const chant = fakeChant({});
    await writeDriftJobs(chant.api, "forgejo", parseConfig(YML).doc, PRODUCT_WORDS, FALLBACK_EXIT, io(dir));
    expect(chant.calls).toEqual([["run", "--generate", "forgejo", "--spec", DRIFT_SPEC_FILE, "--output", ".forgejo/workflows"]]);
    expect(readFileSync(join(dir, DRIFT_OP_FILE), "utf8")).toContain("plywood-drift-cart-prod");
  });
});
