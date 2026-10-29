import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConfig, parseConfig } from "../../packages/plywood/src/config/index";
import { ADOPT_OP_FILE, adoptOpFile } from "../../packages/plywood/src/init/adopt";
import { BUCKETS, FLOCI_NET, plungeStoreUrl, s3BackendUrl } from "../bench";
import { claimsProblems } from "../claims";
import { harness, type Scenario } from "../harness";
import { dryRun, jobLogCopies, lint } from "../main";
import { BASE_OVERLAYS_DIR, SCENARIOS_DIR, SCENARIO_CLAIMS, lintPlywoodScenario, readScenario, scenarioFiles } from "../scenarios";

const ROOT = join(import.meta.dirname, "..", "..");

describe("plywood's scenarios", () => {
  it("are plywood#22's claims, one scenario each, pulumi-cloud/token aside, and plywood#39's", () => {
    expect(Object.keys(scenarioFiles()).sort()).toEqual(["pw-action", "pw-adopt", "pw-canary", "pw-disjoint", "pw-drift", "pw-moved-plan", "pw-moved-preview", "pw-one-note"]);
    expect(SCENARIO_CLAIMS).toEqual({
      "pw-disjoint": "plunge/disjoint-updates",
      "pw-moved-plan": "plunge/saved-plan-moved",
      "pw-adopt": "plunge/adopt-stock-stack",
      "pw-one-note": "preview/one-note",
      "pw-moved-preview": "gate/moved-preview",
      "pw-canary": "wave/canary",
      "pw-drift": "drift/issue",
      "pw-action": "action/gated-replace",
    });
  });

  it("each pass plywood's lint, with a BREAK arm that sets BREAK=1", () => {
    for (const [id, file] of Object.entries(scenarioFiles())) {
      const s = readScenario(id);
      expect(lintPlywoodScenario(file, s), id).toEqual([]);
      expect(s.break.env.BREAK).toBe("1");
      expect(s.break.note, id).toBeTruthy();
    }
  });

  it("pass the harness's own lint", async () => {
    const h = await harness();
    for (const [id, file] of Object.entries(scenarioFiles())) expect(h.lintScenario(JSON.parse(readFileSync(file, "utf8"))), id).toEqual([]);
  });

  it("lint clean through `just e2e lint`", async () => {
    const out: string[] = [];
    expect(await lint(await harness(), (l) => void out.push(l))).toBe(0);
    expect(out).toHaveLength(8);
  });

  it("catch a scenario that drifted from plywood's rules", () => {
    const s = readScenario("pw-moved-plan");
    const bad: Scenario = {
      ...s,
      claim: "plunge/other",
      reportUrl: "s3://elsewhere/x",
      steps: [
        ...s.steps,
        { id: "x", do: "out-of-band", command: ["plywood-e2e", "teardown"] },
        { id: "y", do: "out-of-band", command: ["plywood-e2e", "plunge-up", "dev", "k=${NO_DEFAULT}"], expect: [{ exit: 0 }] },
        { id: "z", do: "open", branch: "b", overlay: "missing-overlay", title: "t" },
      ],
      break: { env: { BREAK: "1", PLYWOOD_E2E_BASE_OVERLAY: "missing-base" } },
    };
    const found = lintPlywoodScenario(join(SCENARIOS_DIR, "pw-moved-plan.json"), bad).join("\n");
    for (const w of ["claim plunge/other", "reportUrl", "teardown", "expects no exit code", "${NO_DEFAULT}", "missing-overlay", "missing-base"]) expect(found).toContain(w);
  });

  it("break pw-disjoint with a stack lock and pw-adopt with a bucket plunge's store refuses", () => {
    expect(readScenario("pw-disjoint").break.env.PLYWOOD_E2E_BASE_OVERLAY).toBe("stack-grain");
    expect(readScenario("pw-adopt").break.env.PLYWOOD_E2E_ADOPT).toBe("adopt-bare-bucket");
    expect(readScenario("pw-moved-plan").break.env.PLYWOOD_E2E_RETENTION).toBe("3600");
  });

  it("break the stock claims through the subject each checks", () => {
    expect(readScenario("pw-one-note").break.overlay).toBe("prod-eu-events-workers");
    expect(readScenario("pw-moved-preview").break.env.PLYWOOD_E2E_REPUSH).toBe("notes-line");
    expect(readScenario("pw-canary").break.env.PLYWOOD_E2E_WAVES).toBe("stock-one-wave");
    expect(readScenario("pw-drift").break.env.PLYWOOD_E2E_DRIFT_RETENTION).toBe("7200");
    expect(readScenario("pw-action").break.env.PLYWOOD_E2E_ROTATE_MARKER).toBe("rotate-marker-second");
    const lines = dryRun(readScenario("pw-canary")).join("\n");
    expect(lines).toContain("configure stock-first;");
    expect(lines).toContain("configure stock-one-wave;");
  });

  it("catch a configure or push step whose overlay is missing in either arm", () => {
    const s = readScenario("pw-canary");
    const bad: Scenario = {
      ...s,
      steps: [...s.steps, { id: "x", do: "out-of-band", command: ["plywood-e2e", "push", "e2e/canary-events", "${PLYWOOD_E2E_P:-no-such-overlay}"], expect: [{ exit: 0 }] }],
      break: { env: { BREAK: "1", PLYWOOD_E2E_WAVES: "no-such-base" } },
    };
    const found = lintPlywoodScenario(join(SCENARIOS_DIR, "pw-canary.json"), bad).join("\n");
    expect(found).toContain("base overlay no-such-base");
    expect(found).toContain("overlay no-such-overlay");
  });

  it("dry-run both arms, the BREAK arm's values in place, touching nothing", () => {
    const lines = dryRun(readScenario("pw-moved-plan")).join("\n");
    expect(lines).toContain("plain arm:");
    expect(lines).toContain("break arm (BREAK=1 PLYWOOD_E2E_RETENTION=3600):");
    expect(lines).toContain("corpus:eventsRetentionSeconds=1800");
    expect(lines).toContain("corpus:eventsRetentionSeconds=3600");
    expect(lines).toContain("e2e/moved-events-break");
    expect(dryRun(readScenario("pw-disjoint")).join("\n")).toContain("base: lay stack-grain over main");
  });
});

