import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { afterCycle } from "../src/config/stacks";
import { componentsFile, wavesOf, wavesSpec, type InitStack } from "../src/init/render";
import { orderLines, orderWaves, setReferenceReaderForTests, stackOrder, type StackEdge } from "../src/stack-order";

const FIXTURES = join(import.meta.dirname, "fixtures/stack-references");
const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

const stack = (key: string, dir = "."): InitStack => {
  const [project, name] = key.split("/") as [string, string];
  return { key, project, stack: name, dir };
};

/** A reader in the shape of chant#4547's, over the fixture exports. */
const fixtureReader = {
  pulumiStackReferences(exported: unknown) {
    const resources = (exported as { deployment: { resources: Array<{ type: string; inputs?: { name?: string } }> } }).deployment.resources;
    return resources
      .filter((r) => r.type === "pulumi:pulumi:StackReference")
      .map((r) => {
        const parts = r.inputs!.name!.split("/");
        return { name: r.inputs!.name!, project: parts[1], stack: parts[2]! };
      });
  },
  stackReferenceOwner(ref: { name: string; project?: string; stack: string }, reader: { component: string; project: string }, owners: ReadonlyArray<{ component: string; project: string; stack: string }>) {
    const found = owners.filter((o) => o.component !== reader.component && o.project === (ref.project ?? reader.project) && o.stack === ref.stack);
    return found.length === 1 ? { owner: found[0]! } : { outside: `no step in the project applies ${ref.name}` };
  },
  readMemberExport(dir: string) {
    try {
      return JSON.parse(readFileSync(join(dir, "stack-export.json"), "utf8"));
    } catch {
      return undefined;
    }
  },
};

afterEach(() => setReferenceReaderForTests("reset"));

describe("waves as a mapping", () => {
  it("takes canary and after", () => {
    const text = ["stacks:", "  network/prod: {}", "  app/prod: {}", "  app/dev: {}", "waves:", "  canary: [app/dev]", "  after:", "    app/prod: [network/prod]", ""].join("\n");
    expect(errors(text)).toEqual([]);
    const settings = toChantSettings(parseConfig(text));
    expect(settings.pipeline.canary).toEqual(["app/dev"]);
    expect(settings.pipeline.after).toEqual({ "app/prod": ["network/prod"] });
    expect(settings.pipeline.waves).toBeUndefined();
  });

  it("refuses a stack it does not list, a stack after itself, and a circle", () => {
    const text = ["stacks:", "  a/x: {}", "  b/x: {}", "waves:", "  canary: [c/x]", "  after:", "    a/x: [b/x, a/x]", "    b/x: [a/x]", "  order: []", ""].join("\n");
    const keys = errors(text).map((p) => p.key);
    expect(keys).toContain("waves.canary");
    expect(keys).toContain("waves.after.a/x");
    expect(keys).toContain("waves.after");
    expect(keys).toContain("waves.order");
  });

  it("finds a circle", () => {
    expect(afterCycle({ a: ["b"], b: ["c"], c: ["a"] })).toEqual(["a", "b", "c", "a"]);
    expect(afterCycle({ a: ["b"], b: [] })).toBeUndefined();
  });
});

describe("orderWaves", () => {
  const net = stack("network/prod");
  const app = stack("app/prod");
  const dev = stack("app/dev");
  const edge: StackEdge = { reader: "app/prod", upstream: "network/prod", because: "stack-reference" };

  it("cuts a wave so the stack read updates first", () => {
    const { waves, unmet } = orderWaves([{ name: "prod", stacks: [app, net] }], [edge]);
    expect(waves.map((w) => [w.name, w.stacks.map((s) => s.key)])).toEqual([
      ["prod", ["network/prod"]],
      ["prod-2", ["app/prod"]],
    ]);
    expect(unmet).toEqual([]);
  });

  it("puts the canary first, in a wave of its own", () => {
    const waves = wavesOf([dev, net, app]);
    const out = orderWaves(waves, [edge], ["app/dev"]).waves;
    expect(out.map((w) => w.name)).toEqual(["canary", "prod", "prod-2"]);
    expect(out[0]!.stacks.map((s) => s.key)).toEqual(["app/dev"]);
  });

  it("names an edge to a later wave, and stacks that read each other", () => {
    const later = orderWaves([{ name: "one", stacks: [app] }, { name: "two", stacks: [net] }], [edge]).unmet;
    expect(later.map((u) => u.why)).toEqual(["network/prod updates in two, after app/prod's wave one"]);
    const circle = orderWaves([{ name: "w", stacks: [app, net] }], [edge, { reader: "network/prod", upstream: "app/prod", because: "waves.after" }]).unmet;
    expect(circle.length).toBe(1);
  });

  it("orders the waves spec's runs", () => {
    const ordered = orderWaves([{ name: "prod", stacks: [app, net] }], [edge]).waves;
    const spec = wavesSpec({ stacks: [app, net], ordered, gate: "on-destructive", branch: "main" }) as { waves: Array<{ name: string; runs: Array<{ target: string }> }> };
    expect(spec.waves.map((w) => w.runs.map((r) => r.target))).toEqual([["network/prod"], ["app/prod"]]);
  });

  it("writes waves.after as the components' dependsOn", () => {
    const text = componentsFile([net, app], { "app/prod": ["network/prod"] });
    expect(text).toContain('"name":"app-prod","dependsOn":["network-prod"]');
    expect(text).toContain('"name":"network-prod","dependsOn":[]');
  });
});

describe("stackOrder", () => {
  it("reads each stack's references from its export, and names one outside the repository", async () => {
    setReferenceReaderForTests(fixtureReader);
    const order = await stackOrder(FIXTURES, [stack("network/prod", "network"), stack("app/prod", "app")]);
    expect(order.reads).toBe(true);
    expect(order.edges).toEqual([{ reader: "app/prod", upstream: "network/prod", because: "stack-reference" }]);
    expect(order.outside).toEqual([{ stack: "app/prod", reference: "acme/billing/prod", why: "no step in the project applies acme/billing/prod" }]);
  });

  it("follows waves.after alone when the pulumi lexicon reads no references", async () => {
    setReferenceReaderForTests(undefined);
    const order = await stackOrder(FIXTURES, [stack("network/prod", "network"), stack("app/prod", "app")], { "network/prod": ["app/prod"] });
    expect(order).toEqual({ edges: [{ reader: "network/prod", upstream: "app/prod", because: "waves.after" }], outside: [], reads: false });
    expect(orderLines(order, [])[0]).toContain("reads no StackReferences");
  });
});
