/**
 * `gate`, `approval` and `approval_rules`: when a wave waits for people,
 * which approvals count, and how many of whom.
 *
 *   gate            always, on-destructive (default) or never; a stack may set its own
 *   approval        ledger (default), sealed or pr-review, chant's approval sources
 *   approval_rules  stack glob to { role | roles, quorum }, as chant's quorum rules
 *   preview         true makes a merged wave apply only what its pull request previewed (off by default)
 *
 * The author of a pull request never counts toward its own quorum, so every
 * rule carries `notAuthor` and the pipeline excludes the author's approval.
 * A rule that names a role is met only by a proven approval, which an
 * unsigned ledger approval is not: check warns about that pairing.
 */
import { error, isObject, oneOf, onlyKeys, warning, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";
import type { ChantApprovalSource, ChantGatePolicy, ChantQuorumRule } from "../chant-config";

export const GATES = ["always", "on-destructive", "never"] as const;
export const DEFAULT_GATE: ChantGatePolicy = "on-destructive";
export const APPROVALS = ["ledger", "sealed", "pr-review"] as const;
export const DEFAULT_APPROVAL: ChantApprovalSource = "ledger";
export const DEFAULT_PREVIEW = false;
export const APPROVAL_RULE_KEYS = ["role", "roles", "quorum"] as const;

export interface ApprovalRuleSettings {
  role?: string;
  roles?: string[];
  quorum?: number;
}

export function approvalOf(doc: RawConfig): ChantApprovalSource {
  return typeof doc.approval === "string" && (APPROVALS as readonly string[]).includes(doc.approval) ? (doc.approval as ChantApprovalSource) : DEFAULT_APPROVAL;
}

export function gateOf(doc: RawConfig): ChantGatePolicy {
  return typeof doc.gate === "string" && (GATES as readonly string[]).includes(doc.gate) ? (doc.gate as ChantGatePolicy) : DEFAULT_GATE;
}

/**
 * Whether `plywood init` writes `approvals.preview` into the waves spec.
 * Off by default since 0.3.1: with it on, the second of two disjoint merges
 * on one stack is refused (plywood#55) and so is a pull request that creates
 * an autonamed resource (plywood#56).
 */
export function previewOf(doc: RawConfig): boolean {
  return doc.preview === true;
}

/** `approval_rules` as chant's quorum rules, in the order plywood.yml lists them. */
export function quorumOf(rules: Record<string, ApprovalRuleSettings>): ChantQuorumRule[] {
  return Object.entries(rules).map(([glob, r]) => {
    const roles = [...(r.role !== undefined ? [r.role] : []), ...(r.roles ?? [])];
    return { targets: [glob], count: r.quorum ?? 1, ...(roles.length ? { roles } : {}), notAuthor: true };
  });
}

export const approval: ConfigGroup = {
  name: "approval",
  keys: ["gate", "approval", "approval_rules", "preview"],
  schema: {
    gate: { type: "string", enum: [...GATES], default: DEFAULT_GATE, description: "always, on-destructive or never." },
    approval: { type: "string", enum: [...APPROVALS], default: DEFAULT_APPROVAL, description: "ledger, sealed or pr-review." },
    preview: {
      type: "boolean",
      default: DEFAULT_PREVIEW,
      description: "true: plywood init sets approvals.preview in the waves spec, so a merged wave applies only the plans its pull request previewed, or exits 4. Known limits: plywood#55 (the second of two disjoint merges is refused) and plywood#56 (a pull request that creates an autonamed resource is refused).",
    },
    approval_rules: {
      type: "object",
      description: "Role and quorum per stack glob. Read at base.",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          role: { type: "string", description: "A role .chant/trust.json gives the approvers." },
          roles: { type: "array", items: { type: "string" }, description: "Roles, any of which counts." },
          quorum: { type: "integer", minimum: 1, default: 1, description: "Distinct approvers the stacks need." },
        },
      },
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [...oneOf(doc.gate, GATES, "gate"), ...oneOf(doc.approval, APPROVALS, "approval")];
    if (doc.preview !== undefined && typeof doc.preview !== "boolean") out.push(error("preview", "must be true or false"));
    const rules = doc.approval_rules;
    if (rules === undefined) return out;
    if (!isObject(rules)) return [...out, error("approval_rules", "must map a stack glob to { role, quorum }")];
    let namesRole = false;
    for (const [glob, r] of Object.entries(rules)) {
      const key = `approval_rules.${glob}`;
      if (!isObject(r)) {
        out.push(error(key, "must be a mapping of role, roles and quorum"));
        continue;
      }
      out.push(...onlyKeys(r, APPROVAL_RULE_KEYS, key));
      if (r.role !== undefined && typeof r.role !== "string") out.push(error(`${key}.role`, "must be a string"));
      if (r.roles !== undefined && (!Array.isArray(r.roles) || r.roles.some((x) => typeof x !== "string"))) out.push(error(`${key}.roles`, "must be a list of strings"));
      if (r.quorum !== undefined && (!Number.isInteger(r.quorum) || (r.quorum as number) < 1)) out.push(error(`${key}.quorum`, "must be a whole number, 1 or more"));
      if (r.role !== undefined || (Array.isArray(r.roles) && r.roles.length)) namesRole = true;
    }
    if (namesRole && approvalOf(doc) === "ledger") {
      out.push(warning("approval_rules", "names a role and approval is ledger: only a proven approval counts toward a role, so set approval: sealed or pr-review"));
    }
    return out;
  },
  translate(doc, out) {
    out.pipeline.gate = gateOf(doc);
    out.pipeline.approval = approvalOf(doc);
    out.pipeline.excludeAuthor = true;
    if (isObject(doc.approval_rules)) out.pipeline.quorum = quorumOf(doc.approval_rules as Record<string, ApprovalRuleSettings>);
  },
};
