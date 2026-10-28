/**
 * Review stacks (plywood#15): a stack per open pull request, `pr-<n>`, made
 * from the template stack's config, updated from each push, and destroyed
 * and removed when the pull request closes or its TTL passes. plywood holds
 * the words and the config (src/config/review-stacks.ts); chant runs them:
 *
 *   chant core            `ci.prEnvironment`: the `components pr-env up`,
 *                         `down` and `sweep` jobs, the gate `pr-env` on a
 *                         non-empty plan, the records on the workspace ledger
 *                         (`_pr-envs/records.jsonl`, chant#4551's
 *                         `appendPrEnvRecord`) and the TTL sweep
 *   chant pulumi lexicon  the three review stack argv, `stack init`,
 *                         `destroy --yes` and `stack rm --yes`, on `pr-*`
 *                         names alone (`initReviewStack`, `removeReviewStack`)
 *
 * `plywood ci` and `plywood init` add the review stack jobs (`--pr-env` on
 * chant's build) only when plywood.yml sets `review_stacks` and the
 * installed pulumi lexicon has those argv, so a chant that cannot remove a
 * review stack never gets jobs that make one.
 *
 * A pull request's review stack update waits for an approval of its digest
 * under gate `pr-env`, which a person gives with
 * `plywood approve review --pr <n> --plan <digest>`.
 */

/** chant's gate a review stack's update waits at (`PR_ENV_GATE`). */
export const REVIEW_GATE = "pr-env";

/** The gate word a person types after `plywood approve`. */
export const REVIEW_GATE_WORD = "review";

/** chant's op a pull request's review stack is recorded under. */
export const reviewOp = (pr: string): string => `pr-${pr}`;

let cached: Promise<boolean> | undefined;

/** Whether the installed pulumi lexicon creates and removes review stacks (`initReviewStack`, `removeReviewStack`). */
export function chantReviewStacks(): Promise<boolean> {
  cached ??= (async () => {
    try {
      // @ts-ignore: initReviewStack and removeReviewStack are newer than the lexicon at 0.124.54.
      const m: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      return typeof m.initReviewStack === "function" && typeof m.removeReviewStack === "function";
    } catch {
      return false;
    }
  })();
  return cached;
}

/** Tests stand in an answer; `reset` goes back to the real import. */
export function setChantReviewStacksForTests(v: boolean | "reset"): void {
  cached = v === "reset" ? undefined : Promise.resolve(v);
}

/** Why the review stack jobs were left out, for `plywood ci` and `plywood init`. */
export const REVIEW_STACKS_NEED_CHANT =
  "review_stacks is set, and the installed @intentius/chant-lexicon-pulumi cannot create or remove a review stack (initReviewStack, removeReviewStack), so the workflow has no review stack jobs yet";
