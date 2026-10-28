/**
 * plywood's words: the names chant's product pipeline fills into its
 * statuses, comments and gates (chant#4550, rulings C, D and E). plywood
 * holds words only; chant runs every stage in process with them.
 */

export const PRODUCT = "plywood";

export const TAGLINE = "Pull request automation for Pulumi";

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
export type ChantCommand = "plan" | "apply" | "lock" | "unlock" | "agent";

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
}

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
} satisfies ProductWordsInput);

/**
 * The words for a pipeline that has jobs for `jobs` only. chant refuses a
 * comment command with no job to answer it, so `/plywood up` is left out
 * until a pipeline applies, and `/plywood lock` until it locks at preview.
 */
export function wordsForJobs(jobs: readonly ChantCommand[]): ProductWordsInput {
  const commands = Object.fromEntries(Object.entries(PRODUCT_WORDS.commands).filter(([, c]) => jobs.includes(c)));
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

/**
 * The stack operations' words (plywood#16). They are commands beside the
 * ruled verbs, listed under their own heading in --help. Each is a gated request on the
 * workspace ledger, run by chant's pulumi lexicon once a second person
 * approves it (src/stack-ops.ts).
 */
export const STACK_OP_WORDS = {
  usage: {
    export: `${PRODUCT} export <project/stack> --out <file>`,
    cancel: `${PRODUCT} cancel <project/stack> --lock <id>`,
    move: `${PRODUCT} move <urn>... --from <project/stack> --to <project/stack>, or ${PRODUCT} move <project/stack> --onto plunge`,
    rollback: `${PRODUCT} rollback <project/stack> [--digest <sha256:...>], or ${PRODUCT} rollback --release <name> --env <env>`,
  },
  waiting: (verb: "export" | "cancel" | "move", approve: string): string =>
    `The ${verb} waits for a second person's approval, and your own does not count. They run '${approve}', then you run this command again to carry it out.`,
  spent: (verb: "export" | "cancel" | "move"): string =>
    `This ${verb} ran once already under its approval, and a request runs once. Run the command again to ask for a new one.`,
  exported: (stack: string, r: { file: string; sha256: string; bytes: number; resources: number }): string =>
    `Exported ${stack} to ${r.file} (${r.resources} resources, ${r.bytes} bytes, sha256 ${r.sha256}). The file is readable by you alone; the ledger keeps its digest and size, never its content.`,
  cancelled: (stack: string, lock: string, checked: boolean): string =>
    `Released lock ${lock} on ${stack}.${checked ? "" : " The backend's lock could not be read, so it was not checked against the approved one first."}`,
  moved: (from: string, to: string, r: { engine: string; moved: string[] }): string =>
    `Moved ${r.moved.length} resource${r.moved.length === 1 ? "" : "s"} from ${from} to ${to} on ${r.engine}. Both stacks preview no change.`,
  needsLock:
    "cancel needs --lock <id>, the lock the stack holds: the id pulumi printed when it refused the update, or the file name under .pulumi/locks/ on a file:// backend",
  noAdoptOp: (file: string): string =>
    `no ${file}. '${PRODUCT} init --engine plunge' writes it with each stack's adopt preview; run that first.`,
  adoptAll: (stack: string): string =>
    `${PRODUCT} move --onto plunge runs the adopt Op over every stack it lists, ${stack} among them. Each stack waits at its own gate.`,
  adoptWaiting: `Each stack's adoption waits for an approval of its preview's digest. Approve it with the line chant printed (${PRODUCT} approve <gate> --op plywood-adopt --plan <digest>), then run this command again.`,
  rollbackWaiting: `The rollback's preview waits at the release gate. Approve its digest with the line chant printed, then run this command again.`,
  releaseIsEnvWide: (stack: string, env: string): string =>
    `--release rolls back every stack the release records in an environment, so it takes --env, not a stack. Run '${PRODUCT} rollback --release <name> --env ${env}', or '${PRODUCT} rollback ${stack}' for this stack's previous release.`,
} as const;
