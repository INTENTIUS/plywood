/**
 * plywood's words: the names chant's product pipeline fills into its
 * statuses, comments and gates (chant#4550, rulings C, D and E). plywood
 * holds words only; chant runs every stage in process with them.
 */

export const PRODUCT = "plywood";

export const TAGLINE = "CI Automation for Pulumi";

/** The op that applies a merged change, and the gates it passes (chant#4550 ruling E). */
export const OP_NAME = "pulumi-up";
export const PR_GATE = "up";
export const waveGate = (k: number): string => `wave-${k}`;

export type Verb = "check" | "preview" | "up" | "drift" | "approve" | "override";

export interface VerbWords {
  verb: Verb;
  summary: string;
}

/** The verbs, in the order `plywood --help` lists them. */
export const VERBS: readonly VerbWords[] = [
  { verb: "check", summary: "Check plywood.yml and run the check hooks at the base commit" },
  { verb: "preview", summary: "Preview the stacks a pull request reaches, with one note and a status per stack" },
  { verb: "up", summary: "Update the stacks a merged pull request changes, in gated waves" },
  { verb: "drift", summary: "Find stacks whose resources differ from their state" },
  { verb: "approve", summary: "Approve a pull request's previews for up" },
  { verb: "override", summary: "Override a policy denial on a pull request" },
];

/** The command a generated job runs in place of `chant`; the bin passes the rest to chant in process. */
export const BIN = "npx --no-install plywood";

/** chant's comment commands, by the word typed after `/plywood` (chant `CiProductCommand`). */
export type ChantCommand = "plan" | "apply" | "lock" | "unlock" | "agent" | "action";

/**
 * plywood's words in the shape chant's `assertProductWords` takes
 * (`@intentius/chant/ci-product`, chant#4550). chant fills them into its own
 * sentences: the status `plywood/preview/<stack>`, the note heading, the
 * "may register at up" rows (chant#4548), and the approve and override lines.
 */
export interface ProductWordsInput {
  product: string;
  stages: { plan: string; apply: string };
  verbs: { plan: [string, string]; apply: [string, string] };
  noun: [string, string];
  commands: Record<string, ChantCommand>;
  approve: string;
  override: string;
  op: string;
  prGate: string;
  gateName: string;
  approval: "pull-request" | "per-wave";
  bin: string;
  /**
   * What chant's notify sends under these words (chant#4610): the event's
   * `source`, the wave label in its summary and the signed webhook's header
   * prefix. A chant before chant#4610 reads none of it and sends chant's.
   */
  notify?: { source: string; wave: string; headers: string };
}

/** plywood's notify words: receivers route on `plywood` and verify `x-plywood-*` headers. */
export const NOTIFY_WORDS = Object.freeze({ source: PRODUCT, wave: "wave {k} ({name}) of {spec}", headers: `x-${PRODUCT}` });

export const PRODUCT_WORDS: Readonly<ProductWordsInput> = Object.freeze({
  product: PRODUCT,
  stages: { plan: "preview", apply: "up" },
  verbs: { plan: ["preview", "previewed"], apply: ["update", "updated"] },
  noun: ["stack", "stacks"],
  commands: { preview: "plan", up: "apply", lock: "lock", unlock: "unlock" },
  approve: "plywood approve {gate} --plan {digest} {sign}",
  override: "plywood override {gate} --rule {rule} --reason <text>",
  op: OP_NAME,
  prGate: PR_GATE,
  gateName: "wave-{k}",
  approval: "pull-request",
  bin: BIN,
  notify: NOTIFY_WORDS,
} satisfies ProductWordsInput);

/**
 * `/plywood action <stack> <name>` (plywood#39), answered by chant's action
 * job (chant#4654). It is not in PRODUCT_WORDS: a chant before chant#4654
 * has no `action` command and refuses words that name one, so only a
 * pipeline with the action job gets it, through {@link wordsForJobs}.
 */
export const ACTION_COMMAND: Readonly<Record<string, ChantCommand>> = Object.freeze({ action: "action" });

