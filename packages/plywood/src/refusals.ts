/**
 * What plywood prints after chant refuses an update, approval or override:
 * one line per exit code chant#4553 gives a meaning, naming the command that
 * clears it. chant has already printed its own reason (and, for a waiting
 * gate, the approve line in plywood's words); these lines say what to do next
 * in plywood's verbs. The code itself is chant's, passed through unchanged.
 */
import type { ExitName, ExitTable } from "./exit-codes";
import { PR_GATE, PRODUCT } from "./words";

/** Where the refusal happened, so the line names the right next command. */
export interface RefusalContext {
  /** The wave that refused, when `plywood up` ran one. */
  wave?: number;
  /** The pull request, for an update before merge. */
  pr?: string;
}

/** The refused outcomes plywood explains; `done`, `failed` and `drift` carry chant's own message. */
export const REFUSALS = ["waiting", "moved", "held", "superseded", "denied", "declined"] as const satisfies readonly ExitName[];

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
      return `The preview moved after it was approved, so nothing was updated. Preview again ('${PRODUCT} preview' or /${PRODUCT} preview), read the new change, and approve its digest with '${PRODUCT} approve ${PR_GATE} --plan <digest>'.`;
    case "held":
      return `Another change holds a lock on a resource this update touches. Wait for it to finish, or release it with /${PRODUCT} unlock on the pull request that holds it, then run ${again} again.`;
    case "superseded":
      return `A newer push stands in for this one, which stood down. Nothing needs doing: the newer run updates the stacks.`;
    case "denied":
      return `A policy denied the change. Fix it and preview again, or override it with '${PRODUCT} override <stack> --rule <id> --reason <text>' naming exactly the rules chant listed. An override is spent once its update runs.`;
    case "declined":
      return `An approver declined the change, so nothing was updated. Push a new change and preview it again.`;
  }
}

/** Print the line for `code` when it is a refusal; returns `code` unchanged. */
export function explainRefusal(code: number, table: ExitTable, err: (s: string) => void, ctx: RefusalContext = {}): number {
  const refusal = refusalOf(code, table);
  if (refusal) err(`${PRODUCT}: ${refusalLine(refusal, ctx)}`);
  return code;
}
