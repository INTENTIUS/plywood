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
  { verb: "check", summary: "Check the stacks a pull request changes" },
  { verb: "preview", summary: "Preview the stacks a pull request changes" },
  { verb: "up", summary: "Update the stacks a merged pull request changes, in gated waves" },
  { verb: "drift", summary: "Find stacks whose resources differ from their state" },
  { verb: "approve", summary: "Approve a pull request's previews for up" },
  { verb: "override", summary: "Override a policy denial on a pull request" },
];
