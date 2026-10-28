import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConfig, parseConfig } from "../../packages/plywood/src/config/index";
import { claimsProblems } from "../claims";
import { harness, type Scenario } from "../harness";
import { dryRun, lint } from "../main";
import { BASE_OVERLAYS_DIR, SCENARIOS_DIR, SCENARIO_CLAIMS, lintPlywoodScenario, readScenario, scenarioFiles } from "../scenarios";

const ROOT = join(import.meta.dirname, "..", "..");

describe("plywood's scenarios", () => {
  it("are plywood#22's plunge claims, one scenario each", () => {
    expect(Object.keys(scenarioFiles()).sort()).toEqual(["pw-adopt", "pw-disjoint", "pw-moved-plan"]);
    expect(SCENARIO_CLAIMS).toEqual({ "pw-disjoint": "plunge/disjoint-updates", "pw-moved-plan": "plunge/saved-plan-moved", "pw-adopt": "plunge/adopt-stock-stack" });
  });

  it("each pass plywood's lint, with a BREAK arm that sets BREAK=1", () => {
    for (const [id, file] of Object.entries(scenarioFiles())) {
      const s = readScenario(id);
      expect(lintPlywoodScenario(file, s), id).toEqual([]);
      expect(s.break.env.BREAK).toBe("1");
      expect(s.break.note, id).toBeTruthy();
    }
  });

  it("pass the harness's own lint when the installed chant has it", async () => {
    const h = await harness();
    if (!h) return; // the pinned chant has no harness; `just chant-local` runs this
    for (const [id, file] of Object.entries(scenarioFiles())) expect(h.lintScenario(JSON.parse(readFileSync(file, "utf8"))), id).toEqual([]);
  });

  it("lint clean through `just e2e lint` on the pinned chant", async () => {
    const out: string[] = [];
    expect(await lint(undefined, (l) => void out.push(l))).toBe(0);
    expect(out).toHaveLength(3);
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
    expect(readScenario("pw-adopt").break.env.PLYWOOD_E2E_BASE_OVERLAY).toBe("adopt-bare-bucket");
    expect(readScenario("pw-moved-plan").break.env.PLYWOOD_E2E_RETENTION).toBe("3600");
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

  it("puts dev and staging on plunge's store, the prod stacks on stock S3, and the reports where every scenario reads them", () => {
    expect(base).toMatch(/shop\/dev:\n {4}dir: \.\n {4}backend: plunge\+s3:\/\/plywood-tutorial-plunge\?/);
    expect(base).toMatch(/shop\/staging:\n {4}dir: \.\n {4}backend: plunge\+s3:\/\/plywood-tutorial-plunge\?/);
    expect(base).toMatch(/shop\/prod-us:\n {4}dir: \.\n {4}backend: s3:\/\/plywood-tutorial-state\?/);
    for (const id of Object.keys(scenarioFiles())) expect(base).toContain(`url: ${readScenario(id).reportUrl}`);
    expect(base).not.toMatch(/^locks:/m);
  });

  it("differs in pw-adopt's BREAK base only in staging's bucket", () => {
    const brk = (JSON.parse(readFileSync(join(BASE_OVERLAYS_DIR, "adopt-bare-bucket.json"), "utf8")) as { files: Record<string, string> }).files["plywood.yml"]!;
    const a = base.split("\n");
    const b = brk.split("\n");
    expect(b.length).toBe(a.length);
    const diff = a.map((l, i) => (l === b[i] ? null : i)).filter((i) => i !== null);
    expect(diff).toHaveLength(1);
    expect(b[diff[0]!]).toContain("plunge+s3://plywood-tutorial-bare?");
    expect(a[diff[0]! - 2]).toBe("  shop/staging:");
    expect(checkConfig(parseConfig(brk)).filter((p) => p.severity === "error")).toEqual([]);
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
