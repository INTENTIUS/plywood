import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { targetGlobMatch } from "@intentius/chant/ci-identity";
import { toChantSettings } from "../src/chant-config";
import { stackIdentities } from "../src/config/identity";
import { checkConfig, parseConfig } from "../src/config/index";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { configIdentities, forgeCheck, identityRows } from "../src/identities";
import type { StageIo } from "../src/stages";

const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

const CLOUD_YML = [
  "pulumi_cloud: { org: acme, api_url: http://127.0.0.1:1/ }",
  "stacks:",
  "  shop/dev: { dir: infra }",
  "  shop/prod-east: { dir: infra }",
  "identity:",
  "  preview: { pulumi: team:previewers, aws: arn:aws:iam::111111111111:role/pulumi-preview }",
  "  up: { pulumi: team:deployers, aws: arn:aws:iam::111111111111:role/pulumi-up }",
  "  aws: { region: eu-west-1 }",
  "  stacks:",
  '    "shop/prod-*":',
  "      preview: { pulumi: team:prod-previewers }",
  "      up: { pulumi: team:prod-deployers }",
  "      environments: [production]",
  "",
].join("\n");

function io(cwd: string) {
  const out: string[] = [];
  const err: string[] = [];
  const stageIo: StageIo = { out: (s) => out.push(s), err: (s) => err.push(s), cwd, env: {} };
  return { stageIo, out, err };
}

describe("identity in plywood.yml", () => {
  it("renders chant's ci.identity: stack globs first, then the every-stack pair, preview as plan and up as apply", () => {
    expect(errors(CLOUD_YML)).toEqual([]);
    expect(toChantSettings(parseConfig(CLOUD_YML)).ci.identity).toEqual({
      cloud: {
        aws: { region: "eu-west-1", rules: [{ plan: "arn:aws:iam::111111111111:role/pulumi-preview", apply: "arn:aws:iam::111111111111:role/pulumi-up" }] },
        pulumi: {
          organization: "acme",
          apiUrl: "http://127.0.0.1:1",
          rules: [
            { environments: ["production"], targets: ["shop/prod-*"], plan: "team:prod-previewers", apply: "team:prod-deployers" },
            { plan: "team:previewers", apply: "team:deployers" },
          ],
        },
      },
    });
  });

  it("refuses one identity for both stages, a stage missing its pair, a token chant cannot trade, and pulumi without an org", () => {
    expect(errors("identity:\n  preview: { aws: arn:a }\n  up: { aws: arn:a }\n")[0]!.message).toContain("one identity for preview and up");
    expect(errors("identity:\n  preview: { aws: arn:a }\n")[0]!.key).toBe("identity.up.aws");
    expect(errors("pulumi_cloud: { org: acme }\nidentity:\n  preview: { pulumi: deployers }\n  up: { pulumi: team:x }\n")[0]!.key).toBe("identity.preview.pulumi");
    expect(errors("identity:\n  preview: { pulumi: team:a }\n  up: { pulumi: team:b }\n").map((p) => p.key)).toEqual(["pulumi_cloud.org"]);
    expect(errors("identity:\n  preview: { gcp: a@x }\n  up: { gcp: b@x }\n").map((p) => p.key)).toEqual(["identity.gcp.provider"]);
    expect(errors("identity: { preview: { s3: x } }")[0]!.key).toBe("identity.preview.s3");
  });

  it("warns that pulumi_cloud without identities means long-lived tokens", () => {
    const problems = checkConfig(parseConfig("pulumi_cloud: { org: acme }"));
    expect(problems).toEqual([expect.objectContaining({ key: "pulumi_cloud", severity: "warning" })]);
  });

  it("gives each stack its identities as chant's first-match reads them", () => {
    const doc = parseConfig(CLOUD_YML).doc;
    expect(stackIdentities(doc, "shop/prod-east", "production", targetGlobMatch).pulumi).toMatchObject({ preview: "team:prod-previewers", up: "team:prod-deployers" });
    expect(stackIdentities(doc, "shop/prod-east", "staging", targetGlobMatch).pulumi).toMatchObject({ preview: "team:previewers" });
    expect(stackIdentities(doc, "shop/dev", "production", targetGlobMatch).aws?.up).toBe("arn:aws:iam::111111111111:role/pulumi-up");
  });
});

