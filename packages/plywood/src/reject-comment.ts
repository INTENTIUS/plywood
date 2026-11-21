/**
 * `/plywood reject [--stage <stage>] <reason>` on a pull request (plywood#156,
 * chant#5354): chant's comment job records the rejection of the release a
 * stage waits on, as `plywood reject` does from a terminal.
 *
 *   GitHub, Forgejo   under `promotion`, `plywood ci` writes plywood-reject.yml:
 *                     chant's comment job (`productPipelineJobs`'
 *                     `commentJob`, its command, env and job name chant's),
 *                     started by a comment that begins `/plywood reject`
 *                     alone, so every other `/plywood` comment stays with the
 *                     pull request workflow's jobs. It runs at the default
 *                     branch's commit, in plywood's image, and pushes the
 *                     rejection on chant/lifecycle.
 *   GitLab            the pull request workflow's note-commands job answers
 *                     every note, the reject note among them.
 *
 * Both run `plywood components pr-comment` or `pr-notes`, whose words map
 * `reject` (src/words.ts `COMMENT_WORDS`). chant records the rejection when
 * the stage's approval rules take the commenter's forge identity (`ledger`,
 * `pr-review`, `pull-request`); a `sealed` stage, a gate `identity.gates`
 * names, or a rule with `proven` or `roles` takes only a signed rejection,
 * and the reply names the `plywood reject` line to run.
 */
import { ACTION_PINS, usesRef } from "@intentius/chant/action-pins";
import { emitYAMLEntry } from "@intentius/chant/yaml";
import type { ChantProduct, ForgeKind } from "./chant-product";
import { COMMENT_WORDS, PRODUCT, type ProductWordsInput } from "./words";

/** The workflow's file name, beside the pipeline's. */
export const REJECT_WORKFLOW = `${PRODUCT}-reject.yml`;

/** The comment job's name, as chant's `commentJob.jobName` takes it. */
export const REJECT_JOB = "reject";

/** What a comment begins with for the job to start. */
export const REJECT_PREFIX = `/${PRODUCT} reject`;

/** The runner a job runs on when plywood.yml names none: the forge's own default, as chant's generators use. */
const DEFAULT_RUNS_ON: Record<"github" | "forgejo", string> = { github: "ubuntu-latest", forgejo: "docker" };

/** What {@link rejectCommentWorkflow} takes besides chant. */
export interface RejectCommentInput {
  forge: ForgeKind;
  env: string;
  /** The pull request workflow's words; the job takes them with the reject command. */
  words: ProductWordsInput;
  /** plywood's image (src/images.ts `chantPipelineOptions`). */
  image?: string;
  /** The engine install lines every job runs first. */
  beforeScript?: string[];
}

/**
 * The reject workflow's text, or undefined on GitLab, where the note poll
 * answers. chant names the job's command and env (`productPipelineJobs`
 * with `commentJob`); plywood limits it to `/plywood reject`.
 */
export function rejectCommentWorkflow(chant: ChantProduct, i: RejectCommentInput): string | undefined {
  if (i.forge === "gitlab") return undefined;
  const forge = i.forge;
  const jobs = chant.productPipelineJobs(forge, i.env, { words: { ...i.words, commands: { ...COMMENT_WORDS.commands } }, commentJob: { jobName: REJECT_JOB } });
  const c = jobs.comment;
  if (!c) throw new Error("chant returned no comment job for /plywood reject");
  const onPr = forge === "github" ? "github.event.issue.pull_request" : "(github.event.issue.pull_request || github.event.is_pull)";
  // GitHub: only a commenter with write access to the repository; Forgejo's comment job checks the permission itself.
  const trusted = forge === "github" ? [`contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association)`] : [];
  const job: Record<string, unknown> = {
    if: ["github.event_name == 'issue_comment'", onPr, `startsWith(github.event.comment.body, '${REJECT_PREFIX}')`, ...trusted].join(" && "),
    "runs-on": DEFAULT_RUNS_ON[forge],
    ...(i.image ? { container: i.image } : forge === "forgejo" ? { container: "node:22" } : {}),
    // The rejection is a row chant pushes on chant/lifecycle; the reply is a comment on the pull request.
    permissions: { contents: "write", "pull-requests": "write" },
    steps: [
      { name: "Check out the default branch's commit", uses: usesRef(ACTION_PINS.checkout7), with: { "fetch-depth": 0 } },
      ...(i.beforeScript ?? []).map((run) => ({ run })),
      { name: "Record the rejection", env: c.env, run: c.command },
    ],
  };
  const doc: Array<[string, unknown]> = [
    ["name", `${PRODUCT} reject`],
    ["on", { issue_comment: { types: ["created"] } }],
    ["permissions", {}],
    ["concurrency", { group: `${PRODUCT}-reject-\${{ github.event.issue.number }}`, "cancel-in-progress": false }],
    ["jobs", { [c.jobName]: job }],
  ];
  return doc.map(([k, v]) => emitYAMLEntry(k, v)).join("\n") + "\n";
}
