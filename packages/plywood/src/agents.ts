/**
 * Agents (plywood#19): plywood's tools on chant's read-only MCP server, and
 * the review agent's jobs.
 *
 *   plywood mcp [--report-url <url>]
 *       chant's `serve mcp --read-only` (chant#4543) in process, with
 *       plywood's tools through chant's product tool hook (chant#4555,
 *       `runChantInProcess(argv, words, { mcp })`). The server serves chant's
 *       read tools (the ledger, the reports, the workspace graph) and
 *       plywood's, `plywood:stacks`, `plywood:settings`, `plywood:tips` and
 *       `plywood:verbs`, each declared read-only. It refuses every run tool:
 *       chant leaves op-run and op-approve out, and will not start with a
 *       product tool named as a write.
 *
 *   plywood ci, with `review` set
 *       writes ops/plywood-review.op.ts, a pull request Op that previews
 *       the change (writing .chant/pr/change-set.json) and runs chant's
 *       reviewAgent step in handoff mode, and .chant/ops/plywood-review.spec.json
 *       with `reviewAgent: true`, then has chant's Op pipeline generator
 *       write the two jobs: the review, with no forge write token, and the
 *       note job that posts its one note. On GitLab the note job runs from a
 *       default-branch schedule (chant#4544).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { toChantSettings } from "./chant-config";
import type { ChantProduct, ForgeKind } from "./chant-product";
import { configCheck } from "./config-check";
import { reviewOf } from "./config/agents";
import { findConfig, loadConfig, type RawConfig } from "./config/index";
import { stacksOf } from "./config/stacks";
import type { ExitTable } from "./exit-codes";
import { chantPipelineOptions } from "./images";
import { takeFlag, usage, withChant, type StageIo } from "./stages";
import { tipLines, TIPS } from "./tips";
import { BIN, PR_GATE, PRODUCT, PRODUCT_WORDS, TAGLINE, VERBS, type ProductWordsInput } from "./words";

/** chant's `McpToolContribution`, as plywood fills it. */
export interface PlywoodMcpTool {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
  readOnly: true;
}

/** chant's `ProductMcpHook` (chant#4555), as plywood fills it. */
export interface PlywoodMcpHook {
  product: string;
  tools(ctx: { cwd: string; readOnly: boolean }): PlywoodMcpTool[];
  reportUrl?: string;
  readOnly: true;
  instructions: string;
}

/** The verbs that need a person, for `plywood:verbs`: an agent opens a pull request and leaves these to a person. */
export const PERSON_VERBS = ["up", "approve", "override"] as const;

/** plywood's read tools. Each reads plywood.yml or plywood's own words, and changes nothing. */
export function plywoodMcpTools(ctx: { cwd: string }): PlywoodMcpTool[] {
  const none = { type: "object" as const, properties: {} };
  const doc = (): RawConfig => {
    const file = findConfig(ctx.cwd);
    return file ? loadConfig(file).doc : {};
  };
  return [
    {
      name: "stacks",
      description: "The stacks plywood.yml lists, each with its directory, gate and backend, and the waves they update in.",
      inputSchema: none,
      readOnly: true,
      handler: async () => {
        const d = doc();
        return { stacks: stacksOf(d), waves: Array.isArray(d.waves) ? d.waves : null };
      },
    },
    {
      name: "settings",
      description: "plywood.yml checked, with every problem and the settings in force, as `plywood config check --json` prints them.",
      inputSchema: none,
      readOnly: true,
      handler: async () => {
        const r = configCheck(ctx.cwd);
        return { ok: r.ok, ...r.envelope };
      },
    },
    {
      name: "tips",
      description: "The tips a plywood preview can name, such as a rename with no aliases.",
      inputSchema: none,
      readOnly: true,
      handler: async () => ({ tips: TIPS, text: tipLines().join("\n") }),
    },
    {
      name: "verbs",
      description: "plywood's commands, and which of them a person runs: an agent opens a pull request, and the update, approvals and overrides stay with people.",
      inputSchema: none,
      readOnly: true,
      handler: async () => ({ verbs: VERBS, person: PERSON_VERBS }),
    },
  ];
}

/** The hook `plywood mcp` hands chant. */
export function plywoodMcpHook(reportUrl?: string): PlywoodMcpHook {
  return {
    product: PRODUCT,
    tools: (ctx) => plywoodMcpTools(ctx),
    readOnly: true,
    ...(reportUrl ? { reportUrl } : {}),
    instructions: `${PRODUCT} (${TAGLINE}) serves read tools only. To change a stack, open a pull request: ${PRODUCT} previews it, and its update runs after a person approves the digest.`,
  };
}

/** `plywood mcp [--report-url <url>]`: chant's read-only MCP server over stdio, with plywood's tools. */
export async function mcp(args: string[], _json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const report = takeFlag(args, "--report-url");
  if (report.missing) return usage("--report-url takes a URL", table, io);
  if (report.rest.length) return usage(`mcp does not take ${report.rest.join(" ")}`, table, io);
  return withChant(`${PRODUCT} mcp`, table, io, (chant) => {
    // stdout is the protocol's: every word of plywood's goes to stderr.
    if (typeof chant.PRODUCT_MCP_HOOK_FLOOR !== "string") {
      io.err(`${PRODUCT} mcp: this chant has no product tool hook (chant#4555), so the server serves chant's read tools and none of ${PRODUCT}'s`);
    }
    return chant.runChantInProcess(["serve", "mcp", "--read-only"], PRODUCT_WORDS, { mcp: plywoodMcpHook(report.value) });
  });
}

