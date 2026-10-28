import { cpSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkConfig, parseConfig } from "../src/config/index";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { IMPORT_SOURCES, IMPORTERS, importLines, parseFrom, sourceOfFile, type ImportSource } from "../src/import/index";
import { parseInitArgs, runInit } from "../src/init";
import { findPulumiProjects, stacksOf, type Detected } from "../src/init/detect";
import { plywoodYml } from "../src/init/render";

const FIXTURES = join(import.meta.dirname, "fixtures/import");

function detectedAt(root: string): Detected {
  const projects = findPulumiProjects(root);
  return { root, projects, stacks: stacksOf(projects), defaultBranch: "main", pulumiActions: [] } as Detected;
}

/** The settings each fixture cannot carry, by file and name. */
const UNSUPPORTED: Record<ImportSource, string[]> = {
  "pulumi-actions": [".github/workflows/pulumi.yml jobs.preview.steps[1].with.refresh", ".github/workflows/pulumi.yml jobs.up.steps[1].with.target"],
  deployments: [
    "infra/Pulumi.dev.deploy.json gitHub.previewPullRequests",
    "infra/Pulumi.prod.deploy.yaml gitHub.paths",
    "infra/Pulumi.prod.deploy.yaml gitHub.repository",
    "infra/Pulumi.prod.deploy.yaml operationContext.preRunCommands",
    "infra/Pulumi.prod.deploy.yaml operationContext.environmentVariables",
    "infra/Pulumi.prod.deploy.yaml operationContext.oidc.aws",
    "infra/Pulumi.prod.deploy.yaml cacheOptions",
  ],
  spacelift: [".spacelift/config.yml stack_defaults.environment", ".spacelift/config.yml stacks.app-prod.before_init"],
  env0: ["env0.workflow.yml environments.dns", "env0.yml deploy.steps.setupVariables.after", "env0.yml deploy.steps.pulumiPreview.before"],
};

afterEach(() => vi.unstubAllGlobals());

describe("importers", () => {
  // No importer reaches the network: fetch is stubbed to fail every test that calls it.
  const noFetch = () => vi.stubGlobal("fetch", () => Promise.reject(new Error("an importer called fetch")));

  for (const source of IMPORT_SOURCES) {
    it(`${source}: the fixture gives the golden plywood.yml`, () => {
      noFetch();
      const root = join(FIXTURES, source);
      const r = IMPORTERS[source](root, detectedAt(root), []);
      const text = plywoodYml(r.keys);
      expect(text).toBe(readFileSync(join(root, "expected.plywood.yml"), "utf8"));
      expect(checkConfig(parseConfig(text)).filter((p) => p.severity === "error")).toEqual([]);
    });

    it(`${source}: lists each setting it could not carry, by name`, () => {
      const root = join(FIXTURES, source);
      const r = IMPORTERS[source](root, detectedAt(root), []);
      expect(r.unsupported.map((u) => `${u.file} ${u.setting}`)).toEqual(UNSUPPORTED[source]);
      expect(r.unsupported.every((u) => u.why.length > 0)).toBe(true);
      const lines = importLines(r).join("\n");
      for (const u of r.unsupported) expect(lines).toContain(u.setting);
    });
  }

  it("names an environment variable and an identity it leaves for a person", () => {
    const root = join(FIXTURES, "deployments");
    const r = IMPORTERS.deployments(root, detectedAt(root), ["infra/Pulumi.prod.deploy.yaml"]);
    const why = Object.fromEntries(r.unsupported.map((u) => [u.setting, u.why]));
    expect(why["operationContext.environmentVariables"]).toContain("AWS_REGION, LOG_LEVEL");
    expect(why["operationContext.oidc.aws"]).toContain("identity.stacks.shop/prod.up.aws: arn:aws:iam::000000000000:role/deploy");
  });
});

describe("--from", () => {
  it("takes a source, a source with files, or a file", () => {
    expect(parseFrom("spacelift")).toEqual({ source: "spacelift", files: [] });
    expect(parseFrom("deployments=infra/Pulumi.prod.deploy.yaml,infra/Pulumi.dev.deploy.json")).toEqual({ source: "deployments", files: ["infra/Pulumi.prod.deploy.yaml", "infra/Pulumi.dev.deploy.json"] });
    expect(parseFrom("./.github/workflows/pulumi.yml")).toEqual({ source: "pulumi-actions", files: [".github/workflows/pulumi.yml"] });
    expect(parseFrom("ci.yml")).toHaveProperty("error");
    expect(sourceOfFile("env0.workflow.yml")).toBe("env0");
  });

  it("writes plywood.yml from the import through init", async () => {
    const root = mkdtempSync(join(tmpdir(), "plywood-from-"));
    cpSync(join(FIXTURES, "spacelift"), root, { recursive: true });
    mkdirSync(join(root, ".git"));
    const opts = parseInitArgs(["--from", "spacelift", "--yes", "--no-bucket-check", "--dry-run"]);
    if ("error" in opts || "printPrompt" in opts) throw new Error("bad args");
    const r = await runInit(opts, FALLBACK_EXIT, { out: () => {}, err: () => {}, cwd: root, env: {} });
    expect(r.imported?.source).toBe("spacelift");
    expect(r.imported?.unsupported.length).toBe(2);
    expect(r.files.find((f) => f.file === "plywood.yml")?.status).toBe("written");
  });
});
