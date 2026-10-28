import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditArgv, auditMember, auditTable } from "../src/audit";
import { toChantSettings } from "../src/chant-config";
import { chantNotifyOf } from "../src/config/observe";
import { checkConfig, parseConfig } from "../src/config/index";
import { wavesSpec } from "../src/init/render";
import { CHANT_PASSTHROUGH } from "../src/stages";
import { telemetryEnv } from "../src/telemetry";

const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

describe("notify", () => {
  it("names variables only, and turns plywood's event words into chant's", () => {
    const doc = parseConfig("notify:\n  slack: { webhook: SLACK_WEBHOOK_URL }\n  webhook: { url: HOOK_URL, key: HOOK_KEY }\n  on: [wave-waiting, up-failed, drift]\n").doc;
    expect(chantNotifyOf(doc)).toEqual({ webhook: "HOOK_URL", key: "HOOK_KEY", slack: "SLACK_WEBHOOK_URL", events: ["waiting", "failed", "drift"] });
    expect(toChantSettings(parseConfig("notify: { teams: { webhook: TEAMS_URL } }")).pipeline.notify).toEqual({ teams: "TEAMS_URL" });
  });

  it("refuses a URL in place of a variable, an unsigned webhook, an unknown event and no channel", () => {
    expect(errors("notify: { slack: { webhook: https://hooks.slack.com/x } }")[0]!.key).toBe("notify.slack.webhook");
    expect(errors("notify: { webhook: { url: HOOK_URL } }").map((p) => p.key)).toEqual(["notify.webhook.key"]);
    expect(errors("notify: { slack: { webhook: S }, on: [deployed] }")[0]!.key).toBe("notify.on");
    expect(errors("notify: { on: [drift] }")[0]!.key).toBe("notify");
  });

  it("goes into the waves spec, where chant's op waves send it", () => {
    const spec = wavesSpec({ stacks: [{ key: "shop/dev", project: "shop", stack: "dev", dir: "." }], gate: "always", branch: "main", notify: { slack: "SLACK_WEBHOOK_URL" } });
    expect(spec.notify).toEqual({ slack: "SLACK_WEBHOOK_URL" });
  });
});

describe("telemetry", () => {
  const doc = (t: string) => parseConfig(t).doc;

  it("sets chant's OTEL variables from plywood.yml, and the job's own win", () => {
    expect(telemetryEnv(doc("telemetry: { endpoint: https://otel.acme.internal:4318/, headers_env: OTLP_H }"), { OTLP_H: "x-api-key=k" })).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.acme.internal:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "x-api-key=k",
      OTEL_SERVICE_NAME: "plywood",
    });
    expect(telemetryEnv(doc("telemetry: { endpoint: https://a:4318 }"), { OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318", OTEL_SERVICE_NAME: "ci" })).toEqual({});
    expect(telemetryEnv(doc("telemetry: { traces: false }"), {})).toEqual({ OTEL_TRACES_EXPORTER: "none" });
    expect(telemetryEnv(doc(""), {})).toEqual({});
  });

  it("refuses a credential in the endpoint", () => {
    expect(errors("telemetry: { endpoint: https://user:pw@otel.acme:4318 }")[0]!.key).toBe("telemetry.endpoint");
  });

  /**
   * chant's exporter reads plywood's variables: traces go to the loopback
   * URL with /v1/traces, under the plywood prefix. The bench run that sends a
   * trace to a loopback sink waits for epic-ready. Skipped on a chant without
   * `@intentius/chant/otlp` (the 0.124.54 pin).
   */
  it("points chant's exporter at a loopback sink with plywood's prefix", async (ctx) => {
    let otlp: Record<string, unknown> | undefined;
    try {
      // @ts-ignore: @intentius/chant/otlp is newer than the pin (chant#4555).
      otlp = (await import("@intentius/chant/otlp")) as Record<string, unknown>;
    } catch {
      otlp = undefined;
    }
    if (!otlp || typeof otlp.otlpFromEnv !== "function") return ctx.skip();
    const env = telemetryEnv(doc("telemetry: { endpoint: http://127.0.0.1:4318 }"), {});
    const config = (otlp.otlpFromEnv as (e: NodeJS.ProcessEnv, o: { prefix: string }) => { traces?: { url: string }; prefix: string })(env, { prefix: "plywood" });
    expect(config.traces?.url).toBe("http://127.0.0.1:4318/v1/traces");
    expect(config.prefix).toBe("plywood");
  });
});

describe("reports", () => {
  it("is chant's ci.reportUrl, and warns on schemes newer than the pin", () => {
    expect(toChantSettings(parseConfig("reports: { url: s3://acme-reports/plywood }")).ci.reportUrl).toBe("s3://acme-reports/plywood");
    expect(errors("reports: { url: https://x }")[0]!.key).toBe("reports.url");
    expect(checkConfig(parseConfig("reports: { url: gs://acme/plywood }"))).toEqual([expect.objectContaining({ severity: "warning" })]);
  });
});

describe("plywood audit", () => {
  it("reads one chant ledger table, named in plywood's words", () => {
    expect(auditTable(undefined)).toBe("gates");
    expect(auditTable("updates")).toBe("applies");
    expect(auditTable("review-stacks")).toBe("pr_envs");
    expect(auditTable("deploys")).toBe("deploys");
    expect(auditArgv(["--since", "7d"], false)).toEqual(["ledger", "gates", "--since", "7d"]);
    expect(auditArgv(["updates", "--stack", "shop/prod-east", "--where", "result=failed"], true)).toEqual(["ledger", "applies", "--member", "shop", "--where", "result=failed", "--json"]);
    expect(auditArgv(["--stack", "prod"], false)).toEqual({ error: expect.stringContaining("project/stack") });
    expect(auditArgv(["runs", "gates"], false)).toEqual({ error: expect.stringContaining("one table") });
    expect(auditMember("Shop App/dev")).toBe("shop-app");
  });

  it("passes chant query and chant ledger through with plywood's words", () => {
    expect(CHANT_PASSTHROUGH).toEqual(expect.arrayContaining(["query", "ledger"]));
  });
});

describe("the dashboard preset", () => {
  it("is Grafana JSON over plywood-prefixed span attributes", () => {
    const d = JSON.parse(readFileSync(join(import.meta.dirname, "../presets/dashboards/plywood.json"), "utf8"));
    expect(d.uid).toBe("plywood-runs");
    const queries = d.panels.flatMap((p: { targets: Array<{ query: string }> }) => p.targets.map((t) => t.query)).join("\n");
    expect(queries).toContain("span.plywood.stack");
    expect(queries).not.toContain("span.chant.");
  });
});
