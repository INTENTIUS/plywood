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
    expect(installLine("plunge", "0.1.0")).toBe("chant-plunge 0.1.0");
    expect(chant.calls).toEqual([
      ["pulumi", "3.272.0", { root: ENGINE_ROOT, sha256: pinnedSums("pulumi", "3.272.0") }],
      ["plunge", "0.1.0", { root: ENGINE_ROOT, sha256: pinnedSums("plunge", "0.1.0") }],
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
