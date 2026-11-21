import { describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { readVocabulary } from "../src/config/vocabulary";

const check = (text: string) => checkConfig(parseConfig(text));
const errors = (text: string) => check(text).filter((p) => p.severity === "error");
const warnings = (text: string) => check(text).filter((p) => p.severity === "warning");

const KEYS = `
forge: gitlab
forge_url: https://gitlab.acme.internal
ephemeral: { template: shop/dev, ttl: 48h }
runner: [self-hosted]
forge_environments: { "shop/prod-*": prod }
pass: { secrets: [TOKEN] }
policy: { path: policy }
approval_rules: { "shop/prod-*": { roles: [platform], count: 2 } }
respond: { drift: off, wave-refused: off, apply-failed: off }
reports: { bucket: s3://reports/plywood }
telemetry: { endpoint: https://otel.acme.internal, headers_secret: OTEL_HEADERS }
notify: { slack: SLACK_URL, teams: TEAMS_URL, webhook: HOOK_URL, webhook_key: HOOK_KEY, events: [waiting, failed], relay_key: RELAY }
review: { key_secret: MODEL_KEY }
agent: { key_secret: MODEL_KEY }
`;

const EARLIER = `
forge: { kind: gitlab, url: https://gitlab.acme.internal }
review_stacks: { template: shop/dev, ttl: 48h }
runners: [self-hosted]
environments: { "shop/prod-*": prod }
pass: [TOKEN]
policy: { rego: policy }
approval_rules: { "shop/prod-*": { role: platform, quorum: 2 } }
respond: { drift: none, wave_refused: off, apply_failed: off }
reports: { url: s3://reports/plywood }
telemetry: { endpoint: https://otel.acme.internal, headers_env: OTEL_HEADERS }
notify: { slack: { webhook: SLACK_URL }, teams: { webhook: TEAMS_URL }, webhook: { url: HOOK_URL, key: HOOK_KEY }, on: [wave-waiting, up-failed], relay: RELAY }
review: { key_env: MODEL_KEY }
agent: { key_env: MODEL_KEY }
`;

describe("chant's product vocabulary in plywood.yml", () => {
  it("reads the keys without an error and without a warning", () => {
    expect(errors(KEYS).map((p) => `${p.key} ${p.message}`)).toEqual([]);
    expect(warnings(KEYS).map((p) => p.key)).not.toContain("forge_url");
    expect(check(KEYS).filter((p) => /vocabulary/.test(p.message))).toEqual([]);
  });

  it("reads each key as the earlier spelling it replaces", () => {
    const a = parseConfig(KEYS).doc;
    const b = parseConfig(EARLIER).doc;
    for (const k of ["forge", "review_stacks", "runners", "forge_environments", "pass", "policy", "respond", "reports", "telemetry", "review", "agent"]) expect(a[k]).toEqual(b[k]);
    // roles: [platform] and role: platform are the same rule; toChantSettings below compares them.
    expect(a.approval_rules).toEqual({ "shop/prod-*": { roles: ["platform"], quorum: 2 } });
    expect(a.notify).toMatchObject({ slack: { webhook: "SLACK_URL" }, teams: { webhook: "TEAMS_URL" }, webhook: { url: "HOOK_URL", key: "HOOK_KEY" }, on: ["wave-waiting", "up-failed"], relay: "RELAY" });
    expect(toChantSettings(parseConfig(KEYS))).toEqual(toChantSettings(parseConfig(EARLIER)));
  });

  it("keeps reading the earlier spellings, with a warning for each that names the key", () => {
    expect(errors(EARLIER).map((p) => `${p.key} ${p.message}`)).toEqual([]);
    const named = warnings(EARLIER).map((p) => p.key);
    for (const k of ["review_stacks", "runners", "policy.rego", "respond.wave_refused", "reports.url", "telemetry.headers_env", "notify.on", "review.key_env"]) expect(named).toContain(k);
    expect(warnings(EARLIER).find((p) => p.key === "runners")?.message).toContain("runner");
  });

  it("refuses an earlier spelling set beside its key", () => {
    const text = "runners: [a]\nrunner: [b]\n";
    expect(errors(text).some((p) => p.key === "runners" && /both set/.test(p.message))).toBe(true);
    expect(errors('approval_rules:\n  "*": { quorum: 2, count: 2 }\n').map((p) => `${p.key} ${p.message}`)).toEqual(["approval_rules.*.quorum is count's older spelling; set count alone"]);
  });

  it("leaves a config with no vocabulary key as it was", () => {
    const doc = { gate: "always", stacks: { "shop/dev": { dir: "." } } };
    expect(readVocabulary(doc)).toEqual(doc);
  });

  it("reads a glob's name or { name, url } under environments as forge_environments, and leaves any other mapping there", () => {
    const read = readVocabulary({
      forge_environments: { "shop/prod-*": "prod" },
      environments: { "shop/dev": { name: "dev", url: "https://dev.example.com" }, "shop/prod-*": "other", prod: { targets: { shop: "live" } } },
    });
    expect(read.forge_environments).toEqual({ "shop/prod-*": "prod", "shop/dev": { name: "dev", url: "https://dev.example.com" } });
    expect(read.environments).toEqual({ prod: { targets: { shop: "live" } } });
    expect(readVocabulary({ environments: { "*": "production" } })).toEqual({ forge_environments: { "*": "production" } });
  });
});
