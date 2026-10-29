/**
 * Day-2 actions (plywood#39): the `actions` key, `plywood action` on a fake
 * gatedStackAction (chant#4654), `--from-event`, and the action job in the
 * pipeline. No engine runs: the lexicon and chant's product entry are fakes,
 * apart from the golden, which renders the workflow with the installed chant
 * when it has the action job.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { action, actionSubject, setChantStackActionForTests, type ActionResult, type ChantStackAction } from "../src/actions";
import { main, type Io } from "../src/cli";
import { chantProduct, setChantProductForTests, type ChantProduct, type ProductActionRequest, type ProductPipelineOptions } from "../src/chant-product";
import { checkConfig, parseConfig } from "../src/config/index";
import { plywoodMcpTools } from "../src/agents";
import { FALLBACK_EXIT } from "../src/exit-codes";
import { setChantStackOpsForTests, type StackOpOutcome } from "../src/stack-ops";
import { ACTIONS_NOT_ON_GITLAB, ci, workflowPlan, type StageIo } from "../src/stages";
import { PRODUCT_WORDS, wordsForJobs } from "../src/words";

const T = FALLBACK_EXIT;
const ROTATE = "urn:pulumi:prod-us::shop::command:local:Command::rotate";
const AFTER = "urn:pulumi:prod-us::shop::aws:ssm/parameter:Parameter::reads-rotate";
const YML = `stacks:\n  shop/prod-us:\n    dir: .\n    actions:\n      - name: rotate\n        urn: ${ROTATE}\n        description: rotate the signing key\n  shop/dev: {}\n`;

function io(cwd: string, env: NodeJS.ProcessEnv = {}): StageIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, env, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

function repo(yml = YML): string {
  const dir = mkdtempSync(join(tmpdir(), "plywood-actions-"));
  mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "plywood.yml"), yml);
  return dir;
}

/** chant's PulumiStackActionRefused, as a fake throws it. */
function refused(code: string, message: string, urns: string[] = []): Error {
  return Object.assign(new Error(`${code}: ${message}`), { name: "PulumiStackActionRefused", code, urns });
}

/**
 * A fake gatedStackAction over an in-memory ledger: it previews (a fixture
 * of steps), refuses a preview that changes more than the URN, waits until
 * `approve` records a second person's approval, then runs once.
 */
function fakeLexicon(preview: Array<{ op: string; urn: string }> = [{ op: "replace", urn: ROTATE }]) {
  const calls: Array<Record<string, unknown>> = [];
  const approvals = new Set<string>();
  const applied = new Set<string>();
  const digest = "sha256:" + "a".repeat(64);
  const fn: ChantStackAction = async (opts) => {
    calls.push(opts as unknown as Record<string, unknown>);
    if (!opts.urn.split("::")[2]!.startsWith("command:")) throw refused("action-type", `${opts.urn} is not a command resource`);
    const others = preview.filter((s) => s.urn !== opts.urn && s.op !== "same").map((s) => s.urn);
    if (others.length) throw refused("action-scope", `the preview also changes ${others.join(", ")}`, others);
    const subject = `action:${opts.stack}:${opts.name}`;
    if (applied.has(subject) && !opts.anew) return { status: "spent", digest };
    if (opts.anew) applied.delete(subject);
    if (!approvals.has(subject)) return { status: "waiting", digest, command: "chant approve" };
    approvals.delete(subject);
    applied.add(subject);
    const result: ActionResult = { urn: opts.urn, engine: "pulumi", preview: digest, exit: 0, tail: "Resources: 1 replaced" };
    return { status: "done", digest, result } as StackOpOutcome<ActionResult>;
  };
  return { fn, calls, digest, approve: (subject: string) => approvals.add(subject) };
}

