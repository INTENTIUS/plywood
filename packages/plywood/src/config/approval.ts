/**
 * `gate`, `approval` and `approval_rules`: when a wave waits for people,
 * which approvals count, and how many of whom.
 *
 *   gate            always, on-destructive (default) or never; a stack may set its own
 *   approval        ledger, sealed or pr-review, chant's approval sources; the
 *                   default is ledger, and pr-review when approval_rules are set
 *   approval_rules  stack glob to { roles, count, proven, name }, or a label to a
 *                   group { all | any, name } of rules, as chant's quorum rules
 *                   and groups (chant#5349, #5354); role and quorum are the
 *                   older spellings of roles and count
 *   preview         true makes a merged wave apply only what its pull request previewed (off by default)
 *
 * The author of a pull request never counts toward its own quorum, so every
 * rule carries `notAuthor` and the pipeline excludes the author's approval.
 * `notAuthor` needs a proven approver, and chant refuses a rule nothing can
 * prove (chant#5379): under `ledger`, with no signer in the signers file,
 * the waves would not build. So when plywood.yml sets approval rules and no
 * `approval`, plywood writes `pr-review`: the merged pull request's reviews
 * prove its reviewers, a repository with no signers keeps building, and a
 * plan still waits for a reviewer other than its author. A signed
 * `plywood approve --sign` counts under `pr-review` too.
 * A rule that names a role is met only by a proven approval, which an
 * unsigned ledger approval is not. chant finds a rule no approver can meet
 * when it builds the waves (chant#5349), and `plywood check` prints that
 * finding in chant's words (src/stages.ts).
 */
import { error, isObject, oneOf, onlyKeys, type ConfigGroup, type ConfigProblem, type RawConfig } from "./types";
import type { ChantApprovalSource, ChantGatePolicy, ChantQuorumNode, ChantQuorumRule } from "../chant-config";

export const GATES = ["always", "on-destructive", "never"] as const;
export const DEFAULT_GATE: ChantGatePolicy = "on-destructive";
export const APPROVALS = ["ledger", "sealed", "pr-review"] as const;
export const DEFAULT_APPROVAL: ChantApprovalSource = "ledger";
/** The approval source plywood writes when approval rules are set and `approval` is not: one whose reviews prove an approver (chant#5379). */
export const RULES_DEFAULT_APPROVAL: ChantApprovalSource = "pr-review";
export const DEFAULT_PREVIEW = true;
export const APPROVAL_RULE_KEYS = ["role", "roles", "quorum", "count", "proven", "name"] as const;
export const APPROVAL_GROUP_KEYS = ["all", "any", "name"] as const;
/** A rule's or a group's name, as chant takes it (chant#5354). */
const RULE_NAME = /^[a-z0-9_-]+$/;
/** chant's deepest group nesting (`QUORUM_MAX_DEPTH`). */
const GROUP_DEPTH = 3;

export interface ApprovalRuleSettings {
  role?: string;
  roles?: string[];
  /** plywood's spelling of `count`, which it keeps reading. */
  quorum?: number;
  count?: number;
  proven?: boolean;
  name?: string;
}

/** A group of rules: `all` met when every rule is, `any` when one is. Each holds a map of stack glob to rule, or a list. */
export interface ApprovalGroupSettings {
  all?: ApprovalRulesSettings;
  any?: ApprovalRulesSettings;
  name?: string;
}

/** `approval_rules`: stack glob to a rule, or a group's label to a group. */
export type ApprovalRulesSettings = Record<string, ApprovalRuleSettings | ApprovalGroupSettings> | Array<ApprovalRuleSettings | ApprovalGroupSettings>;

function isGroup(r: Record<string, unknown>): boolean {
  return r.all !== undefined || r.any !== undefined;
}

/**
 * The problems of an `approval_rules` value, at `key`: a map of stack glob
 * to `{ role | roles, count | quorum, proven, name }`, or of a label to a
 * group `{ all | any, name }` whose rules nest the same way, up to three
 * groups deep.
 */
