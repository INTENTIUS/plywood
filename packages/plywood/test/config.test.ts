import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, GROUPS, parseConfig, plywoodSchema } from "../src/config/index";
import { PLYWOOD_KEY_FOR } from "../src/config/chant-keys";
import { installLine, TOOL_VERSIONS } from "../src/images";

/** The line every config without a pin gets: Pulumi at plywood's release, on PATH. */
const DEFAULT_SETUP = [installLine("pulumi", TOOL_VERSIONS.pulumi)];

const DOCS = join(import.meta.dirname, "../../../site/src/content/docs");
const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

/** Each yaml block on a site page that sets plywood keys. */
function siteExamples(): { page: string; text: string }[] {
  const pages = readdirSync(DOCS, { recursive: true, encoding: "utf8" }).filter((f) => /\.mdx?$/.test(f));
  const out: { page: string; text: string }[] = [];
  const known = new Set(GROUPS.flatMap((g) => g.keys));
  for (const page of pages) {
    const body = readFileSync(join(DOCS, page), "utf8");
    for (const m of body.matchAll(/^```ya?ml\n([\s\S]*?)^```/gm)) {
      const doc = parseConfig(m[1]).doc;
      if (Object.keys(doc).some((k) => known.has(k))) out.push({ page, text: m[1] });
    }
  }
  return out;
}

describe("plywood.yml", () => {
  it("renders reference/config.md's example as chant's settings", () => {
    const body = readFileSync(join(DOCS, "reference/config.md"), "utf8");
    const text = /^```yaml\n([\s\S]*?)^```/m.exec(body)![1];
    const config = parseConfig(text);
    expect(errors(text)).toEqual([]);
    expect(toChantSettings(config)).toEqual({
      ci: { workflow: "trunk-curated+apply-on-merge", locks: "plan", policy: { path: "policy" } },
      members: [
        { name: "shop/dev", dir: "infra", engine: "pulumi" },
        { name: "shop/prod-east", dir: "infra", engine: "pulumi" },
      ],
      memberDefaults: { engine: "pulumi" },
      pipeline: { waves: [["shop/dev"], ["shop/prod-east"]], gate: "on-destructive", approval: "ledger", excludeAuthor: true, policyPacks: [{ dir: "policy/aws-guard" }], engineSetup: DEFAULT_SETUP },
    });
  });

  it("takes plywood's defaults with an empty file", () => {
    expect(toChantSettings(parseConfig(""))).toEqual({
      ci: { workflow: "trunk-curated+apply-on-merge", locks: "plan" },
      members: [],
      memberDefaults: {},
      pipeline: { gate: "on-destructive", approval: "ledger", excludeAuthor: true, engineSetup: DEFAULT_SETUP },
    });
  });

  it("maps locks.when up and locks.grain stack to ci.locks apply and ci.lockGrain target", () => {
    expect(toChantSettings(parseConfig("locks: { when: up, grain: stack }")).ci).toMatchObject({ locks: "apply", lockGrain: "target" });
  });

  it("maps apply.when pull-request to apply-before-merge, with every requirement by default", () => {
    const s = toChantSettings(parseConfig("apply: { when: pull-request }"));
    expect(s.ci.workflow).toBe("apply-before-merge");
    expect(s.pipeline.applyRequires).toEqual(["approved", "mergeable", "undiverged", "checks"]);
    expect(errors("apply: { when: merge, requires: [approved] }")[0].key).toBe("apply.requires");
  });

  it("gives each stack on a plunge+ backend the plunge engine", () => {
    const s = toChantSettings(parseConfig("stacks:\n  shop/dev:\n    backend: plunge+file:///tmp/state\n  shop/prod: { dir: infra }\n"));
    expect(s.members).toEqual([
      { name: "shop/dev", backend: "plunge+file:///tmp/state", engine: "plunge" },
      { name: "shop/prod", dir: "infra" },
    ]);
    expect(errors("engine: pulumi\nbackend: plunge+file:///tmp/state\n")[0].key).toBe("backend");
  });

  it("turns approval_rules into chant quorum rules the author never counts toward", () => {
    const text = 'approval: sealed\napproval_rules:\n  "shop/prod-*": { role: platform, quorum: 2 }\n  "*": { role: developers }\n';
    expect(checkConfig(parseConfig(text))).toEqual([]);
    expect(toChantSettings(parseConfig(text)).pipeline.quorum).toEqual([
      { targets: ["shop/prod-*"], count: 2, roles: ["platform"], notAuthor: true },
      { targets: ["*"], count: 1, roles: ["developers"], notAuthor: true },
    ]);
  });

  it("turns review_stacks into ci.prEnvironment", () => {
    const s = toChantSettings(parseConfig("review_stacks:\n  template: shop/dev\n  name: pr-{number}\n"));
    expect(s.ci.prEnvironment).toEqual({ template: "shop/dev" });
    expect(s.pipeline.reviewStackName).toBe("pr-{number}");
    expect(errors("review_stacks: { template: shop/dev, name: review }")[0].key).toBe("review_stacks.name");
  });

  it.each(Object.entries(PLYWOOD_KEY_FOR).filter(([, p]) => p))("refuses ci.%s naming %s", (sub, plywood) => {
    for (const text of [`ci:\n  ${sub}: x\n`, `ci.${sub}: x\n`]) {
      const [p] = errors(text);
      expect(p.key).toBe(`ci.${sub}`);
      expect(p.message).toContain(`set ${plywood} in plywood.yml`);
    }
  });

  it("refuses an unknown key", () => {
    expect(errors("workflow: merge")[0].key).toBe("workflow");
  });

  it("checks every example on the site clean, with keys the schema lists", () => {
    const examples = siteExamples();
    expect(examples.length).toBeGreaterThan(3);
    const properties = Object.keys((plywoodSchema() as { properties: Record<string, unknown> }).properties);
    for (const { page, text } of examples) {
      expect(errors(text), page).toEqual([]);
      for (const key of Object.keys(parseConfig(text).doc)) expect(properties, `${page}: ${key}`).toContain(key);
    }
  });

  it("matches the committed plywood.schema.json", () => {
    const committed = JSON.parse(readFileSync(join(import.meta.dirname, "../plywood.schema.json"), "utf8"));
    expect(committed).toEqual(plywoodSchema());
  });
});
