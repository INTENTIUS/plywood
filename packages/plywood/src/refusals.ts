/**
 * What plywood prints after chant refuses an update, approval or override:
 * one line per exit code chant#4553 gives a meaning, naming the command that
 * clears it. chant has already printed its own reason (and, for a waiting
 * gate, the approve line in plywood's words); these lines say what to do next
 * in plywood's verbs. The code itself is chant's, passed through unchanged.
 */
import type { ExitName, ExitTable } from "./exit-codes";
import { POLICY_RULE_FORMS, PR_GATE, PRODUCT } from "./words";

/** Where the refusal happened, so the line names the right next command. */
export interface RefusalContext {
  /** The wave that refused, when `plywood up` ran one. */
  wave?: number;
  /** The pull request, for an update before merge. */
  pr?: string;
}

/** The refused outcomes plywood explains; `done`, `failed` and `drift` carry chant's own message. */
export const REFUSALS = ["waiting", "moved", "held", "superseded", "denied", "declined", "misplaced"] as const satisfies readonly ExitName[];

export type Refusal = (typeof REFUSALS)[number];

/** The exit name `code` stands for in `table`, when it is one plywood explains. */
export function refusalOf(code: number, table: ExitTable): Refusal | undefined {
  return REFUSALS.find((name) => table[name] === code);
}

/** The line for `refusal`, with the command that clears it. */
export function refusalLine(refusal: Refusal, ctx: RefusalContext = {}): string {
  const gate = ctx.wave !== undefined ? `wave-${ctx.wave}` : PR_GATE;
  const again = ctx.pr !== undefined ? `/${PRODUCT} up on pull request ${ctx.pr}` : `${PRODUCT} up${ctx.wave !== undefined ? ` --wave ${ctx.wave}` : ""}`;
  switch (refusal) {
    case "waiting":
      return `${gate} waits for an approval. Approve the digest chant printed with '${PRODUCT} approve ${gate} --plan <digest>', then run ${again} again.`;
    case "moved":
      return `The preview moved after it was approved (on plunge, a record the saved plan read was written by another update), so nothing was updated. Preview again ('${PRODUCT} preview' or /${PRODUCT} preview), read the new change, and approve its digest with '${PRODUCT} approve ${PR_GATE} --plan <digest>'.`;
    case "held":
      return `Another update or pull request holds a lock on a resource this update touches, and chant named it above. A running update lets go when it ends; a pull request's lock goes with /${PRODUCT} unlock on that pull request. Then run ${again} again.`;
    case "superseded":
      return `A newer push stands in for this one, which stood down. Nothing needs doing: the newer run updates the stacks.`;
    case "denied":
      return `A policy denied the change. Fix it and preview again, or override it with '${PRODUCT} override <stack> --rule <id> --reason <text>' naming exactly the rules chant listed (${POLICY_RULE_FORMS}). An override is spent once its update runs.`;
    case "declined":
      return `An approver declined the change, so nothing was updated. Push a new change and preview it again.`;
    case "misplaced":
      return `The job ran outside the forge environment, branch or runner plywood.yml gives this stack, and chant's job guard named the difference above, so nothing ran. Run it from that branch on that runner, or change environments and runners in plywood.yml and run '${PRODUCT} ci' again.`;
  }
}

/** Print the line for `code` when it is a refusal; returns `code` unchanged. */
export function explainRefusal(code: number, table: ExitTable, err: (s: string) => void, ctx: RefusalContext = {}): number {
  const refusal = refusalOf(code, table);
  if (refusal) err(`${PRODUCT}: ${refusalLine(refusal, ctx)}`);
  return code;
}

/** The approve line chant prints when a merged wave is refused as moved: "Approve these plans to apply them: <command>". */
export function approveLineIn(output: string): string | undefined {
  const m = /Approve these plans to apply them:[ \t]*([^\r\n]+)/.exec(output);
  const line = m?.[1]?.trim();
  return line ? line : undefined;
}

/**
 * What plywood says when `plywood run wave` exits with moved (4). With the
 * waves spec's `approvals.preview` the wave applies what its pull request
 * previewed; the plans it made now differ from the recorded ones, or none was
 * recorded, so nothing was applied. `output` is what chant printed, to find
 * the approve line it names.
 */
export function waveMovedLine(output: string): string {
  const approve = approveLineIn(output);
  const how = approve
    ? `If a person has read the plans chant listed above and wants them applied, approve exactly them with: ${approve}, then run the job again.`
    : `chant named no approval for these plans. Read the plans above, then approve them with '${PRODUCT} approve <wave gate> --plan <digest>' and run the job again.`;
  return `A merged wave stopped with exit 4 and nothing in it was applied: its plans are not the ones its pull request previewed (or no preview was recorded for it). ${how} To apply only what a pull request previews, open a new pull request, let '${PRODUCT} run wave --record-plans' record its plans, and merge that.`;
}