/** A fake chant product entry, with the action job (chant#4654). */
function fakeChant() {
  const pipelines: ProductPipelineOptions[] = [];
  const calls: string[][] = [];
  const api: ChantProduct = {
    assertProductWords: (w) => w as never,
    productPipelineJobs: (_forge, _env, options) => {
      pipelines.push(options);
      const words = options.words as typeof PRODUCT_WORDS;
      return {
        words: { ...words, stages: { ...words.stages } },
        plan: { jobName: "plan", command: "npx --no-install plywood components pr-plan --gate up" },
        post: { command: "npx --no-install plywood components pr-post" },
        comments: {},
        ...(options.actionJob ? { action: { jobName: "action", comment: "/plywood action", inputs: { member: "stack", action: "action" }, command: "npx --no-install plywood action --from-event" } } : {}),
      };
    },
    approveLine: () => "",
    runChantInProcess: async (argv) => {
      calls.push(argv);
      const out = argv.indexOf("--output");
      if (argv[0] === "build" && out >= 0) {
        mkdirSync(dirname(argv[out + 1]!), { recursive: true });
        writeFileSync(argv[out + 1]!, "jobs: {}\n");
      }
      return 0;
    },
    productActionFromEnv: (_w, env): ProductActionRequest => {
      const comment = env.CHANT_ACTION_COMMENT;
      if (comment) {
        const [, verb, member, address] = comment.trim().split(/\s+/);
        return verb === "action" && member && address ? { kind: "action", member, address, from: "comment" } : { kind: "refused", reason: "not an action comment" };
      }
      return env.CHANT_ACTION_MEMBER && env.CHANT_ACTION ? { kind: "action", member: env.CHANT_ACTION_MEMBER, address: env.CHANT_ACTION, from: "dispatch" } : { kind: "refused", reason: "a dispatched action names a stack and an action" };
    },
  };
  return { api, pipelines, calls };
}

afterEach(() => {
  setChantStackActionForTests("reset");
  setChantStackOpsForTests("reset");
  setChantProductForTests("reset");
});

describe("plywood.yml's actions", () => {
  const silent: Io = { out: () => {}, err: () => {} };

  it("config check refuses a URN that is not a command resource, naming actions[0].urn and the type, and passes a command:local:Command", async () => {
    const bad = join(repo(), "bad.yml");
    writeFileSync(bad, "stacks:\n  app/prod:\n    actions:\n      - name: rotate\n        urn: urn:pulumi:prod::app::aws:s3/bucket:Bucket::b\n");
    const lines: string[] = [];
    expect(await main(["config", "check", "--file", bad], { out: (s) => lines.push(s), err: (s) => lines.push(s) })).toBe(1);
    expect(lines.join("\n")).toContain("stacks.app/prod.actions[0].urn");
    expect(lines.join("\n")).toContain("aws:s3/bucket:Bucket");
    const good = join(repo(), "good.yml");
    writeFileSync(good, "stacks:\n  app/prod:\n    actions:\n      - name: rotate\n        urn: urn:pulumi:prod::app::command:local:Command::rotate\n");
    expect(await main(["config", "check", "--file", good], silent)).toBe(0);
  });

  it("refuses a duplicate name, a bad name, a URN on another stack, and a key it does not know", () => {
    const problems = checkConfig(parseConfig(
      "stacks:\n  app/prod:\n    actions:\n" +
      "      - { name: rotate, urn: 'urn:pulumi:prod::app::command:local:Command::a' }\n" +
      "      - { name: rotate, urn: 'urn:pulumi:prod::app::command:remote:Command::b' }\n" +
      "      - { name: 'two words', urn: 'urn:pulumi:dev::app::command:local:Command::c' }\n" +
      "      - { name: d, urn: 'not-a-urn', when: daily }\n",
    )).filter((p) => p.severity === "error");
    const text = problems.map((p) => `${p.key} ${p.message}`).join("\n");
    expect(text).toContain("stacks.app/prod.actions[1].name rotate is the name of actions[0] too");
    expect(text).toContain("stacks.app/prod.actions[2].name");
    expect(text).toContain("stacks.app/prod.actions[2].urn urn:pulumi:dev::app::command:local:Command::c names stack dev");
    expect(text).toContain("stacks.app/prod.actions[3].urn not-a-urn is not a resource URN");
    expect(text).toContain("stacks.app/prod.actions[3].when is not a key");
    expect(checkConfig(parseConfig("stacks:\n  app/prod:\n    actions: rotate\n")).map((p) => p.key)).toContain("stacks.app/prod.actions");
  });

  it("show in the stacks MCP tool's answer", async () => {
    const stacks = plywoodMcpTools({ cwd: repo() }).find((t) => t.name === "stacks")!;
    const answer = (await stacks.handler({})) as { stacks: Record<string, { actions?: unknown }> };
    expect(answer.stacks["shop/prod-us"]!.actions).toEqual([{ name: "rotate", urn: ROTATE, description: "rotate the signing key" }]);
  });
});

