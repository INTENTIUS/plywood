import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { setChantProductForTests, type ChantProduct } from "../src/chant-product";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { isCron } from "../src/config/drift";
import {
  drift,
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

/** A fake chant that writes `docs[member]` where `workspace drift -o` asks, and records each call. */
function fakeChant(docs: Record<string, DriftDoc | "fail">) {
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

function repo(yml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-drift-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  return dir;
}

const YML = 'stacks:\n  shop/dev: { dir: shop }\n  shop/prod: { dir: shop }\ndrift:\n  schedule: "0 6 * * *"\n';

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
    const chant = fakeChant({ "shop/dev": DRIFTED, "shop/prod": CLEAN });
    setChantProductForTests(chant.api);
    const out = io(repo(YML));
    const code = await drift(["--json"], true, FALLBACK_EXIT, out);
    expect(code).toBe(FALLBACK_EXIT.drift);
    expect(chant.calls.map((a) => a.slice(0, 4))).toEqual([
      ["workspace", "drift", "--member", "shop/dev"],
      ["workspace", "drift", "--member", "shop/prod"],
    ]);
    const env = JSON.parse(out.stdout[0]!);
    expect(env.stacks[0]).toMatchObject({ stack: "shop/dev", drifted: 1, rows: [{ urn: URN, attributes: ["visibilityTimeoutSeconds"] }] });
    expect(env.stacks[1]).toMatchObject({ stack: "shop/prod", drifted: 0 });
  });

  it("opens one issue naming the URN and attribute, edits it on a new finding, and a clean run closes it", async () => {
    const dir = repo(YML);
    const f = fakeForge();
    setDriftForgeForTests(async () => f.forge);
    setChantProductForTests(fakeChant({ "shop/dev": DRIFTED }).api);
    expect(await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir))).toBe(FALLBACK_EXIT.drift);
    const issue = f.open.get(driftIssueMarker("shop/dev"))!;
    expect(issue.body).toContain(URN);
    expect(issue.body).toContain("visibilityTimeoutSeconds");

    // The same finding leaves it alone; a changed one edits it.
    await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir));
    const changed: DriftDoc = { records: [{ ...DRIFTED.records![0]!, attributes: [{ path: "delaySeconds" }] }] };
    setChantProductForTests(fakeChant({ "shop/dev": changed }).api);
    await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir));

    setChantProductForTests(fakeChant({ "shop/dev": CLEAN }).api);
    expect(await drift(["shop/dev", "--forge", "forgejo"], false, FALLBACK_EXIT, io(dir))).toBe(FALLBACK_EXIT.done);
    expect(f.actions).toEqual(["opened 1", "updated 1", "closed 1"]);
  });

  it("exits failed when a read cannot run, and maps --op back to its stack", async () => {
    const chant = fakeChant({ "shop/dev": "fail" });
    setChantProductForTests(chant.api);
    expect(await drift(["--op", driftOpName("shop/dev")], false, FALLBACK_EXIT, io(repo(YML)))).toBe(FALLBACK_EXIT.failed);
    expect(chant.calls).toHaveLength(1);
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
    expect(spec.options.beforeScript).toEqual([SNAPSHOTS_FETCH]);
  });

  it("has chant generate the jobs from the spec", async () => {
    const dir = repo(YML);
    const chant = fakeChant({});
    await writeDriftJobs(chant.api, "forgejo", parseConfig(YML).doc, PRODUCT_WORDS, FALLBACK_EXIT, io(dir));
    expect(chant.calls).toEqual([["run", "--generate", "forgejo", "--spec", DRIFT_SPEC_FILE, "--output", ".forgejo/workflows"]]);
    expect(readFileSync(join(dir, DRIFT_OP_FILE), "utf8")).toContain("plywood-drift-shop-prod");
  });
});