/**
 * The words for a pipeline that has jobs for `jobs` only. chant refuses a
 * comment command with no job to answer it, so `/plywood up` is left out
 * until a pipeline applies, and `/plywood lock` until it locks at preview.
 */
export function wordsForJobs(jobs: readonly ChantCommand[]): ProductWordsInput {
  const commands = Object.fromEntries(Object.entries({ ...PRODUCT_WORDS.commands, ...ACTION_COMMAND }).filter(([, c]) => jobs.includes(c)));
  return { ...PRODUCT_WORDS, commands };
}

/**
 * Policy in plywood's words (plywood#13). chant's gate reads Rego rules
 * (`ci.policy`) and the CrossGuard packs each stack's preview runs, and
 * renders every finding under its stack in the note; these are the words
 * plywood prints around them.
 */
export const POLICY_OUTCOMES = {
  deny: "denies the preview; it updates only under a plywood override",
  hold: "holds the preview for a person's approval, even where the gate would not ask",
  advisory: "is a note line under the stack and blocks nothing",
} as const;

/** The rule id chant gives a CrossGuard policy (`crossGuardRule`, chant's pulumi lexicon), as `plywood override --rule` takes it. */
export function crossGuardRuleId(pack: string, policy: string): string {
  return `crossguard.${pack}.${policy}`;
}

/** How a denial's rule ids read, for the line after a denied preview or update. */
export const POLICY_RULE_FORMS = "a CrossGuard rule is crossguard.<pack>.<policy>, a Rego rule <package>.<rule>";

/**
 * Identity in plywood's words (plywood#14): the two stages that hold one,
 * and what each may do. chant's `ci.identity` trades the forge's OIDC token
 * for them before the program is checked out.
 */
export const IDENTITY_STAGES = {
  preview: "the preview job, which runs the pull request's program: read-only, and never the up identity",
  up: "the update job, which runs the merged program",
} as const;

/** The clouds' names in plywood's lines. */
export const CLOUD_NAMES = { aws: "AWS", gcp: "GCP", azure: "Azure", pulumi: "Pulumi Cloud" } as const;

/** What a stack with no identity for a cloud runs as, for `plywood config identities`. */
export const NO_IDENTITY = "the job's own credentials (no OIDC trade)";

/** The stack operations a gated request runs (src/stack-ops.ts, src/actions.ts). */
export type StackOpVerb = "export" | "cancel" | "move" | "action";

/**
 * The stack operations' words (plywood#16, and plywood#39's actions). They
 * are commands beside the ruled verbs, listed under their own heading in
 * --help. Each is a gated request on the workspace ledger, run by chant's
 * pulumi lexicon once a second person approves it (src/stack-ops.ts).
 */
