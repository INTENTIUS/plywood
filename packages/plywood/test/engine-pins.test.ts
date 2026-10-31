import { afterEach, describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { parseConfig } from "../src/config/index";
import { ENGINE_ROOT, installLine, installLines, pinnedSums, plywoodInstallLine, setChantInstallLinesForTests, type ChantInstallLines } from "../src/images";
import { initStacks } from "../src/init";
import type { Detected } from "../src/init/detect";
import { componentsFile, stepInput, wavesSpec } from "../src/init/render";

function fakeLines(): ChantInstallLines & { calls: Array<[string, string, unknown]> } {
  const calls: Array<[string, string, unknown]> = [];
  return {
    calls,
    pulumiInstallLine: (version, options) => (calls.push(["pulumi", version, options]), `chant-pulumi ${version}`),
    plungeInstallLine: (version, options) => (calls.push(["plunge", version, options]), `chant-plunge ${version}`),
  };
}

const detected = (keys: string[]): Detected => ({
  root: "/repo",
  projects: [{ name: "shop", dir: "infra", stacks: keys.map((k) => k.split("/")[1]!) }],
  stacks: keys.map((key) => ({ key, project: "shop", stack: key.split("/")[1]!, dir: "infra" })),
  defaultBranch: "main",
  pulumiActions: [],
});

afterEach(() => setChantInstallLinesForTests("reset"));

describe("install lines", () => {
  it("are plywood's own when the installed lexicon has no ci-setup", () => {
    setChantInstallLinesForTests(undefined);
    expect(installLine("pulumi", "3.272.0")).toBe(plywoodInstallLine("pulumi", "3.272.0"));
  });

  it("take chant's line for a linked release, with the root /opt/plywood and plywood's sums", () => {
    const chant = fakeLines();
    setChantInstallLinesForTests(chant);
    expect(installLine("pulumi", "3.272.0")).toBe("chant-pulumi 3.272.0");
    expect(installLine("plunge", "0.2.0")).toBe("chant-plunge 0.2.0");
    expect(chant.calls).toEqual([
      ["pulumi", "3.272.0", { root: ENGINE_ROOT, sha256: pinnedSums("pulumi", "3.272.0") }],
      ["plunge", "0.2.0", { root: ENGINE_ROOT, sha256: pinnedSums("plunge", "0.2.0") }],
    ]);
  });

  it("leave the sums to chant for a release plywood has not recorded", () => {
    const chant = fakeLines();
    setChantInstallLinesForTests(chant);
    installLine("pulumi", "3.280.0");
    expect(chant.calls[0]![2]).toEqual({ root: ENGINE_ROOT });
  });

  it("keep plywood's line for a pin that is not linked", () => {
    setChantInstallLinesForTests(fakeLines());
    expect(installLines([
      { engine: "pulumi", version: "3.272.0", linked: true },
      { engine: "pulumi", version: "3.200.0", linked: false },
    ])).toEqual([plywoodInstallLine("pulumi", "3.200.0", false), "chant-pulumi 3.272.0"]);
  });
});

describe("a stack pinned off PATH", () => {
  const config = parseConfig(
    ["stacks:", "  shop/dev: {}", "  shop/staging: {}", "  shop/prod: {}", "pulumi:", '  "shop/prod": 3.200.0', '  "*": 3.272.0', ""].join("\n"),
    "plywood.yml",
  );

  it("gets engineVersion and engineRoot in chant's settings", () => {
    const s = toChantSettings(config);
    expect(s.members.find((m) => m.name === "shop/prod")).toMatchObject({ engineVersion: "3.200.0", engineRoot: ENGINE_ROOT, engineBin: `${ENGINE_ROOT}/pulumi-3.200.0/pulumi` });
    expect(s.members.find((m) => m.name === "shop/dev")?.engineRoot).toBeUndefined();
  });

  it("gets them on its pulumi-up step in the components and the waves spec, and the others do not", () => {
    const s = toChantSettings(config);
    const stacks = initStacks(detected(["shop/dev", "shop/staging", "shop/prod"]), config.doc, s.members);
    const prod = stacks.find((x) => x.key === "shop/prod")!;
    expect(stepInput(prod)).toMatchObject({ engineVersion: "3.200.0", engineRoot: ENGINE_ROOT });
    expect(stepInput(stacks.find((x) => x.key === "shop/dev")!)).not.toHaveProperty("engineVersion");
    const spec = wavesSpec({ stacks, gate: "on-destructive", branch: "main" }) as { waves: Array<{ runs: Array<{ target: string; input: Record<string, unknown> }> }> };
    const run = spec.waves.flatMap((w) => w.runs).find((r) => r.target === "shop/prod")!;
    expect(run.input).toMatchObject({ engineVersion: "3.200.0", engineRoot: ENGINE_ROOT });
    expect(componentsFile(stacks)).toContain('"engineVersion":"3.200.0","engineRoot":"/opt/plywood"');
  });
});

describe("each stack's backend on its step (plywood#22)", () => {
  const store = "plunge+s3://plywood-tutorial-plunge?region=us-east-1&endpoint=http://floci:4566&s3ForcePathStyle=true";
  const state = "s3://plywood-tutorial-state?region=us-east-1&endpoint=http://floci:4566&use_path_style=true";

  it("writes stacks.<key>.backend into the pulumi-up step of the components and the waves spec", () => {
    const config = parseConfig(["stacks:", "  shop/dev:", `    backend: ${store}`, "  shop/prod:", `    backend: ${state}`, ""].join("\n"), "plywood.yml");
    const stacks = initStacks(detected(["shop/dev", "shop/prod"]), config.doc);
    expect(stepInput(stacks.find((x) => x.key === "shop/dev")!)).toMatchObject({ backend: store, engine: "plunge" });
    expect(stepInput(stacks.find((x) => x.key === "shop/prod")!)).toMatchObject({ backend: state });
    const spec = wavesSpec({ stacks, gate: "on-destructive", branch: "main" }) as { waves: Array<{ runs: Array<{ target: string; input: Record<string, unknown> }> }> };
    const runs = Object.fromEntries(spec.waves.flatMap((w) => w.runs).map((r) => [r.target, r.input.backend]));
    expect(runs).toEqual({ "shop/dev": store, "shop/prod": state });
    expect(componentsFile(stacks)).toContain(`"backend":${JSON.stringify(store)}`);
  });

  it("falls back to the top-level backend, and a stack's own wins over it", () => {
    const config = parseConfig(["backend: file:///srv/state", "stacks:", "  shop/dev: {}", "  shop/prod:", `    backend: ${state}`, ""].join("\n"), "plywood.yml");
    const stacks = initStacks(detected(["shop/dev", "shop/prod"]), config.doc);
    expect(stepInput(stacks.find((x) => x.key === "shop/dev")!).backend).toBe("file:///srv/state");
    expect(stepInput(stacks.find((x) => x.key === "shop/prod")!).backend).toBe(state);
  });

  it("names no backend when plywood.yml names none, so the step reads the job's or Pulumi.yaml's as before", () => {
    const stacks = initStacks(detected(["shop/dev"]), parseConfig("stacks:\n  shop/dev: {}\n", "plywood.yml").doc);
    expect(stepInput(stacks[0]!)).not.toHaveProperty("backend");
  });
});

describe("each stack's lock grain on its step (chant's ledger lock, ruling for ci-products 2026-10-28)", () => {
  const store = "plunge+s3://plywood-tutorial-plunge?region=us-east-1&endpoint=http://floci:4566&s3ForcePathStyle=true";
  const state = "s3://plywood-tutorial-state?region=us-east-1&endpoint=http://floci:4566&use_path_style=true";
  const grains = (yml: string[]) => {
    const stacks = initStacks(detected(["shop/dev", "shop/staging"]), parseConfig(yml.join("\n"), "plywood.yml").doc);
    const spec = wavesSpec({ stacks, gate: "on-destructive", branch: "main" }) as { waves: Array<{ runs: Array<{ target: string; input: Record<string, unknown> }> }> };
    return Object.fromEntries(spec.waves.flatMap((w) => w.runs).map((r) => [r.target, r.input.lockGrain]));
  };

  it("a plunge stack takes the resource grain and never waits; a stack on stock Pulumi takes target and waits for its stack row", () => {
    // A plunge+ backend says plunge; an s3 backend leaves the engine to chant, whose stock default is target.
    expect(grains(["stacks:", "  shop/dev:", `    backend: ${store}`, "  shop/staging:", `    backend: ${state}`, ""])).toEqual({ "shop/dev": "resource", "shop/staging": undefined });
    expect(grains(["engine: pulumi", "stacks:", "  shop/dev: {}", "  shop/staging:", `    backend: ${state}`, ""])).toEqual({ "shop/dev": "target", "shop/staging": "target" });
  });

  it("locks.grain: stack puts every stack on target, plunge ones too", () => {
    expect(grains(["locks:", "  grain: stack", "stacks:", "  shop/dev:", `    backend: ${store}`, "  shop/staging:", `    backend: ${state}`, ""])).toEqual({ "shop/dev": "target", "shop/staging": "target" });
  });

  it("a stack whose engine chant detects gets no grain of plywood's, so its lexicon's default holds", () => {
    expect(grains(["stacks:", "  shop/dev: {}", "  shop/staging: {}", ""])).toEqual({ "shop/dev": undefined, "shop/staging": undefined });
  });
});
