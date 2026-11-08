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
 *                         names alone (`initReviewStack`, `removeReviewStack`);
 *                         under `pr-<n>`, pulumi-up applies `<project>/pr-<n>`
 *                         (`pr-<n>-<reviewSuffix>`), `pr-env down` tears it
 *                         down through the plugin's `prEnvTeardown`, and the
 *                         plugin claims the `project/stack` template
 *                         (`prEnvTemplate`, chant#4609)
 *
 * `plywood ci` and `plywood init` add the review stack jobs (`--pr-env` on
 * chant's build) when plywood.yml sets `review_stacks`.
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

/**
 * The `reviewSuffix` a review stack's pulumi-up step takes (chant#4609):
 * `shop` of `review_stacks.name: pr-{number}-shop`, or undefined for the
 * default `pr-{number}`.
 */
export function reviewSuffixOf(pattern: string | undefined): string | undefined {
  const m = pattern ? /^pr-\{number\}-([a-z0-9][a-z0-9-]*)$/.exec(pattern) : null;
  return m ? m[1] : undefined;
}