describe("the shop repository's plywood.yml", () => {
  const base = readFileSync(join(SCENARIOS_DIR, "base", "plywood.yml"), "utf8");

  it("passes plywood's config check", () => {
    expect(checkConfig(parseConfig(base)).filter((p) => p.severity === "error")).toEqual([]);
  });

  it("puts dev on plunge's store, staging stock in the store's bucket, the prod stacks on stock S3, and the reports where every scenario reads them", () => {
    expect(base).toMatch(/shop\/dev:\n {4}dir: \.\n {4}backend: plunge\+s3:\/\/plywood-tutorial-plunge\?/);
    expect(base).toMatch(/shop\/staging:\n {4}dir: \.\n {4}backend: s3:\/\/plywood-tutorial-plunge\?/);
    expect(base).toContain(`backend: ${s3BackendUrl(BUCKETS.records, FLOCI_NET)}\n`);
    expect(base).toMatch(/shop\/prod-us:\n {4}dir: \.\n {4}backend: s3:\/\/plywood-tutorial-state\?/);
    for (const id of Object.keys(scenarioFiles())) expect(base).toContain(`url: ${readScenario(id).reportUrl}`);
    expect(base).not.toMatch(/^locks:/m);
  });

  const files = (name: string) => (JSON.parse(readFileSync(join(BASE_OVERLAYS_DIR, `${name}.json`), "utf8")) as { files: Record<string, string> }).files;

  it("moves staging onto plunge's records in staging-on-plunge, and differs from the base in that line only", () => {
    const after = files("staging-on-plunge")["plywood.yml"]!;
    const a = base.split("\n");
    const b = after.split("\n");
    expect(b.length).toBe(a.length);
    const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
    expect(diff).toHaveLength(1);
    expect(b[diff[0]!]).toBe(`    backend: ${plungeStoreUrl(BUCKETS.records, FLOCI_NET)}`);
    expect(a[diff[0]! - 2]).toBe("  shop/staging:");
    expect(checkConfig(parseConfig(after)).filter((p) => p.severity === "error")).toEqual([]);
  });

  it("lays the adopt Op plywood init writes for staging, on the record store or, for the BREAK arm, the bare bucket", () => {
    const op = (bucket: string) => adoptOpFile([{ member: "shop", dir: ".", stack: "staging", url: plungeStoreUrl(bucket, FLOCI_NET) }]);
    expect(files("adopt-staging")).toEqual({ [ADOPT_OP_FILE]: op(BUCKETS.records) });
    expect(files("adopt-bare-bucket")).toEqual({ [ADOPT_OP_FILE]: op(BUCKETS.bare) });
  });
});