describe("plywood config identities and forge check", () => {
  it("prints each stack's identities and the rendered block with --json", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-identity-"));
    writeFileSync(join(dir, "plywood.yml"), CLOUD_YML);
    const t = io(dir);
    expect(configIdentities(["--env", "production"], true, FALLBACK_EXIT, t.stageIo)).toBe(0);
    const env = JSON.parse(t.out[0]!);
    expect(env.identity.cloud.pulumi.organization).toBe("acme");
    expect(identityRows(parseConfig(CLOUD_YML), "production").filter((r) => r.cloud === "pulumi").map((r) => [r.stack, r.up])).toEqual([
      ["shop/dev", "team:deployers"],
      ["shop/prod-east", "team:prod-deployers"],
    ]);
    const text = io(dir);
    expect(configIdentities([], false, FALLBACK_EXIT, text.stageIo)).toBe(0);
    expect(text.out.join("\n")).toContain("ESC environments open with each job's own token");
  });

  it("forge check says chant has no read for it yet and exits failed", () => {
    const t = io(tmpdir());
    expect(forgeCheck(["check"], false, FALLBACK_EXIT, t.stageIo)).toBe(FALLBACK_EXIT.failed);
    expect(t.err.join("\n")).toContain("chant core");
  });
});

/**
 * Pulumi Cloud's token exchange, faked on loopback: chant's trade script
 * (chant#4549) trades a fake forge OIDC token for the preview token in the
 * plan job's spec and the up token in the apply job's. Every request goes
 * to the fake, and none to api.pulumi.com. Skipped on a chant whose
 * ci-identity has no Pulumi Cloud trade (the 0.124.54 pin).
 */
describe("the Pulumi Cloud trade against a loopback fake", async () => {
  // @ts-ignore: resolveCloudIdentity, TRADE_JS and IDENTITY_CLOUDS with pulumi are newer than the pin (chant#4549).
  const chant = (await import("@intentius/chant/ci-identity")) as Record<string, unknown>;
  const hasPulumi = Array.isArray(chant.IDENTITY_CLOUDS) && (chant.IDENTITY_CLOUDS as string[]).includes("pulumi") && typeof chant.TRADE_JS === "string";

  it.skipIf(!hasPulumi)("gives the preview job the preview token and the update job the up token", async () => {
    const requests: Array<{ host: string; path: string; form?: URLSearchParams }> = [];
    const body = (req: IncomingMessage) => new Promise<string>((ok) => {
      let s = "";
      req.on("data", (c) => (s += c));
      req.on("end", () => ok(s));
    });
    const server = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/oidc") {
        requests.push({ host: req.headers.host ?? "", path: url.pathname });
        res.end(JSON.stringify({ value: "fake-forge-oidc-token" }));
        return;
      }
      if (url.pathname === "/api/oauth/token" && req.method === "POST") {
        const form = new URLSearchParams(await body(req));
        requests.push({ host: req.headers.host ?? "", path: url.pathname, form });
        res.end(JSON.stringify({ access_token: `pul-${(form.get("scope") ?? "").replace(/[^a-z0-9]/gi, "-")}` }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const yml = `pulumi_cloud: { org: acme, api_url: ${base} }\nidentity:\n  preview: { pulumi: team:previewers }\n  up: { pulumi: team:deployers }\n`;
      const decl = toChantSettings(parseConfig(yml)).ci.identity!.cloud;
      const resolve = chant.resolveCloudIdentity as (d: unknown, env: string, member?: string) => { plan: Record<string, unknown>; apply: Record<string, unknown> };
      const pipeline = resolve(decl, "production", "shop");
      const trade = async (spec: Record<string, unknown>): Promise<string> => {
        const out = join(mkdtempSync(join(tmpdir(), "plywood-trade-")), "env");
        writeFileSync(out, "");
        await new Promise<void>((ok, fail) =>
          execFile(process.execPath, ["-e", chant.TRADE_JS as string, out, "github-env"], {
            cwd: "/",
            env: { PATH: process.env.PATH ?? "", CHANT_CLOUD_TRADE: JSON.stringify(spec), ACTIONS_ID_TOKEN_REQUEST_URL: `${base}/oidc`, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "fake-request-token" },
          }, (e) => (e ? fail(e) : ok())),
        );
        return readFileSync(out, "utf8");
      };
      expect(await trade(pipeline.plan)).toContain("PULUMI_ACCESS_TOKEN=pul-team-previewers");
      const up = await trade(pipeline.apply);
      expect(up).toContain("PULUMI_ACCESS_TOKEN=pul-team-deployers");
      expect(up).toContain(`PULUMI_BACKEND_URL=${base}`);
      const exchanges = requests.filter((r) => r.path === "/api/oauth/token");
      expect(exchanges.map((r) => r.form!.get("subject_token"))).toEqual(["fake-forge-oidc-token", "fake-forge-oidc-token"]);
      expect(exchanges.map((r) => r.form!.get("audience"))).toEqual(["urn:pulumi:org:acme", "urn:pulumi:org:acme"]);
      expect(requests.every((r) => r.host.startsWith("127.0.0.1:"))).toBe(true);
      expect(requests.some((r) => r.host.includes("api.pulumi.com"))).toBe(false);
    } finally {
      await new Promise<void>((ok) => server.close(() => ok()));
    }
  });
});
