import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { toChantSettings } from "../src/chant-config";
import { checkConfig, parseConfig } from "../src/config/index";
import { controlOf, controlRepoKey } from "../src/config/control";
import {
  control,
  controlledConfigText,
  projectSettings,
  setChantControlForTests,
  settingsFromFlags,
  validateControlSettings,
  wavesControl,
  type ChantControl,
} from "../src/control";
import { FALLBACK_EXIT } from "../src/exit-codes";

const FIXTURES = join(import.meta.dirname, "fixtures/control");
const errors = (text: string) => checkConfig(parseConfig(text)).filter((p) => p.severity === "error");

/** A chant#4568 stand-in whose ledger is an array of lines in memory. */
function fakeChant(lines: string[] = []): ChantControl & { lines: string[]; dispatched: unknown[] } {
  const dispatched: unknown[] = [];
  const entries = () => {
    const current = new Map<string, Record<string, unknown>>();
    for (const l of lines) {
      const r = JSON.parse(l) as Record<string, unknown>;
      current.set(String(r.project ?? "defaults"), r);
    }
    return [...current.values()].filter((r) => r.state !== "retired").map((r) => ({ id: r.id, entry: r.entry, ...(r.project ? { project: r.project } : {}), settings: r.settings, estates: r.estates ?? [], digest: r.digest, at: r.at })) as never[];
  };
  const fake = {
    lines,
    dispatched,
    controlSettingsProblems: () => [],
    resolveControlTarget: (s: { repo: string; op: string; member?: string }, member: string) => ({ repo: s.repo, forge: "github", member: s.member ?? member, op: s.op, tokenSecret: "CHANT_CONTROL_TOKEN" }),
    dispatchControl: async (_t: unknown, d: unknown) => {
      dispatched.push(d);
      return { status: 204 };
    },
    controlPipelinePath: () => ".github/workflows/plywood-dependents.yml",
    gitControlLedger: () => ({ read: async () => lines.join("\n"), append: async (line: string) => (lines.push(line), "c0ffee") }),
    readControlEntries: async () => entries(),
    putControlEntry: async (_p: unknown, want: { entry: string; project?: string; settings: Record<string, unknown> }, opts: { expect?: string; validate?: typeof validateControlSettings }) => {
      const problems = opts.validate?.(want.entry as "project", want.project, want.settings) ?? [];
      if (problems.length) throw new Error(problems.join("; "));
      const n = lines.length + 1;
      lines.push(JSON.stringify({ id: `ctl-${String(n).padStart(3, "0")}`, entry: want.entry, project: want.project ?? null, state: "active", settings: want.settings, digest: `d${n}`, at: "2026-10-27T00:00:00Z" }));
      return { id: `ctl-${String(n).padStart(3, "0")}`, status: n === 1 ? "created" : "updated", commit: "c0ffee" };
    },
    retireControlEntry: async () => ({ id: "ctl-001", status: "retired" }),
    importControlConfig: async (_p: unknown, config: { defaults?: Record<string, unknown>; projects: Record<string, Record<string, unknown>> }) =>
      [...(config.defaults ? ["defaults"] : []), ...Object.keys(config.projects)].map((entry, i) => ({ entry, id: `ctl-00${i + 1}`, status: "created" as const })),
    controlConfig: () => ({ projects: {} }),
    reconcileProjects: async () => [],
    describeReconcile: () => "",
    controlDispatchRequest: () => ({}),
  };
  return fake as unknown as ChantControl & { lines: string[]; dispatched: unknown[] };
}

const io = (cwd: string, out: string[] = [], err: string[] = []) => ({ out: (s: string) => out.push(s), err: (s: string) => err.push(s), cwd, env: {} as NodeJS.ProcessEnv });

afterEach(() => setChantControlForTests("reset"));

describe("plywood.yml control", () => {
  it("takes the control repo as a URL, with plywood's Op", () => {
    expect(errors("control: https://github.com/acme/infra-control\n")).toEqual([]);
    expect(toChantSettings(parseConfig("control: https://github.com/acme/infra-control.git\n")).pipeline.control).toEqual({ repo: "github.com/acme/infra-control", op: "pulumi-up" });
  });

  it("maps each snake_case key onto chant's ControlSettingsInput", () => {
    const text = ["control:", "  repo: git.example.com/acme/control", "  forge: forgejo", "  op: deploy", "  member: shop", "  token_secret: SHOP_CONTROL", "  ref: trunk", "  api_base: http://127.0.0.1:3000/api/v1", ""].join("\n");
    expect(errors(text)).toEqual([]);
    expect(controlOf(parseConfig(text).doc)).toEqual({ repo: "git.example.com/acme/control", forge: "forgejo", op: "deploy", member: "shop", tokenSecret: "SHOP_CONTROL", ref: "trunk", apiBase: "http://127.0.0.1:3000/api/v1" });
  });

  it("refuses an unknown key, a bare name and one secret for both tokens", () => {
    const keys = errors(["control:", "  repo: infra-control", "  token: x", "  token_secret: T", "  read_token_secret: T", ""].join("\n")).map((p) => p.key);
    expect(keys).toEqual(expect.arrayContaining(["control.repo", "control.token", "control.read_token_secret"]));
    expect(controlRepoKey("git@github.com:acme/x.git")).toBe("github.com/acme/x");
  });
});

