/**
 * `review_stacks`: a stack per open pull request, made from a template
 * stack's config and destroyed when the pull request closes or its TTL
 * passes. It becomes chant's `ci.prEnvironment` (template, ttl); the name
 * pattern goes to the pipeline. Only stacks the pattern names are destroyed,
 * and the pattern is chant's review stack name, `pr-{number}` with an
 * optional suffix, so chant's pulumi lexicon runs `destroy` and `stack rm`
 * on no other stack (src/review-stacks.ts).
 */
import { error, isObject, onlyKeys, warning, type ConfigGroup, type ConfigProblem } from "./types";

export const DEFAULT_REVIEW_STACK_NAME = "pr-{number}";
const TTL = /^\d+[mhd]$/;
/** The names chant creates and removes (`REVIEW_STACK_NAME`, chant's pulumi lexicon): pr-{number}, or pr-{number}-<suffix>. */
export const REVIEW_STACK_NAME = /^pr-\{number\}(?:-[a-z0-9][a-z0-9-]*)?$/;
const STACK_KEY = /^[^/\s]+\/[^/\s]+$/;

/** The review stack's name for pull request `pr`, from plywood.yml's pattern. */
export function reviewStackName(pattern: string, pr: number | string): string {
  return pattern.replace("{number}", String(pr));
}

export const reviewStacks: ConfigGroup = {
  name: "review_stacks",
  keys: ["review_stacks"],
  schema: {
    review_stacks: {
      type: "object",
      additionalProperties: false,
      required: ["template"],
      description: "A stack per open pull request. Off when absent.",
      properties: {
        template: { type: "string", description: "The stack whose config a review stack starts from, as project/stack." },
        name: { type: "string", pattern: REVIEW_STACK_NAME.source, default: DEFAULT_REVIEW_STACK_NAME, description: "The review stack's name: pr-{number}, or pr-{number}-<suffix>. Only stacks named so are destroyed." },
        ttl: { type: "string", pattern: TTL.source, description: "How long a review stack lives after its last update, such as 72h. chant's default when absent." },
      },
    },
  },
  check(doc) {
    const r = doc.review_stacks;
    if (r === undefined) return [];
    if (!isObject(r)) return [error("review_stacks", "must be a mapping with a template")];
    const out: ConfigProblem[] = [...onlyKeys(r, ["template", "name", "ttl"], "review_stacks")];
    if (typeof r.template !== "string" || !STACK_KEY.test(r.template)) out.push(error("review_stacks.template", "names the template stack as project/stack"));
    else if (isObject(doc.stacks) && !(r.template in doc.stacks)) out.push(warning("review_stacks.template", `is ${r.template}, which stacks does not list; its config is copied from the backend as it stands`));
    if (r.name !== undefined && (typeof r.name !== "string" || !REVIEW_STACK_NAME.test(r.name))) {
      out.push(error("review_stacks.name", "is pr-{number} or pr-{number}-<suffix>: chant creates, destroys and removes stacks named so and no others"));
    }
    if (r.ttl !== undefined && (typeof r.ttl !== "string" || !TTL.test(r.ttl))) out.push(error("review_stacks.ttl", "is a duration such as 30m, 72h or 7d"));
    return out;
  },
  translate(doc, out) {
    const r = doc.review_stacks;
    if (!isObject(r)) return;
    out.ci.prEnvironment = { template: r.template as string, ...(typeof r.ttl === "string" ? { ttl: r.ttl } : {}) };
    out.pipeline.reviewStackName = typeof r.name === "string" ? r.name : DEFAULT_REVIEW_STACK_NAME;
  },
};