describe("plywood action", () => {
  it("waits with exit 3 and the approve line, then runs once after a second person's approval", async () => {
    const lex = fakeLexicon();
    setChantStackActionForTests(lex.fn);
    const dir = repo();
    const first = io(dir, { USER: "alice" });
    expect(await action(["shop/prod-us", "rotate"], true, T, first)).toBe(3);
    const waiting = JSON.parse(first.stdout[0]!);
    expect(waiting).toMatchObject({ command: "action", status: "waiting", op: "pulumi-stack-ops", gate: "action:prod-us:rotate", digest: lex.digest });
    expect(waiting.approve).toBe(`plywood approve action:prod-us:rotate --op pulumi-stack-ops --plan ${lex.digest}`);
    expect(lex.calls[0]).toMatchObject({ by: "alice", stack: "prod-us", urn: ROTATE, name: "rotate", op: "pulumi-stack-ops", dir });
    expect(lex.calls[0]!.anew).toBeUndefined();

    lex.approve(actionSubject("prod-us", "rotate"));
    const second = io(dir, { USER: "alice" });
    expect(await action(["shop/prod-us", "rotate"], true, T, second)).toBe(0);
    expect(JSON.parse(second.stdout[0]!)).toMatchObject({ status: "done", ok: true, result: { urn: ROTATE, exit: 0 } });

    const again = io(dir);
    expect(await action(["shop/prod-us", "rotate"], false, T, again)).toBe(1);
    expect(again.stderr.join("\n")).toContain("--anew");
    const anew = io(dir);
    expect(await action(["shop/prod-us", "rotate", "--anew"], false, T, anew)).toBe(3);
    expect(lex.calls.at(-1)!.anew).toBe(true);
    expect(anew.stderr.join("\n")).toContain("plywood approve action:prod-us:rotate --op pulumi-stack-ops --plan");
  });

  it("exits 1 with action-scope naming the second URN when the preview replaces two resources", async () => {
    const lex = fakeLexicon([{ op: "replace", urn: ROTATE }, { op: "replace", urn: AFTER }]);
    setChantStackActionForTests(lex.fn);
    const o = io(repo());
    expect(await action(["shop/prod-us", "rotate"], true, T, o)).toBe(1);
    const out = JSON.parse(o.stdout[0]!);
    expect(out).toMatchObject({ ok: false, exitCode: 1, refusal: "action-scope", urns: [AFTER] });
    expect(out.error).toContain(AFTER);
  });

  it("refuses an action plywood.yml does not declare, and a bare stack name, before asking chant", async () => {
    const lex = fakeLexicon();
    setChantStackActionForTests(lex.fn);
    const o = io(repo());
    expect(await action(["shop/prod-us", "restart"], false, T, o)).toBe(1);
    expect(o.stderr[0]).toContain("its actions are rotate");
    const none = io(repo());
    expect(await action(["shop/dev", "rotate"], false, T, none)).toBe(1);
    expect(none.stderr[0]).toContain("declares no actions");
    const bare = io(repo());
    expect(await action(["prod-us", "rotate"], false, T, bare)).toBe(1);
    expect(bare.stderr[0]).toContain("project/stack");
    expect(lex.calls).toEqual([]);
  });

  it("is dispatched by the CLI", async () => {
    const lines: string[] = [];
    expect(await main(["action"], { out: (s) => lines.push(s), err: (s) => lines.push(s) })).toBe(1);
    expect(lines.join("\n")).toContain("action takes a stack and an action's name");
  });
});

describe("plywood action --from-event", () => {
  it("reads a comment or a dispatch through chant's productActionFromEnv, and asks anew", async () => {
    const lex = fakeLexicon();
    setChantStackActionForTests(lex.fn);
    setChantProductForTests(fakeChant().api);
    const dir = repo();
    expect(await action(["--from-event"], false, T, io(dir, { GITHUB_ACTOR: "bob", CHANT_ACTION_COMMENT: "/plywood action shop/prod-us rotate" }))).toBe(3);
    expect(lex.calls[0]).toMatchObject({ by: "bob", stack: "prod-us", name: "rotate", anew: true });
    expect(await action(["--from-event"], false, T, io(dir, { GITHUB_ACTOR: "bob", CHANT_ACTION_MEMBER: "shop/prod-us", CHANT_ACTION: "rotate" }))).toBe(3);
    expect(lex.calls).toHaveLength(2);
  });

  it("refuses what chant refuses, positionals beside it, and a chant without the action job", async () => {
    setChantStackActionForTests(fakeLexicon().fn);
    setChantProductForTests(fakeChant().api);
    const o = io(repo(), { CHANT_ACTION_MEMBER: "shop/prod-us" });
    expect(await action(["--from-event"], false, T, o)).toBe(1);
    expect(o.stderr[0]).toContain("names a stack and an action");
    expect(await action(["--from-event", "shop/prod-us"], false, T, io(repo()))).toBe(1);
  });
});