export const STACK_OP_WORDS = {
  usage: {
    export: `${PRODUCT} export <project/stack> --out <file>`,
    cancel: `${PRODUCT} cancel <project/stack> [--lock <id>]`,
    move: `${PRODUCT} move <urn>... --from <project/stack> --to <project/stack>, or ${PRODUCT} move <project/stack> --onto plunge`,
    rollback: `${PRODUCT} rollback <project/stack> [--digest <sha256:...>], or ${PRODUCT} rollback --release <name> --env <env>`,
    action: `${PRODUCT} action <project/stack> <name> [--anew], or ${PRODUCT} action --from-event`,
  },
  waiting: (verb: StackOpVerb, approve: string): string =>
    `The ${verb} waits for a second person's approval, and your own does not count. They run '${approve}', then you run this command again to carry it out.`,
  spent: (verb: StackOpVerb): string =>
    verb === "action"
      ? "This action ran once already under its approval, and a request runs once. Run the command again with --anew to ask for a new run."
      : `This ${verb} ran once already under its approval, and a request runs once. Run the command again to ask for a new one.`,
  acted: (stack: string, name: string, r: { urn: string; engine: string; tail: string }): string =>
    `Ran action ${name} on ${stack}: ${r.engine} replaced ${r.urn}.${r.tail ? `\n${r.tail}` : ""}`,
  noAction: (stack: string, name: string, declared: readonly string[]): string =>
    declared.length
      ? `${stack} has no action ${name} in plywood.yml; its actions are ${declared.join(", ")}`
      : `${stack} declares no actions in plywood.yml; add one under stacks.${stack}.actions with a name and the URN of a command resource`,
  exported: (stack: string, r: { file: string; sha256: string; bytes: number; resources: number }): string =>
    `Exported ${stack} to ${r.file} (${r.resources} resources, ${r.bytes} bytes, sha256 ${r.sha256}). The file is readable by you alone; the ledger keeps its digest and size, never its content.`,
  cancelled: (stack: string, lock: string, checked: boolean): string =>
    `Released lock ${lock} on ${stack}.${checked ? "" : " The backend's lock could not be read, so it was not checked against the approved one first."}`,
  moved: (from: string, to: string, r: { engine: string; moved: string[] }): string =>
    `Moved ${r.moved.length} resource${r.moved.length === 1 ? "" : "s"} from ${from} to ${to} on ${r.engine}. Both stacks preview no change.`,
  needsLock:
    "cancel needs --lock <id>, the lock the stack holds: the id pulumi printed when it refused the update, or the file name under .pulumi/locks/ on a file:// backend",
  lockNotListed: (backend: string | undefined): string =>
    `cancel needs --lock <id> here: chant reads a stack's lock from a file:// backend only, and this stack's backend is ${backend ?? "not one plywood can find"}. Use the id pulumi printed when it refused the update`,
  noLock: (stack: string): string => `${stack} holds no lock now, so there is nothing to cancel`,
  manyLocks: (stack: string, ids: readonly string[]): string =>
    `${stack} holds ${ids.length} locks (${ids.join(", ")}); name the one to release with --lock <id>`,
  noAdoptOp: (file: string): string =>
    `no ${file}. '${PRODUCT} init --engine plunge' writes it with each stack's adopt preview; run that first.`,
  adoptAll: (stack: string): string =>
    `${PRODUCT} move --onto plunge runs the adopt Op over every stack it lists, ${stack} among them. Each stack waits at its own gate.`,
  adoptWaiting: `Each stack's adoption waits for an approval of its preview's digest. Approve it with the line chant printed (${PRODUCT} approve <gate> --op plywood-adopt --plan <digest>), then run this command again.`,
  rollbackWaiting: `The rollback's preview waits at the release gate. Approve its digest with the line chant printed, then run this command again.`,
  releaseIsEnvWide: (stack: string, env: string): string =>
    `--release rolls back every stack the release records in an environment, so it takes --env, not a stack. Run '${PRODUCT} rollback --release <name> --env ${env}', or '${PRODUCT} rollback ${stack}' for this stack's previous release.`,
} as const;

/**
 * Drift in plywood's words (plywood#8). chant reads each stack's drift
 * (`chant workspace drift`) and keeps one tracking issue per stack through
 * its forge client (`trackIssue`); these are the issue's marker, title and
 * body, and the name of each stack's scheduled drift Op.
 */
export const DRIFT_OP_PREFIX = "plywood-drift-";

