import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { estimateCosts, costEstimateLines, policyCost } from "@intentius/chant/ci-product";
import { toChantSettings } from "../src/chant-config";
import { commandArgv } from "../src/config/cost";
import { checkConfig, parseConfig, plywoodSchema } from "../src/config/index";
import { costHold } from "../src/init";
import { wavesSpec } from "../src/init/render";

const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");
const YML = "cost:\n  command: ./price {planJson}\n  approve_above: 100\n  currency: EUR\n";

describe("cost in plywood.yml", () => {
  it("sets nothing when absent", () => {
    const s = toChantSettings(parseConfig(""));
    expect(s.ci.cost).toBeUndefined();
    expect(s.pipeline.cost).toBeUndefined();
  });

  it("maps onto chant's ci.cost and the wave hold, with the chant format by default", () => {
    const s = toChantSettings(parseConfig(YML));
    const expected = { command: ["./price", "{planJson}"], format: "chant", currency: "EUR", approveAbove: 100 };
    expect(s.ci.cost).toEqual(expected);
    expect(s.pipeline.cost).toEqual(expected);
  });

  it("shows the estimate and holds nothing without approve_above", () => {
    const s = toChantSettings(parseConfig("cost: { command: [./price, '{planJson}', '{target}'], format: infracost }"));
    expect(s.ci.cost).toEqual({ command: ["./price", "{planJson}", "{target}"], format: "infracost" });
    expect(s.pipeline.cost).toBeUndefined();
  });

  it("takes a command line with quotes", () => {
    expect(commandArgv("./price --note 'a b' {planJson}")).toEqual(["./price", "--note", "a b", "{planJson}"]);
    expect(commandArgv("./price 'open")).toBeNull();
  });

  it("refuses a missing estimator, a command without {planJson}, and bad values", () => {
    expect(errors("cost: { approve_above: 5 }").map((p) => p.key)).toEqual(["cost.command"]);
    expect(errors("cost: { command: ./price }")[0]!.message).toContain("{planJson}");
    expect(errors("cost: { command: './price {planJson}', approve_above: -1 }").map((p) => p.key)).toEqual(["cost.approve_above"]);
    expect(errors("cost: { command: './price {planJson}', currency: usd }").map((p) => p.key)).toEqual(["cost.currency"]);
    expect(errors("cost: { command: './price {planJson}', format: csv }").map((p) => p.key)).toEqual(["cost.format"]);
    expect(errors("cost: { command: './price {planJson}', allow_unattended: true }").map((p) => p.key)).toEqual(["cost.allow_unattended"]);
  });

  it("is in the schema without a default estimator", () => {
    const cost = (plywoodSchema().properties as Record<string, { properties: Record<string, unknown> }>).cost!;
    expect(Object.keys(cost.properties)).toEqual(["command", "format", "currency", "approve_above"]);
    expect(cost.properties.command).not.toHaveProperty("default");
  });
});

describe("the wave's cost hold", () => {
  const stacks = [{ key: "shop/dev", project: "shop", stack: "dev", dir: ".", backend: "file://" }] as never;

  it("is the pulumi lexicon's pulumiCostHold, in the spec's holds", async () => {
    const settings = toChantSettings(parseConfig(YML)).pipeline.cost!;
    const hold = await costHold(settings);
    expect(hold).toEqual({ command: ["./price", "{planJson}"], approveAbove: 100, format: "chant", currency: "EUR" });
    expect(wavesSpec({ stacks, gate: "never", branch: "main", cost: hold, policy: true })).toMatchObject({ holds: { policy: true, cost: hold } });
    expect(wavesSpec({ stacks, gate: "never", branch: "main" })).not.toHaveProperty("holds");
  });
});

describe("a fake price source through chant's estimate", () => {
  it("prices a preview, and goes over the threshold", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-cost-"));
    const price = join(dir, "price.sh");
    writeFileSync(price, '#!/bin/sh\necho \'{"monthlyDelta": 140.5}\'\n');
    chmodSync(price, 0o755);
    writeFileSync(join(dir, "preview.json"), "{}");
    const { ci } = toChantSettings(parseConfig(`cost:\n  command: ${price} {planJson}\n  approve_above: 100\n`));
    const estimate = estimateCosts(ci.cost!, [{ member: "shop", artifact: { planJson: "preview.json" }, empty: false }], dir);
    expect(estimate).toMatchObject({ monthlyDelta: 140.5, over: true, approveAbove: 100, unestimated: [] });
    expect(costEstimateLines(estimate).join("\n")).toContain("140.50");
    expect(policyCost(estimate, "shop").member).toMatchObject({ monthlyDelta: 140.5 });
  });

  it("names the stack it could not price, and holds on it", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-cost-"));
    const { ci } = toChantSettings(parseConfig("cost:\n  command: ./missing {planJson}\n  approve_above: 100\n"));
    writeFileSync(join(dir, "preview.json"), "{}");
    const estimate = estimateCosts(ci.cost!, [{ member: "shop", artifact: { planJson: "preview.json" }, empty: false }], dir);
    expect(estimate).toMatchObject({ unestimated: ["shop"], over: true });
  });
});
