import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseConfig } from "../../packages/plywood/src/config/index";
import { actionsOf } from "../../packages/plywood/src/config/stacks";
import { ACTION_URN, MARKER_KEY, actionScript, addRotateAction, rotateProgram } from "../action";
import { SCENARIOS_DIR } from "../scenarios";

describe("the bench's day-2 action", () => {
  it("is the action prod-us declares in the shop's plywood.yml", () => {
    const doc = parseConfig(readFileSync(join(SCENARIOS_DIR, "base", "plywood.yml"), "utf8")).doc;
    expect(actionsOf(doc, "shop/prod-us").map((a) => [a.name, a.urn])).toEqual([["rotate", ACTION_URN]]);
    expect(ACTION_URN).toBe("urn:pulumi:prod-us::shop::command:local:Command::rotate");
    for (const s of ["shop/dev", "shop/staging", "shop/prod-eu"]) expect(actionsOf(doc, s), s).toEqual([]);
  });

  it("declares a local command at the images' provider pin, only where the marker is set", () => {
    const text = rotateProgram();
    expect(text).toContain('class RotateCommand extends pulumi.CustomResource');
    expect(text).toContain('super("command:local:Command", name, props, opts);');
    expect(text).toContain('new RotateCommand(\n        "rotate",');
    expect(text).toContain('{ version: "1.0.1" }');
    expect(text).toContain('new pulumi.Config("shop").get("rotateMarker")');
    expect(text).toContain("environment: { ROTATE_MARKER: marker }");
    expect(text).toContain('printf "%s %s\\\\n" "$ROTATE_MARKER"');
  });

  it("adds rotate.ts, its import and prod-us's marker to the program once", () => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-rotate-"));
    writeFileSync(join(dir, "index.ts"), "export const a = 1;\n");
    writeFileSync(join(dir, "Pulumi.prod-us.yaml"), "config:\n  corpus:workerCount: \"3\"\n");
    writeFileSync(join(dir, "Pulumi.dev.yaml"), "config:\n  corpus:workerCount: \"3\"\n");
    addRotateAction(dir);
    addRotateAction(dir);
    expect(readFileSync(join(dir, "rotate.ts"), "utf8")).toBe(rotateProgram());
    expect(readFileSync(join(dir, "index.ts"), "utf8").match(/import "\.\/rotate";/g)).toHaveLength(1);
    expect(readFileSync(join(dir, "Pulumi.prod-us.yaml"), "utf8")).toBe(`config:\n  corpus:workerCount: "3"\n  ${MARKER_KEY}: "first"\n`);
    expect(readFileSync(join(dir, "Pulumi.dev.yaml"), "utf8")).not.toContain(MARKER_KEY);
  });

  it("passes plywood action's exit on, and fails a wait that prints no approve line", () => {
    const bin = mkdtempSync(join(tmpdir(), "plywood-fake-"));
    const fake = (body: string) => {
      writeFileSync(join(bin, "plywood"), `#!/bin/sh\n${body}\n`);
      chmodSync(join(bin, "plywood"), 0o755);
    };
    const run = (): number => {
      try {
        execFileSync("sh", ["-c", actionScript("prod-us", "rotate", "tutor")], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: "pipe" });
        return 0;
      } catch (e) {
        return (e as { status: number }).status;
      }
    };
    fake(`[ "$*" = "action shop/prod-us rotate --by tutor" ] || exit 9\necho "plywood action waits: plywood approve action:prod-us:rotate --op pulumi-stack-ops --plan sha256:ab" >&2\nexit 3`);
    expect(run()).toBe(3);
    fake("echo waiting >&2\nexit 3");
    expect(run()).toBe(1);
    fake("echo replaced\nexit 0");
    expect(run()).toBe(0);
  });
});