/** The scheduled Op that reads `stack`'s drift: `plywood-drift-<project>-<stack>`, kebab-case. */
export function driftOpName(stack: string): string {
  return DRIFT_OP_PREFIX + stack.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/** The hidden first line that finds a stack's drift issue again. */
export function driftIssueMarker(stack: string): string {
  return `<!-- plywood:drift ${stack} -->`;
}

export function driftIssueTitle(stack: string): string {
  return `plywood: ${stack} has drifted`;
}

/** One drifted or missing resource, as the issue lists it. */
export interface DriftRow {
  urn: string;
  status: string;
  attributes: string[];
}

/** A cell that keeps the table's shape. */
function cell(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

/**
 * The issue's body. `fingerprint` names the finding, so a run that finds the
 * same drift leaves the issue as it is (`sameWhen`).
 */
export function driftIssueBody(input: { stack: string; rows: readonly DriftRow[]; observedAt: string; fingerprint: string; runUrl?: string; respond?: string; attribution?: readonly string[] }): string {
  const { stack, rows } = input;
  const lines = [
    driftIssueMarker(stack),
    `plywood's drift check read ${stack} against the cloud at ${input.observedAt} and found ${rows.length} resource${rows.length === 1 ? "" : "s"} that differ from the stack's state.`,
    "",
    "| URN | Status | Attributes |",
    "|---|---|---|",
    ...rows.map((r) => `| \`${cell(r.urn)}\` | ${r.status} | ${r.attributes.length ? r.attributes.map((a) => `\`${cell(a)}\``).join(", ") : ""} |`),
    "",
    ...(input.attribution?.length ? ["Who changed each attribute, from the known writes and the audit log:", "", ...input.attribution, ""] : []),
    `To put the cloud back to the program, merge a change to ${stack} or run \`${PRODUCT} up\`. To keep the cloud's values, change the program to match and let its preview show no changes.`,
    ...(input.respond === "up" ? ["", `respond.drift is up, so this run also asked for an update of ${stack}'s wave; its gate decides.`] : []),
    ...(input.runUrl ? ["", `Read by ${input.runUrl}.`] : []),
    "",
    `<!-- plywood:drift-fingerprint ${input.fingerprint} -->`,
  ];
  return lines.join("\n");
}

/** Posted on the issue when a clean run closes it. */
export function driftClearedComment(stack: string, observedAt: string): string {
  return `plywood's drift check at ${observedAt} found ${stack} matching its state, so this issue is closed.`;
}

/**
 * The engines in plywood's words (plywood#17): what each does at each stage,
 * as `plywood config check` and the site's engine table say it. chant's
 * pulumi lexicon does all of it; these are the sentences.
 */
export const ENGINE_WORDS = {
  pulumi: {
    lock: "the backend's stack lock orders updates to a stack, so plywood locks per stack",
    up: "up previews again and checks the fresh preview against the approved one",
    moved: "a preview that moved since its approval is refused with chant's moved code",
    progress: "each stack's span in the up job's trace",
  },
  plunge: {
    lock: "no stack lock: each record write is conditional, so plywood locks per resource and two updates to different resources of one stack run side by side",
    up: "up applies the preview job's saved plan, stamped with the version of each record it read",
    moved: "a saved plan whose records moved is refused with chant's moved code, the same code as a stock stack's moved preview",
    progress: "a span per resource in the up job's trace and run record, with its provider and record times",
  },
} as const;

/** The lock grain in plywood's words, for `plywood config check`. */
export const LOCK_GRAIN_WORDS = {
  perEngine: (engine: "pulumi" | "plunge" | undefined): string =>
    engine === "plunge"
      ? "resource, plunge's default (no ci.lockGrain; chant's pulumi lexicon sets it)"
      : engine === "pulumi"
        ? "stack, stock Pulumi's default (no ci.lockGrain; chant's pulumi lexicon sets it)"
        : "per engine: resource on plunge, stack on stock Pulumi (no ci.lockGrain; chant's pulumi lexicon sets it)",
} as const;

/**
 * The span attributes chant writes for a plunge update's timings
 * (chant#4579, `plungeTimingTotals` and `plungeTimingSpans`), under
 * plywood's prefix. The dashboard preset reads them.
 */
export const PLUNGE_TIMING_ATTRIBUTES = {
  resources: `${PRODUCT}.plunge.resources`,
  calls: `${PRODUCT}.plunge.calls`,
  providerMs: `${PRODUCT}.plunge.provider_ms`,
  recordMs: `${PRODUCT}.plunge.record_ms`,
  failedCalls: `${PRODUCT}.plunge.failed_calls`,
  slowestUrn: `${PRODUCT}.plunge.slowest.urn`,
  slowestMs: `${PRODUCT}.plunge.slowest.ms`,
} as const;