describe("the action job in the pipeline (chant#4654)", () => {
  it("asks chant for the action job and /plywood action when plywood.yml declares actions", async () => {
    const chant = fakeChant();
    setChantProductForTests(chant.api);
    const o = io(repo());
    expect(await ci(["--forge", "github"], false, T, o)).toBe(0);
    expect(chant.pipelines[0]!.actionJob).toBe(true);
    expect((chant.pipelines[0]!.words as typeof PRODUCT_WORDS).commands).toMatchObject({ action: "action" });
    expect(chant.calls[0]).toContain("--action-job");
    expect(o.stderr.join("\n")).toContain("action    npx --no-install plywood action --from-event");
  });

  it("leaves it out with no actions, and on GitLab, saying why", () => {
    const doc = parseConfig(YML).doc;
    const plain = workflowPlan(fakeChant().api, parseConfig("stacks:\n  shop/dev: {}\n").doc, "github", "production", undefined);
    expect(plain.argv).not.toContain("--action-job");
    expect(plain.words.commands).not.toHaveProperty("action");
    const gitlab = workflowPlan(fakeChant().api, doc, "gitlab", "production", undefined);
    expect(gitlab.argv).not.toContain("--action-job");
    expect(gitlab.notes).toContain(ACTIONS_NOT_ON_GITLAB);
  });

  it("keeps /plywood action out of the words a pipeline without the job gets", () => {
    expect(PRODUCT_WORDS.commands).not.toHaveProperty("action");
    expect(wordsForJobs(["plan", "action"]).commands).toEqual({ preview: "plan", action: "action" });
  });
});

// The golden: the action job chant renders for plywood's words on GitHub and Forgejo, with the installed chant.
const real = await chantProduct();
const GOLDEN = join(import.meta.dirname, "fixtures", "actions");

describe.runIf(real !== undefined)("the rendered action job (golden, chant#4654)", () => {
  for (const forge of ["github", "forgejo"] as const) {
    it(`carries workflow_dispatch inputs stack and action on ${forge}`, async () => {
      setChantProductForTests("reset");
      const chant = (await chantProduct())!;
      const plan = workflowPlan(chant, parseConfig(YML).doc, forge, "production", undefined);
      expect(plan.argv).toContain("--action-job");
      expect(plan.jobs.action).toMatchObject({ inputs: { member: "stack", action: "action" }, command: "npx --no-install plywood action --from-event" });
      const dir = repo();
      writeFileSync(join(dir, "plywood.component.ts"), 'export const shop_prod_us = {"name":"shop-prod-us","dependsOn":[],"deploy":[{"phase":"up","steps":[{"kind":"pulumi-up","dir":".","stack":"prod-us","member":"shop"}]}]};\n');
      writeFileSync(join(dir, "chant.config.ts"), 'export default { lexicons: ["pulumi"] };\n');
      const out = join(dir, "workflow.yml");
      const argv = [...plan.argv.map((a) => (a === "." ? dir : a)), "--output", out];
      expect(await chant.runChantInProcess(argv, plan.prWords)).toBe(0);
      expect(existsSync(out)).toBe(true);
      const yml = readFileSync(out, "utf8");
      const golden = join(GOLDEN, `action-job.${forge}.yml`);
      const job = actionJobText(yml);
      if (!existsSync(golden) || process.env.PLYWOOD_UPDATE_GOLDEN === "1") {
        mkdirSync(GOLDEN, { recursive: true });
        writeFileSync(golden, job);
      }
      expect(job).toBe(readFileSync(golden, "utf8"));
      expect(job).toMatch(/workflow_dispatch:\n\s+inputs:\n\s+stack:/);
      expect(job).toMatch(/\n\s+action:\n\s+description:/);
    });
  }
});

/** The workflow's trigger block and its action job, the part plywood's action verb is answered by; chant's engine install line is left as a marker, since it moves with chant's engine pin. */
function actionJobText(yml: string): string {
  const lines = yml.split("\n").map((l) => (/^\s+- run: '\{ command -v pulumi /.test(l) ? l.replace(/- run: .*/, "- run: <chant's engine install>") : l));
  const on = lines.findIndex((l) => /^on:/.test(l));
  const jobs = lines.findIndex((l) => /^jobs:/.test(l));
  const trigger = lines.slice(on, lines.findIndex((l, i) => i > on && /^\S/.test(l)));
  const start = lines.findIndex((l, i) => i > jobs && /^ {2}action:/.test(l));
  const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
  return [...trigger, "jobs:", ...lines.slice(start, end < 0 ? undefined : end)].join("\n").trimEnd() + "\n";
}