describe("pw-adopt", () => {
  const s = readScenario("pw-adopt");
  const ids = s.steps.map((x) => x.id);
  const command = (id: string) => (s.steps.find((x) => x.id === id) as { command: string[] }).command;

  it("lays the adopt Op, adopts staging, then declares it on plunge before the pull request plans it", () => {
    expect(command("adopt-op")).toEqual(["plywood-e2e", "configure", "${PLYWOOD_E2E_ADOPT:-adopt-staging}"]);
    expect(command("on-plunge")).toEqual(["plywood-e2e", "configure", "staging-on-plunge"]);
    expect(ids.indexOf("adopt-op")).toBeLessThan(ids.indexOf("adopt-preview"));
    expect(ids.indexOf("adopt")).toBeLessThan(ids.indexOf("on-plunge"));
    expect(ids.indexOf("on-plunge")).toBeLessThan(ids.indexOf("events"));
  });

  it("points the BREAK arm's adopt Op at the bare bucket, and lays no base overlay over main", () => {
    expect(s.break.env).toEqual({ BREAK: "1", PLYWOOD_E2E_ADOPT: "adopt-bare-bucket" });
  });
});

describe("the claims page data", () => {
  it("is an e2e-claims/v1 document with only rendered rows", () => {
    const doc = JSON.parse(readFileSync(join(ROOT, "site", "src", "data", "claims.json"), "utf8"));
    expect(doc.$schema).toBe("https://intentius.io/chant/schemas/e2e-harness/e2e-claims/v1/e2e-claims.schema.json");
    expect(claimsProblems(doc, SCENARIO_CLAIMS)).toEqual([]);
  });

  it("refuses a row with no run commit or date, a scan that was not CLEAN, or a claim its scenario does not record", () => {
    const row = { scenario: "pw-disjoint", claim: "plunge/disjoint-updates", productCommit: "a".repeat(40), date: "2026-10-28", safeRun: "CLEAN" };
    expect(claimsProblems({ product: "plywood", rows: [row] }, SCENARIO_CLAIMS)).toEqual([]);
    const found = claimsProblems({ product: "plywood", rows: [{ ...row, productCommit: "", date: "" }, { ...row, safeRun: "REAL-CLOUD" }, { ...row, claim: "x" }, { ...row, scenario: "nope" }] }, SCENARIO_CLAIMS).join("\n");
    for (const w of ["no run commit", "no run date", "not CLEAN", "claim x", "no plywood scenario nope"]) expect(found).toContain(w);
  });
});

describe("the job-log collector", () => {
  it("copies the compressed and the uncompressed logs, each as task<id>.log", () => {
    const listed = ["/data/gitea/actions_log/tutor/shop/1f/31.log.zst", "/data/gitea/actions_log/tutor/shop/20/32.log", "/data/gitea/actions_log/tutor/shop/20/notes.txt", ""];
    expect(jobLogCopies(listed, "/out")).toEqual([
      { from: "/data/gitea/actions_log/tutor/shop/1f/31.log.zst", to: "/out/task31.log", zst: true },
      { from: "/data/gitea/actions_log/tutor/shop/20/32.log", to: "/out/task32.log", zst: false },
    ]);
  });
});