/** The pull request Op `plywood ci` writes for the review agent. */
export const REVIEW_OP = "plywood-review";
export const REVIEW_OP_FILE = "ops/plywood-review.op.ts";
export const REVIEW_SPEC_FILE = ".chant/ops/plywood-review.spec.json";
/** Where the preview in the review job writes the change set the model reads. */
export const REVIEW_CHANGE_SET = ".chant/pr/change-set.json";

/**
 * The preview the review job runs before the model: chant's pr-plan through
 * plywood's bin, with the base branch and the pull request's number read
 * from the forge's variables, and nothing posted.
 */
export const REVIEW_PREVIEW_LINE =
  `${BIN} components pr-plan --base "origin/\${GITHUB_BASE_REF:-$CI_MERGE_REQUEST_TARGET_BRANCH_NAME}" ` +
  `--pr "\${CI_MERGE_REQUEST_IID:-$(node -p 'require(process.env.GITHUB_EVENT_PATH).pull_request.number')}" --gate ${PR_GATE} --no-status`;

/** The review Op's file: a preview, then chant's reviewAgent in handoff mode. */
export function reviewOpFile(doc: RawConfig): string {
  const r = reviewOf(doc) ?? { keyEnv: "ANTHROPIC_API_KEY" };
  const step: Record<string, unknown> = {
    op: REVIEW_OP,
    changeSetFile: REVIEW_CHANGE_SET,
    mode: "handoff",
    ...(r.instructions ? { instructions: r.instructions } : {}),
    ...(r.command ? { command: r.command } : {}),
    keyEnv: r.keyEnv,
    ...(r.timeout ? { timeout: r.timeout } : {}),
  };
  const fields = Object.entries(step).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(", ");
  return [
    `// Written by '${PRODUCT} ci' from plywood.yml's review key, and written again on each run: edit plywood.yml, not this file.`,
    `// The model reviews the pull request against its stacks' previews and posts one note. It approves and gates nothing.`,
    `import { Op, phase, reviewAgent, shell } from "@intentius/chant/op";`,
    "",
    "export default Op({",
    `  name: ${JSON.stringify(REVIEW_OP)},`,
    `  overview: "A model reviews the pull request against its stacks' previews",`,
    "  phases: [",
    `    phase("Preview", [shell(${JSON.stringify(REVIEW_PREVIEW_LINE)})]),`,
    `    phase("Review", [reviewAgent({ ${fields} })]),`,
    "  ],",
    "});",
    "",
  ].join("\n");
}

/** chant's scheduled Op spec for the review jobs. */
export function reviewOpSpec(doc: RawConfig): { ops: unknown[]; options: Record<string, unknown> } {
  const settings = toChantSettings({ doc });
  const p = settings.pipeline;
  const engine = chantPipelineOptions({ ...(p.image ? { image: p.image } : {}), ...(p.engineSetup ? { engineSetup: p.engineSetup } : {}) }, false);
  return {
    ops: [
      {
        name: REVIEW_OP,
        trigger: { kind: "pull_request" },
        reviewAgent: true,
        // The preview in the review job takes the preview identity; id-token is the one write the review job may hold.
        ...(settings.ci.identity ? { permissions: { "id-token": "write" } } : {}),
      },
    ],
    options: {
      ...(engine.beforeScript ? { beforeScript: engine.beforeScript } : {}),
      ...(engine.image ? { image: engine.image } : {}),
    },
  };
}

const OP_OUTPUT_DIR: Readonly<Record<ForgeKind, string>> = { github: ".github/workflows", forgejo: ".forgejo/workflows", gitlab: "." };

function writeIfChanged(cwd: string, file: string, text: string): boolean {
  const path = join(cwd, file);
  if (existsSync(path) && readFileSync(path, "utf8") === text) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return true;
}

/** The review agent's jobs, for `plywood ci`. Nothing when plywood.yml has no `review`. */
export async function writeReviewJobs(chant: ChantProduct, forge: ForgeKind, doc: RawConfig, words: ProductWordsInput, table: ExitTable, io: StageIo): Promise<number> {
  if (!reviewOf(doc)) return table.done;
  if (writeIfChanged(io.cwd, REVIEW_OP_FILE, reviewOpFile(doc))) io.err(`${PRODUCT} ci: wrote ${REVIEW_OP_FILE}; commit it with the workflow`);
  if (writeIfChanged(io.cwd, REVIEW_SPEC_FILE, JSON.stringify(reviewOpSpec(doc), null, 2) + "\n")) io.err(`${PRODUCT} ci: wrote ${REVIEW_SPEC_FILE}`);
  const outDir = OP_OUTPUT_DIR[forge];
  const code = await chant.runChantInProcess(["run", "--generate", forge, "--spec", REVIEW_SPEC_FILE, "--output", outDir], words);
  if (code !== table.done) return code;
  const dir = join(io.cwd, outDir);
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f) && (readFileSync(join(dir, f), "utf8").split("\n", 1)[0] ?? "").includes(`--spec ${REVIEW_SPEC_FILE}`))
    : [];
  for (const f of files) io.err(`${PRODUCT} ci: review jobs at ${join(outDir, f).replace(/^\.\//, "")}`);
  const r = reviewOf(doc)!;
  io.err(`${PRODUCT} ci: the review job reads the model's key from ${r.keyEnv}; set it from a secret`);
  if (forge === "gitlab") io.err(`${PRODUCT} ci: on GitLab the note job runs on the default branch with CHANT_REVIEW_NOTES=1 from a pipeline schedule, and posts with a protected CHANT_FORGE_TOKEN`);
  return table.done;
}
