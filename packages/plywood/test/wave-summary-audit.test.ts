/**
 * The refused-wave summary and the audit record, both chant's: plywood maps
 * `respond.wave_refused: summary` and `agent.wave-refused.*` onto chant's
 * `waveSummary` (chant#5335), and writes `audit.jsonl` and the neutral
 * estate files in chant's formats (chant#5336).
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waveSummaryJobEnv } from "@intentius/chant/ci-respond-summary";
import * as gateAudit from "@intentius/chant/lifecycle/gate-audit";
import * as reportStore from "@intentius/chant/report-store";
import { audit } from "../src/audit";
import { setChantAuditRecordForTests } from "../src/audit-record";
import { toChantSettings } from "../src/chant-config";
import { setChantProductForTests, type ProductPipelineOptions } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { estate, setChantEstateForTests } from "../src/estate";
import { EXIT } from "../src/exit-codes";
import { ci, respondArgv, respondOptions, type StageIo } from "../src/stages";
import { CHANT_DEFAULTS } from "./chant-defaults";

const problems = (yml: string) => checkConfig(parseConfig(yml)).map((p) => `${p.severity} ${p.key}`);
const SUMMARY = "respond:\n  wave_refused: summary\n";

function dir(files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "plywood-summary-"));
  mkdirSync(join(d, ".git"));
  for (const [n, b] of Object.entries(files)) writeFileSync(join(d, n), b);
  return d;
}

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stageIo: StageIo = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: {} };
  return { stageIo, out, err };
}

afterEach(() => {
  setChantProductForTests("reset");
  setChantEstateForTests("reset");
  setChantAuditRecordForTests("reset");
});

describe("respond.wave_refused: summary and agent.wave-refused", () => {
  it("accepts summary, and the vocabulary's spelling of the key", () => {
    expect(problems(SUMMARY)).toEqual([]);
    expect(problems("respond:\n  wave-refused: summary\n")).toEqual([]);
    expect(problems("respond:\n  wave_refused: summary\n  wave-refused: diff\n")).toContain("error respond.wave-refused");
    expect(problems("respond:\n  wave_refused: loud\n")).toContain("error respond.wave_refused");
    expect(toChantSettings(parseConfig("respond:\n  wave-refused: summary\n")).pipeline.respond).toEqual({ "wave-refused": "summary" });
  });

  it("maps each agent.wave-refused key onto chant's waveSummary field", () => {
    const yml = `${SUMMARY}agent:\n  wave-refused:\n    command: my-model --print\n    key_secret: SUMMARY_KEY\n    timeout: 5\n    max_runs: 20\n    max_cost_usd: 1.5\n`;
    expect(problems(yml)).toEqual([]);
    expect(toChantSettings(parseConfig(yml)).pipeline.waveSummary).toEqual({ command: "my-model --print", keyEnv: "SUMMARY_KEY", timeout: 5, maxRuns: 20, maxCostUsd: 1.5 });
  });

  it("turns on with the summary alone, and by default turns nothing on", () => {
    expect(toChantSettings(parseConfig(SUMMARY)).pipeline.waveSummary).toEqual({});
    for (const yml of ["stacks:\n  shop/dev: {}\n", "respond:\n  wave_refused: diff\n", "respond:\n  wave_refused: off\n"]) {
      const p = toChantSettings(parseConfig(yml)).pipeline;
      expect(p.waveSummary).toBeUndefined();
      expect(respondOptions(p, []).options.waveSummary).toBeUndefined();
    }
  });

  it("checks the keys, and reads them only with the summary on", () => {
    expect(problems("agent:\n  wave-refused: { command: x }\n")).toContain("error agent.wave-refused");
    expect(problems(`${SUMMARY}agent:\n  wave-refused: { model: x }\n`)).toContain("error agent.wave-refused.model");
    expect(problems(`${SUMMARY}agent:\n  wave-refused: { key_secret: not-a-name }\n`)).toContain("error agent.wave-refused.key_secret");
    expect(problems(`${SUMMARY}agent:\n  wave-refused: { timeout: 0 }\n`)).toContain("error agent.wave-refused.timeout");
    expect(problems(`${SUMMARY}agent:\n  wave-refused: { max_runs: 1.5 }\n`)).toContain("error agent.wave-refused.max_runs");
    expect(problems(`${SUMMARY}agent:\n  wave-refused: { max_cost_usd: 0 }\n`)).toContain("error agent.wave-refused.max_cost_usd");
    // The summary starts no agent job.
    expect(problems(`${SUMMARY}agent:\n  wave-refused: { max_runs: 3 }\n`)).toEqual([]);
  });

  it("hands chant waveSummary and --respond wave-refused=summary, and chant's jobs carry the model's variables", async () => {
    const seen: ProductPipelineOptions[] = [];
    const calls: string[][] = [];
    setChantProductForTests({
      assertProductWords: (w) => w as never,
      productPipelineJobs: (_f, _e, options) => {
        seen.push(options);
        return { words: options.words as never, plan: { jobName: "plan", command: "plan" }, post: { command: "post" }, comments: {} } as never;
      },
      approveLine: () => "",
      ...CHANT_DEFAULTS,
      runChantInProcess: async (argv) => {
        calls.push(argv);
        const out = argv.indexOf("--output");
        if (argv[0] === "build" && out >= 0) {
          mkdirSync(join(argv[out + 1]!, ".."), { recursive: true });
          writeFileSync(argv[out + 1]!, "jobs: {}\n");
        }
        return 0;
      },
    });
    const yml = `stacks:\n  shop/dev: {}\n${SUMMARY}agent:\n  wave-refused: { key_secret: SUMMARY_KEY, max_runs: 4 }\n`;
    const t = io(dir({ "plywood.yml": yml }));
    expect(await ci(["--forge", "github"], false, EXIT, t.stageIo)).toBe(0);
    expect(seen[0]!.respond).toEqual({ "wave-refused": "summary" });
    expect(seen[0]!.waveSummary).toEqual({ keyEnv: "SUMMARY_KEY", maxRuns: 4 });
    expect(calls[0]).toEqual(expect.arrayContaining(["--respond", "wave-refused=summary"]));
    // chant's job variables for those settings.
    expect(waveSummaryJobEnv("github", "summary", seen[0]!.waveSummary)).toMatchObject({ SUMMARY_KEY: "${{ secrets.SUMMARY_KEY }}", CHANT_WAVE_SUMMARY_MAX_RUNS: "4" });
    expect(waveSummaryJobEnv("github", "diff", seen[0]!.waveSummary)).toEqual({});
  });

  it("puts nothing on the build line at the defaults", () => {
    expect(respondArgv({ "wave-refused": "diff" }, undefined)).toEqual([]);
  });
});

describe("reports.bucket", () => {
  it("is chant's ci.reportUrl, and reports.url is read as the same bucket", () => {
    expect(toChantSettings(parseConfig("reports: { bucket: s3://acme/plywood }")).ci.reportUrl).toBe("s3://acme/plywood");
    expect(toChantSettings(parseConfig("reports: { url: s3://acme/plywood }")).ci.reportUrl).toBe("s3://acme/plywood");
    expect(problems("reports: { bucket: gs://acme/p }")).toEqual([]);
    expect(problems("reports: { bucket: https://x }")).toContain("error reports.bucket");
    expect(problems("reports: { bucket: s3://a/b, url: s3://a/b }")).toContain("error reports.url");
    expect(problems("reports: {}")).toContain("error reports.url");
  });
});

const D = "sha256:" + "a".repeat(64);
const pending = { version: 1, kind: "pending", op: "pulumi-up", gate: "wave-1", timestamp: "2026-11-01T09:00:00.000Z", expiresAt: "2026-11-08T09:00:00.000Z", planDigest: D, runId: "7" };
const approval = { version: 1, op: "pulumi-up", gate: "wave-1", resolvedBy: "alex", timestamp: "2026-11-01T10:00:00.000Z", planDigest: D };

function stubGateAudit() {
  setChantAuditRecordForTests({
    store: reportStore as never,
    gate: {
      deriveGateAudit: gateAudit.deriveGateAudit as never,
      readGateAuditLedgers: gateAudit.readGateAuditLedgers as never,
      gitGateLedgerPort: () => ({ read: async () => ({ pending: [pending], resolutions: [approval] }) }),
    },
  });
}

describe("the neutral files and audit.jsonl in the reports bucket", () => {
  function fakeEstate(calls: { built?: Record<string, unknown> }) {
    setChantEstateForTests({
      readEstateLedger: async () => ({ data: { gates: [{ op: "pulumi-up" }, { op: "pulumi-up" }] } }),
      buildLedgerEstate: (input: unknown) => {
        calls.built = input as unknown as Record<string, unknown>;
        return { estate: { totals: {} }, dora: {}, overdue: [] };
      },
      writeEstate: async () => ({ keys: ["estate/estate.json", "estate/dora.json"] }),
      parseReportUrl: async () => undefined,
      reportPut: () => async () => undefined,
      reportGet: () => async () => null,
    } as never);
  }

  it("asks chant for the neutral estate ids", async () => {
    const calls: { built?: Record<string, unknown> } = {};
    fakeEstate(calls);
    stubGateAudit();
    const root = dir({ "plywood.yml": "stacks:\n  shop/dev: {}\n" });
    await estate([], false, EXIT, io(root).stageIo);
    expect(calls.built).toMatchObject({ schemas: "neutral" });
  });

  it("writes chant.audit/v1 lines to <bucket>/audit.jsonl, adds only new ones, and plywood audit record reads them", async () => {
    stubGateAudit();
    const bucket = mkdtempSync(join(tmpdir(), "plywood-bucket-"));
    const root = dir({ "plywood.yml": `stacks:\n  shop/dev: {}\nreports:\n  bucket: file://${bucket}\n` });
    // The real report store over a file bucket; the estate tables and the gate ledger are stood in.
    const urls = await import("@intentius/chant/pr-report-url");
    setChantEstateForTests({
      readEstateLedger: async () => ({ data: { gates: [{ op: "pulumi-up" }] } }),
      buildLedgerEstate: () => ({ estate: { totals: {} }, dora: {}, overdue: [] }),
      writeEstate: async () => ({ keys: [] }),
      parseReportUrl: urls.parseReportUrl,
      reportPut: urls.reportPut,
      reportGet: urls.reportGet,
    } as never);
    const t = io(root);
    const code = await estate([], true, EXIT, t.stageIo);
    expect(t.err.join("\n")).toBe("");
    expect(code).toBe(0);
    const written = JSON.parse(t.out[0]!) as { audit: { key: string; added: number } };
    expect(written.audit).toEqual({ key: "audit.jsonl", added: 2 });
    const lines = readFileSync(join(bucket, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.schema, l.product, l.kind, l.what, l.who, l.digest])).toEqual([
      ["chant.audit/v1", "plywood", "approval-requested", "wave-1", null, D],
      ["chant.audit/v1", "plywood", "approved", "wave-1", "alex", D],
    ]);
    expect(lines[0].evidence.source).toBe("ledger");
    // A second run adds nothing.
    const again = io(root);
    await estate([], true, EXIT, again.stageIo);
    expect(JSON.parse(again.out[0]!).audit.added).toBe(0);
    // plywood audit record.
    const r = io(root);
    expect(await audit(["record"], true, EXIT, r.stageIo)).toBe(0);
    expect(r.out.map((l) => JSON.parse(l).kind)).toEqual(["approval-requested", "approved"]);
    const since = io(root);
    expect(await audit(["record", "--since", "2026-11-01T09:30:00Z"], true, EXIT, since.stageIo)).toBe(0);
    expect(since.out.map((l) => JSON.parse(l).kind)).toEqual(["approved"]);
  });

  it("reads a record whose lines another product wrote", async () => {
    const bucket = mkdtempSync(join(tmpdir(), "plywood-bucket-"));
    const own = reportStore.auditLinesFromLedger(gateAudit.deriveGateAudit({ ledgers: [{ op: "pulumi-up", lines: [{ record: pending as never }] }] }).entries, { product: "terragucci", project: "acme/infra" });
    writeFileSync(join(bucket, "audit.jsonl"), own.map((l) => JSON.stringify(l)).join("\n") + "\nnot json\n");
    const r = io(dir());
    expect(await audit(["record", "--bucket", `file://${bucket}`], true, EXIT, r.stageIo)).toBe(0);
    expect(JSON.parse(r.out[0]!)).toMatchObject({ schema: "chant.audit/v1", product: "terragucci", kind: "approval-requested" });
    expect(r.err.join("\n")).toBe("");
  });

  it("says so when the bucket has no record or none is named", async () => {
    const bucket = mkdtempSync(join(tmpdir(), "plywood-bucket-"));
    expect(await audit(["record", "--bucket", `file://${bucket}`], false, EXIT, io(dir()).stageIo)).toBe(EXIT.failed);
    const none = io(dir({ "plywood.yml": "stacks:\n  shop/dev: {}\n" }));
    expect(await audit(["record"], false, EXIT, none.stageIo)).toBe(EXIT.failed);
    expect(none.err.join("\n")).toContain("reports.bucket");
  });
});
