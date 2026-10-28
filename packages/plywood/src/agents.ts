/**
 * Agents (plywood#19): plywood's tools on chant's read-only MCP server, and
 * the review agent's jobs.
 *
 *   plywood mcp [--report-url <url>] [--propose]
 *       chant's `serve mcp --read-only` (chant#4543) in process, with
 *       plywood's tools through chant's product tool hook (chant#4555,
 *       `runChantInProcess(argv, words, { mcp })`). The server serves chant's
 *       read tools (the ledger, the reports, the workspace graph) and
 *       plywood's, `plywood:stacks`, `plywood:settings`, `plywood:tips` and
 *       `plywood:verbs`, each declared read-only. It refuses every run tool:
 *       chant leaves op-run and op-approve out, and will not start with a
 *       product tool named as a write. `--propose` (plywood#41) is chant's
 *       propose tier (chant#4655): the same read tools plus
 *       `plywood:request_from_template`, declared `forgeWrite`, which refuses
 *       every call until plywood has Pulumi templates (plywood#40). On a
 *       chant without the tier, `--propose` exits 1 naming it.
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
import { BUILT_CHANT, type ChantProduct, type ForgeKind } from "./chant-product";
import { configCheck } from "./config-check";
import { reviewOf } from "./config/agents";
import { findConfig, loadConfig, type RawConfig } from "./config/index";
import { stacksOf } from "./config/stacks";
import type { ExitTable } from "./exit-codes";
import { chantPipelineOptions } from "./images";
import { takeFlag, usage, withChant, type StageIo } from "./stages";
import { tipLines, TIPS } from "./tips";
import { BIN, PR_GATE, PRODUCT, PRODUCT_WORDS, TAGLINE, TEMPLATE_REQUEST_WORDS, VERBS, type ProductWordsInput } from "./words";

interface PlywoodMcpToolBase {
  name: string;
  description: string;
  inputSchema: { type: "object"; properties: Record<string, unknown>; required?: string[] };
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/** chant's `McpToolContribution`, as plywood fills it: a read tool, or a tool that opens a pull request (`forgeWrite`, served on `--propose` only, chant#4655). */
export type PlywoodMcpTool = (PlywoodMcpToolBase & { readOnly: true; forgeWrite?: never }) | (PlywoodMcpToolBase & { forgeWrite: true; readOnly?: never });

/** What chant hands the hook's `tools`; a chant before chant#4655 leaves `propose` out. */
export interface PlywoodMcpContext {
  cwd: string;
  readOnly: boolean;
  propose?: boolean;
}

/** chant's `ProductMcpHook` (chant#4555), as plywood fills it; `propose` is chant#4655's tier. */
export interface PlywoodMcpHook {
  product: string;
  tools(ctx: PlywoodMcpContext): PlywoodMcpTool[];
  reportUrl?: string;
  readOnly: true;
  propose?: boolean;
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
      description: "The stacks plywood.yml lists, each with its directory, gate, backend and actions, and the waves they update in.",
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

/**
 * The tools `plywood mcp --propose` adds (chant#4655's tier). Each declares
 * `forgeWrite: true`: it may open a pull request and nothing else.
 * `request_from_template` takes the arguments `plywood request` will, and
 * refuses every call until plywood has Pulumi templates (plywood#40, after
 * the registry in plywood#32).
 */
export function plywoodProposeTools(): PlywoodMcpTool[] {
  return [
    {
      name: TEMPLATE_REQUEST_WORDS.tool,
      description: `Open a pull request for an app from a template, reviewed and gated like a person's. ${TEMPLATE_REQUEST_WORDS.refusal}`,
      inputSchema: {
        type: "object",
        properties: {
          template: { type: "string", description: "The template's name in the catalog." },
          version: { type: "string", description: "The template's version; the newest when left out." },
          name: { type: "string", description: "The app's name, which names its directory and the request branch." },
          app: { type: "string", description: "The app an add-on template joins." },
          inputs: { type: "object", description: "The template's inputs, by name." },
        },
        required: ["template", "name", "inputs"],
      },
      forgeWrite: true,
      handler: async () => {
        throw new Error(TEMPLATE_REQUEST_WORDS.refusal);
      },
    },
  ];
}

const READ_INSTRUCTIONS = `To change a stack, open a pull request: ${PRODUCT} previews it, and its update runs after a person approves the digest.`;

/** The hook `plywood mcp` hands chant; with `propose`, the hook for chant#4655's tier. */
export function plywoodMcpHook(reportUrl?: string, propose = false): PlywoodMcpHook {
  return {
    product: PRODUCT,
    // A read-only server without the tier refuses to start with a forgeWrite tool, so they go only where chant says it serves them.
    tools: (ctx) => [...plywoodMcpTools(ctx), ...(propose && ctx.propose === true ? plywoodProposeTools() : [])],
    readOnly: true,
    ...(propose ? { propose: true } : {}),
    ...(reportUrl ? { reportUrl } : {}),
    instructions: propose
      ? `${PRODUCT} (${TAGLINE}) serves read tools and ${TEMPLATE_REQUEST_WORDS.tool}, which may open a pull request and nothing else. Pulumi templates are not available yet, so ${TEMPLATE_REQUEST_WORDS.tool} refuses every call. ${READ_INSTRUCTIONS}`
      : `${PRODUCT} (${TAGLINE}) serves read tools only. ${READ_INSTRUCTIONS}`,
  };
}

/** The last chant release without the propose tier. */
const PROPOSE_AFTER = "0.124.56";

/** What `plywood mcp --propose` prints on a chant without chant#4655's tier. */
export function needsProposeMessage(): string {
  return (
    `${PRODUCT} mcp --propose needs chant >= the release after ${PROPOSE_AFTER}, which carries the MCP propose tier (PRODUCT_MCP_PROPOSE_FLOOR, chant#4655). ` +
    `This plywood was built with chant ${BUILT_CHANT}, which lacks it. ` +
    "Upgrade plywood once that chant is out, or build against a local chant with 'just chant-local'."
  );
}

/**
 * `plywood mcp [--report-url <url>] [--propose]`: chant's read-only MCP
 * server over stdio, with plywood's tools. `--propose` is chant's propose
 * tier (`serve mcp --read-only --propose`, chant#4655), which also serves
 * plywood's `forgeWrite` tools; on a chant without it, exit 1.
 */
export async function mcp(args: string[], _json: boolean, table: ExitTable, io: StageIo): Promise<number> {
  const propose = args.includes("--propose");
  const report = takeFlag(args.filter((a) => a !== "--propose"), "--report-url");
  if (report.missing) return usage("--report-url takes a URL", table, io);
  if (report.rest.length) return usage(`mcp does not take ${report.rest.join(" ")}`, table, io);
  return withChant(`${PRODUCT} mcp`, table, io, (chant) => {
    // stdout is the protocol's: every word of plywood's goes to stderr.
    if (propose && typeof chant.PRODUCT_MCP_PROPOSE_FLOOR !== "string") {
      io.err(`${PRODUCT}: ${needsProposeMessage()}`);
      return Promise.resolve(table.failed);
    }
    if (typeof chant.PRODUCT_MCP_HOOK_FLOOR !== "string") {
      io.err(`${PRODUCT} mcp: this chant has no product tool hook (chant#4555), so the server serves chant's read tools and none of ${PRODUCT}'s`);
    }
    const argv = ["serve", "mcp", "--read-only", ...(propose ? ["--propose"] : [])];
    return chant.runChantInProcess(argv, PRODUCT_WORDS, { mcp: plywoodMcpHook(report.value, propose) });
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
