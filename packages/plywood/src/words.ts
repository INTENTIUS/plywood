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