describe("control entries", () => {
  it("checks an entry's settings as plywood.yml's keys, and only the keys a control repo sets", () => {
    expect(validateControlSettings("project", "github.com/acme/shop", { gate: "always", approval_rules: { "shop/*": { role: "sre", quorum: 2 } } })).toEqual([]);
    expect(validateControlSettings("project", "github.com/acme/shop", { stacks: {} })[0]).toContain("is not a key a control repo sets");
    expect(validateControlSettings("defaults", undefined, { gate: "sometimes" }).length).toBe(1);
  });

  it("lays approvers and pins from flags over the current settings", () => {
    expect(settingsFromFlags({ gate: "always" }, ["shop/prod-*=sre:2"], ["pulumi=3.272.0"])).toEqual({
      settings: { gate: "always", approval_rules: { "shop/prod-*": { role: "sre", quorum: 2 } }, pulumi: "3.272.0" },
    });
    expect(settingsFromFlags({}, ["nope"], [])).toHaveProperty("error");
    expect(projectSettings({ gate: "on-destructive", pulumi: "3.272.0" }, { gate: "always" })).toEqual({ gate: "always", pulumi: "3.272.0" });
  });

  it("puts an approver change as a new version on the control repo's ledger", async () => {
    const chant = fakeChant();
    setChantControlForTests(chant);
    const dir = mkdtempSync(join(tmpdir(), "plywood-control-"));
    const out: string[] = [];
    expect(await control(["put", "github.com/acme/shop", "--approver", "shop/prod-*=sre:2"], false, FALLBACK_EXIT, io(dir, out))).toBe(FALLBACK_EXIT.done);
    expect(await control(["put", "github.com/acme/shop", "--pin", "pulumi=3.272.0"], false, FALLBACK_EXIT, io(dir, out))).toBe(FALLBACK_EXIT.done);
    expect(chant.lines.length).toBe(2);
    expect(JSON.parse(chant.lines[1]!).settings).toEqual({ approval_rules: { "shop/prod-*": { role: "sre", quorum: 2 } }, pulumi: "3.272.0" });
    expect(out.join("\n")).toContain("git push origin chant/lifecycle");
  });

  it("imports the reviewed control file", async () => {
    setChantControlForTests(fakeChant());
    const out: string[] = [];
    expect(await control(["import", "control.yml", "--dry-run"], false, FALLBACK_EXIT, io(FIXTURES, out))).toBe(FALLBACK_EXIT.done);
    expect(out).toEqual(["plywood control import: defaults created (ctl-001)", "plywood control import: github.com/acme/shop created (ctl-002)", "plywood control import: github.com/acme/billing created (ctl-003)"]);
  });

  it("lays the control repo's keys over a repository's plywood.yml, and leaves it when they match", () => {
    const text = readFileSync(join(FIXTURES, "shop-plywood.yml"), "utf8");
    const next = controlledConfigText(text, { gate: "on-destructive", approval: "pr-review" })!;
    const doc = parseConfig(next).doc;
    expect(doc.gate).toBe("on-destructive");
    expect(doc.approval).toBe("pr-review");
    expect(doc.control).toBe("github.com/acme/infra-control");
    expect(controlledConfigText(next, { gate: "on-destructive" })).toBeUndefined();
  });
});

describe("plywood control without chant#4568", () => {
  it("says which chant it needs and exits failed", async () => {
    setChantControlForTests(undefined);
    const err: string[] = [];
    expect(await control(["list"], false, FALLBACK_EXIT, io(tmpdir(), [], err))).toBe(FALLBACK_EXIT.failed);
    expect(err[0]).toContain("@intentius/chant/ci-control");
  });

  it("dispatches plywood.yml's control repo with the commit", async () => {
    const chant = fakeChant();
    setChantControlForTests(chant);
    const dir = mkdtempSync(join(tmpdir(), "plywood-dispatch-"));
    writeFileSync(join(dir, "plywood.yml"), "control: github.com/acme/infra-control\n");
    expect(await control(["dispatch", "--sha", "0123abcd"], false, FALLBACK_EXIT, io(dir))).toBe(FALLBACK_EXIT.done);
    expect(chant.dispatched).toEqual([expect.objectContaining({ op: "pulumi-up", sha: "0123abcd" })]);
  });
});

describe("the waves spec's control (chant#4617)", () => {
  const repo = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), "plywood-waves-control-"));
    writeFileSync(join(dir, "plywood.yml"), text);
    return dir;
  };

  it("carries plywood.yml's control with the member resolved, when chant's op waves take it", async () => {
    setChantControlForTests(Object.assign(fakeChant(), { recordControlAppliedFromEnv: async () => ({}) }));
    const dir = repo("control:\n  repo: github.com/acme/infra-control\n  token_secret: PLYWOOD_CONTROL_TOKEN\n");
    const got = await wavesControl(dir);
    expect(got).toEqual({ control: { repo: "github.com/acme/infra-control", op: "pulumi-up", member: expect.any(String), tokenSecret: "PLYWOOD_CONTROL_TOKEN" }, repo: "github.com/acme/infra-control" });
  });

  it("says chant lacks it on a chant before chant#4617, so plywood ci keeps the dispatch advice", async () => {
    setChantControlForTests(fakeChant());
    expect(await wavesControl(repo("control: github.com/acme/infra-control\n"))).toEqual({ missing: expect.stringContaining("chant#4617") });
  });

  it("is none without a control key", async () => {
    setChantControlForTests(fakeChant());
    expect(await wavesControl(repo("gate: always\n"))).toEqual({ none: true });
  });
});