export function approvalRulesProblems(rules: unknown, key: string, depth = 0): ConfigProblem[] {
  const entries: Array<[string, unknown]> = Array.isArray(rules) ? rules.map((r, i) => [`[${i}]`, r]) : isObject(rules) ? Object.entries(rules).map(([k, r]) => [`.${k}`, r]) : [];
  if (!Array.isArray(rules) && !isObject(rules)) return [error(key, "must map a stack glob to { roles, count }, or a label to a group with all or any")];
  const out: ConfigProblem[] = [];
  for (const [at, r] of entries) {
    const k = `${key}${at}`;
    if (!isObject(r)) {
      out.push(error(k, "must be a mapping of roles, count and proven, or a group with all or any"));
      continue;
    }
    if (r.name !== undefined && (typeof r.name !== "string" || !RULE_NAME.test(r.name))) out.push(error(`${k}.name`, "is lowercase letters, digits, - and _"));
    if (isGroup(r)) {
      out.push(...onlyKeys(r, APPROVAL_GROUP_KEYS, k));
      if (r.all !== undefined && r.any !== undefined) out.push(error(k, "is a group of all or of any, not both"));
      if (depth + 1 > GROUP_DEPTH) out.push(error(k, `nests groups more than ${GROUP_DEPTH} deep`));
      else out.push(...approvalRulesProblems(r.all ?? r.any, `${k}.${r.all !== undefined ? "all" : "any"}`, depth + 1));
      continue;
    }
    out.push(...onlyKeys(r, APPROVAL_RULE_KEYS, k));
    if (r.role !== undefined && typeof r.role !== "string") out.push(error(`${k}.role`, "must be a string"));
    if (r.roles !== undefined && (!Array.isArray(r.roles) || r.roles.some((x) => typeof x !== "string"))) out.push(error(`${k}.roles`, "must be a list of strings"));
    for (const c of ["quorum", "count"] as const) if (r[c] !== undefined && (!Number.isInteger(r[c]) || (r[c] as number) < 1)) out.push(error(`${k}.${c}`, "must be a whole number, 1 or more"));
    if (r.quorum !== undefined && r.count !== undefined) out.push(error(`${k}.quorum`, "is count's older spelling; set count alone"));
    if (r.proven !== undefined && typeof r.proven !== "boolean") out.push(error(`${k}.proven`, "is true or false"));
  }
  return out;
}

/** Whether `approval` names one of chant's approval sources. */
export function approvalSet(v: unknown): v is ChantApprovalSource {
  return typeof v === "string" && (APPROVALS as readonly string[]).includes(v);
}

/**
 * The approval the merge's waves name for themselves: `pr-review` when
 * `approval_rules` are set and `approval` is not, as a stage with rules
 * takes, so the merged pull request's reviews prove the approvers a rule
 * asks for (every rule carries `notAuthor`). Otherwise none, and the waves
 * take the pull request's approval (chant's `pull-request`).
 */
export function wavesApprovalOf(doc: RawConfig): ChantApprovalSource | undefined {
  return doc.approval_rules !== undefined && !approvalSet(doc.approval) ? RULES_DEFAULT_APPROVAL : undefined;
}

/** `approval`, else `pr-review` when `approval_rules` are set (every rule carries `notAuthor`), else `ledger`. */
export function approvalOf(doc: RawConfig): ChantApprovalSource {
  if (approvalSet(doc.approval)) return doc.approval;
  return doc.approval_rules !== undefined ? RULES_DEFAULT_APPROVAL : DEFAULT_APPROVAL;
}

export function gateOf(doc: RawConfig): ChantGatePolicy {
  return typeof doc.gate === "string" && (GATES as readonly string[]).includes(doc.gate) ? (doc.gate as ChantGatePolicy) : DEFAULT_GATE;
}

/**
 * Whether `plywood init` writes `approvals.preview` into the waves spec: on
 * unless plywood.yml says `preview: false`. It was off in 0.3.1 and 0.3.2
 * while chant refused the second of two disjoint merges (plywood#55, fixed in
 * chant 0.124.67) and a pull request that creates an autonamed resource
 * (plywood#56, fixed in chant 0.124.60).
 */
export function previewOf(doc: RawConfig): boolean {
  return doc.preview !== false;
}

/**
 * `approval_rules` as chant's quorum rules and groups, in the order
 * plywood.yml lists them. A rule's map key is its stack glob, chant's
 * `targets`; a list's rules cover every stack. A group's key is its label.
 */
