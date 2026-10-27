/**
 * `review_stacks`: a stack per open pull request, made from a template
 * stack's config and destroyed when the pull request closes or its TTL
 * passes. It becomes chant's `ci.prEnvironment` (template, ttl); the name
 * pattern goes to the pipeline. Only stacks the pattern names are destroyed.
 */
import { error, isObject, onlyKeys, type ConfigGroup, type ConfigProblem } from "./types";

export const DEFAULT_REVIEW_STACK_NAME = "pr-{number}";
const TTL = /^\d+[mhd]$/;

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
        name: { type: "string", pattern: "\\{number\\}", default: DEFAULT_REVIEW_STACK_NAME, description: "The review stack's name; {number} is the pull request's number." },
        ttl: { type: "string", pattern: TTL.source, description: "How long a review stack lives after its last update, such as 72h. chant's default when absent." },
      },
    },
  },
  check(doc) {
    const r = doc.review_stacks;
    if (r === undefined) return [];
    if (!isObject(r)) return [error("review_stacks", "must be a mapping with a template")];
    const out: ConfigProblem[] = [...onlyKeys(r, ["template", "name", "ttl"], "review_stacks")];
    if (typeof r.template !== "string" || !r.template) out.push(error("review_stacks.template", "names the template stack as project/stack"));
    if (r.name !== undefined && (typeof r.name !== "string" || !r.name.includes("{number}"))) {
      out.push(error("review_stacks.name", "must hold {number}, so each pull request gets its own stack and only those stacks are destroyed"));
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
