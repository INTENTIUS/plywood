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

/**
 * Whether the installed pulumi lexicon runs review stacks end to end: it
 * creates and removes them (`initReviewStack`, `removeReviewStack`), and its
 * plugin claims a `project/stack` template (`pulumiPlugin.prEnvTemplate`,
 * chant#4609), so `ci.prEnvironment.template` needs no chant.config.ts
 * environment and `pr-env down` destroys what `pr-env up` made through the
 * plugin's `prEnvTeardown`. Without all of it, plywood writes neither
 * `ci.prEnvironment` nor the review stack jobs.
 */
export function chantReviewStacks(): Promise<boolean> {
  cached ??= (async () => {
    try {
      // @ts-ignore: initReviewStack, removeReviewStack and the plugin's prEnvTemplate are newer than the lexicon at 0.124.54.
      const m: Record<string, unknown> = await import("@intentius/chant-lexicon-pulumi");
      const plugin = m.pulumiPlugin as { prEnvTemplate?: unknown; prEnvTeardown?: unknown } | undefined;
      return (
        typeof m.initReviewStack === "function" &&
        typeof m.removeReviewStack === "function" &&
        typeof plugin?.prEnvTemplate === "function" &&
        typeof plugin?.prEnvTeardown === "function"
      );
    } catch {
      return false;
    }
  })();
  return cached;
}

/**
 * The `reviewSuffix` a review stack's pulumi-up step takes (chant#4609):
 * `shop` of `review_stacks.name: pr-{number}-shop`, or undefined for the
 * default `pr-{number}`.
 */
export function reviewSuffixOf(pattern: string | undefined): string | undefined {
  const m = pattern ? /^pr-\{number\}-([a-z0-9][a-z0-9-]*)$/.exec(pattern) : null;
  return m ? m[1] : undefined;
}

/** Tests stand in an answer; `reset` goes back to the real import. */
export function setChantReviewStacksForTests(v: boolean | "reset"): void {
  cached = v === "reset" ? undefined : Promise.resolve(v);
}

/** Why the review stack jobs were left out, for `plywood ci` and `plywood init`. */
export const REVIEW_STACKS_NEED_CHANT =
  "review_stacks is set, and the installed @intentius/chant-lexicon-pulumi cannot run a review stack end to end (initReviewStack, removeReviewStack, and the plugin's prEnvTemplate and prEnvTeardown from chant#4609), so plywood writes no ci.prEnvironment and the workflow has no review stack jobs yet";
