import { describe, expect, it } from "vitest";
import { BEHOLD_PIN, VIEW_PORT, beholdArgv, beholdVersion, explainBehold, opener, view, viewCommand, type ViewChild, type ViewDeps } from "../src/view";

type Exit = { code: number | null; error?: NodeJS.ErrnoException };

function fakeChild(exit: Promise<Exit>, text = ""): ViewChild & { killed: string[] } {
  const killed: string[] = [];
  return { killed, output: (fn) => text && fn(text), exit, kill: (s) => void killed.push(s) };
}

function fakeDeps(over: Partial<ViewDeps> & { child?: ViewChild } = {}) {
  const printed: string[] = [];
  const warned: string[] = [];
  const spawned: { cmd: string; args: string[] }[] = [];
  const deps: ViewDeps = {
    spawn: (cmd, args) => {
      spawned.push({ cmd, args });
      return cmd === "npx" ? (over.child ?? fakeChild(Promise.resolve({ code: 0 }))) : fakeChild(Promise.resolve({ code: 0 }));
    },
    fetch: async () => {
      throw new Error("down");
    },
    env: {},
    platform: "linux",
    print: (l) => void printed.push(l),
    warn: (l) => void warned.push(l),
    forward: () => {},
    onSignal: () => () => {},
    sleep: async () => {},
    ...over,
  };
  return { deps, printed, warned, spawned };
}

describe("BEHOLD_PIN", () => {
  it("names an exact behold release and the pulumi lexicon range behold depends on", () => {
    expect(BEHOLD_PIN.behold).toMatch(/^@intentius\/behold@\d+\.\d+\.\d+$/);
    expect(BEHOLD_PIN.lexicon).toMatch(/^@intentius\/chant-lexicon-pulumi@\^\d+\.\d+\.\d+$/);
    expect(BEHOLD_PIN).toEqual({ behold: "@intentius/behold@0.34.2", lexicon: "@intentius/chant-lexicon-pulumi@^0.124.102" });
    expect(beholdVersion()).toBe("0.34.2");
  });
});

describe("beholdArgv", () => {
  it("serves the checkout on behold's port with the pinned packages", () => {
    expect(beholdArgv({ root: "/repo" })).toEqual(["--yes", "-p", BEHOLD_PIN.behold, "-p", BEHOLD_PIN.lexicon, "behold", "serve", "/repo", "--port", String(VIEW_PORT)]);
    expect(beholdArgv({ root: "/repo", port: 4700 }).slice(-2)).toEqual(["--port", "4700"]);
  });

  it("exports to a directory with --export", () => {
    expect(beholdArgv({ root: "/repo", export: "/out" })).toEqual(["--yes", "-p", BEHOLD_PIN.behold, "-p", BEHOLD_PIN.lexicon, "behold", "export", "/repo", "--out", "/out"]);
  });
});

describe("view", () => {
  it("exports and returns 0", async () => {
    const { deps, printed, spawned } = fakeDeps();
    expect(await view({ root: "/repo", export: "/out" }, deps)).toBe(0);
    expect(spawned[0]).toMatchObject({ cmd: "npx" });
    expect(printed[0]).toContain("0.34.2");
  });

  it("serves once behold answers, opens the browser and returns 0 when it stops", async () => {
    let calls = 0;
    const { deps, printed, spawned } = fakeDeps({
      fetch: async () => {
        // The first call is the free-port probe.
        if (++calls <= 2) throw new Error("down");
        return { status: 200 };
      },
      child: fakeChild(new Promise<Exit>((r) => setTimeout(() => r({ code: 0 }), 20))),
    });
    expect(await view({ root: "/repo" }, deps)).toBe(0);
    expect(printed.some((l) => l.includes(`http://127.0.0.1:${VIEW_PORT}`))).toBe(true);
    expect(spawned.map((s) => s.cmd)).toEqual(["npx", "xdg-open"]);
  });

  it("refuses a port something already answers on", async () => {
    const { deps, warned, spawned } = fakeDeps({ fetch: async () => ({ status: 200 }) });
    expect(await view({ root: "/repo" }, deps)).toBe(1);
    expect(warned[0]).toContain("already answers");
    expect(spawned).toEqual([]);
  });

  it("says npx is missing when it cannot start", async () => {
    const error = Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" }) as NodeJS.ErrnoException;
    const { deps, warned } = fakeDeps({ child: fakeChild(Promise.resolve({ code: null, error })) });
    expect(await view({ root: "/repo", export: "/out" }, deps)).toBe(1);
    expect(warned[0]).toContain("npx is not on the PATH");
  });

  it("explains a failed behold from its output", async () => {
    const { deps, warned } = fakeDeps({ child: fakeChild(Promise.resolve({ code: 1 }), "behold export: no chant project here\n  run it in a checkout\n") });
    expect(await view({ root: "/repo", export: "/out" }, deps)).toBe(1);
    expect(warned[0]).toBe("plywood view: no chant project here run it in a checkout");
  });
});

describe("explainBehold", () => {
  it("names a package npm does not serve", () => {
    expect(explainBehold("npm error No matching version found for @intentius/behold@9.9.9.", {})).toContain("@intentius/behold@9.9.9");
  });
  it("names a port in use", () => {
    expect(explainBehold("Error: listen EADDRINUSE", { port: 4700 })).toContain("4700");
  });
  it("returns undefined for output it does not know", () => {
    expect(explainBehold("fine", {})).toBeUndefined();
  });
});

describe("viewCommand", () => {
  const run = async (args: string[]) => {
    const warned: string[] = [];
    const { deps } = fakeDeps();
    const code = await viewCommand(args, "/nonexistent-dir-for-plywood-view", (l) => void warned.push(l), deps);
    return { code, warned };
  };
  it("refuses a bad port, a flag without a value and an unknown argument", async () => {
    expect((await run(["--port", "x"])).code).toBe(1);
    expect((await run(["--export"])).code).toBe(1);
    expect((await run(["stack"])).code).toBe(1);
    expect((await run(["--port", "4600", "--export", "out"])).warned[0]).toContain("--port is for serving");
  });
  it("exports with the directory resolved against cwd", async () => {
    expect((await run(["--export", "out"])).code).toBe(0);
  });
});

describe("opener", () => {
  it("picks the platform's opener", () => {
    expect(opener("darwin", "u")[0]).toBe("open");
    expect(opener("win32", "u")[0]).toBe("cmd");
    expect(opener("linux", "u")[0]).toBe("xdg-open");
  });
});