export function quorumOf(rules: ApprovalRulesSettings): ChantQuorumNode[] {
  const entries: Array<[string | undefined, ApprovalRuleSettings | ApprovalGroupSettings]> = Array.isArray(rules) ? rules.map((r) => [undefined, r]) : Object.entries(rules);
  return entries.map(([glob, r]): ChantQuorumNode => {
    const named = r.name !== undefined ? { name: r.name } : {};
    const g = r as ApprovalGroupSettings;
    if (g.all !== undefined) return { ...named, all: quorumOf(g.all) };
    if (g.any !== undefined) return { ...named, any: quorumOf(g.any) };
    const rule = r as ApprovalRuleSettings;
    const roles = [...(rule.role !== undefined ? [rule.role] : []), ...(rule.roles ?? [])];
    const out: ChantQuorumRule = { ...named, ...(glob !== undefined ? { targets: [glob] } : {}), count: rule.count ?? rule.quorum ?? 1, ...(roles.length ? { roles } : {}), notAuthor: true };
    if (rule.proven) out.proven = true;
    return out;
  });
}

const ruleSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    roles: { type: "array", items: { type: "string" }, description: "Roles from .chant/trust.json, any of which counts." },
    role: { type: "string", description: "One role; the older spelling of roles." },
    count: { type: "integer", minimum: 1, default: 1, description: "Distinct approvers the stacks need." },
    quorum: { type: "integer", minimum: 1, description: "The older spelling of count." },
    proven: { type: "boolean", default: false, description: "Only approvers a seal or a review proves count toward count." },
    name: { type: "string", pattern: RULE_NAME.source, description: "The rule's name in its progress line, the preview note and the pending fact." },
  },
};

/** The schema's `$defs` for approval rules and groups, which `approval_rules` and the stage keys refer to. */
export const APPROVAL_DEFS = {
  approvalNode: {
    anyOf: [
      ruleSchema,
      {
        type: "object",
        additionalProperties: false,
        properties: {
          all: { anyOf: [{ type: "object", additionalProperties: { $ref: "#/$defs/approvalNode" } }, { type: "array", items: { $ref: "#/$defs/approvalNode" } }], description: "Met when every rule in it is met." },
          any: { anyOf: [{ type: "object", additionalProperties: { $ref: "#/$defs/approvalNode" } }, { type: "array", items: { $ref: "#/$defs/approvalNode" } }], description: "Met when one rule in it is met." },
          name: { type: "string", pattern: RULE_NAME.source },
        },
      },
    ],
  },
};

export const approval: ConfigGroup = {
  name: "approval",
  keys: ["gate", "approval", "approval_rules", "preview"],
  schema: {
    gate: { type: "string", enum: [...GATES], default: DEFAULT_GATE, description: "always, on-destructive or never." },
    approval: { type: "string", enum: [...APPROVALS], default: DEFAULT_APPROVAL, description: "ledger, sealed or pr-review. Default ledger, and pr-review when approval_rules are set, so the merged pull request's reviews prove the approvers the rules need." },
    preview: {
      type: "boolean",
      default: DEFAULT_PREVIEW,
      description: "true (the default): plywood init sets approvals.preview in the waves spec, so a merged wave applies only the plans its pull request previewed, or exits 4. false leaves it out.",
    },
    approval_rules: {
      description: "Approval rules, read at base: stack glob to { roles, count, proven, name }, or a label to a group with all or any of such rules, nested up to three deep. A list of rules covers every stack.",
      anyOf: [{ type: "object", additionalProperties: { $ref: "#/$defs/approvalNode" } }, { type: "array", items: { $ref: "#/$defs/approvalNode" } }],
    },
  },
  check(doc) {
    const out: ConfigProblem[] = [...oneOf(doc.gate, GATES, "gate"), ...oneOf(doc.approval, APPROVALS, "approval")];
    if (doc.preview !== undefined && typeof doc.preview !== "boolean") out.push(error("preview", "must be true or false"));
    const rules = doc.approval_rules;
    if (rules === undefined) return out;
    // plywood#156: a rule no approver can prove is chant's finding (chant#5349), which `plywood check` and `plywood ci` print in chant's words.
    return [...out, ...approvalRulesProblems(rules, "approval_rules")];
  },
  translate(doc, out) {
    out.pipeline.gate = gateOf(doc);
    out.pipeline.approval = approvalOf(doc);
    out.pipeline.excludeAuthor = true;
    if (isObject(doc.approval_rules) || Array.isArray(doc.approval_rules)) out.pipeline.quorum = quorumOf(doc.approval_rules as ApprovalRulesSettings);
  },
};
