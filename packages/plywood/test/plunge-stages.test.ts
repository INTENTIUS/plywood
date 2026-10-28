import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { DEFAULT_LOCK_GRAIN, lockGrainFor } from "../src/config/locks";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { refusalLine, refusalOf } from "../src/refusals";
import { ENGINE_WORDS, PLUNGE_TIMING_ATTRIBUTES } from "../src/words";

const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

describe("the lock grain per engine", () => {
  it("leaves ci.lockGrain to chant's pulumi lexicon when plywood.yml sets no grain", () => {
    for (const text of ["", "engine: plunge", "engine: pulumi", "backend: plunge+file:///srv/state"]) {
      expect(toChantSettings(parseConfig(text)).ci.lockGrain, text).toBeUndefined();
    }
  });

  it("names resource on plunge and stack on stock Pulumi", () => {
    expect(DEFAULT_LOCK_GRAIN).toEqual({ plunge: "resource", pulumi: "stack" });
    expect(lockGrainFor(parseConfig("").doc, "plunge")).toBe("resource");
    expect(lockGrainFor(parseConfig("").doc, "pulumi")).toBe("stack");
    expect(lockGrainFor(parseConfig("").doc, undefined)).toBe("per-engine");
    expect(lockGrainFor(parseConfig("locks: { grain: stack }").doc, "plunge")).toBe("stack");
  });

  it("writes the grain plywood.yml sets", () => {
    expect(toChantSettings(parseConfig("engine: plunge\nlocks: { grain: resource }")).ci.lockGrain).toBe("resource");
    expect(toChantSettings(parseConfig("locks: { grain: stack }")).ci.lockGrain).toBe("target");
  });

  it("refuses the resource grain on stock Pulumi, as chant would", () => {
    expect(errors("engine: pulumi\nlocks: { grain: resource }").map((p) => p.key)).toEqual(["locks.grain"]);
    expect(errors("engine: plunge\nlocks: { grain: resource }")).toEqual([]);
    expect(errors("locks: { grain: resource }")).toEqual([]);
  });
});

describe("saved plans and held rows in plywood's words", () => {
  it("keeps a moved saved plan on chant's moved code, apart from gated", () => {
    expect(refusalOf(FALLBACK_EXIT.moved, FALLBACK_EXIT)).toBe("moved");
    expect(FALLBACK_EXIT.moved).not.toBe(FALLBACK_EXIT.waiting);
    expect(refusalLine("moved")).toContain("saved plan");
    expect(ENGINE_WORDS.plunge.moved).toContain("moved code");
  });

  it("explains a held resource row", () => {
    expect(refusalOf(FALLBACK_EXIT.held, FALLBACK_EXIT)).toBe("held");
    expect(refusalLine("held", { wave: 2 })).toContain("plywood up --wave 2");
  });
});

describe("plunge timings in the dashboard preset", () => {
  it("reads chant's plunge span attributes under plywood's prefix", () => {
    const d = JSON.parse(readFileSync(join(import.meta.dirname, "../presets/dashboards/plywood.json"), "utf8"));
    const queries = d.panels.flatMap((p: { targets: Array<{ query: string }> }) => p.targets.map((t) => t.query)).join("\n");
    for (const attr of [PLUNGE_TIMING_ATTRIBUTES.resources, PLUNGE_TIMING_ATTRIBUTES.providerMs, PLUNGE_TIMING_ATTRIBUTES.recordMs, PLUNGE_TIMING_ATTRIBUTES.slowestUrn]) {
      expect(queries).toContain(`span.${attr}`);
    }
    expect(new Set(d.panels.map((p: { id: number }) => p.id)).size).toBe(d.panels.length);
  });
});
