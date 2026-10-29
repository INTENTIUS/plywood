/**
 * The chant parity features plywood reads off the ci-product entry it
 * already loads: the responses (chant#4629), the build's flags for them and
 * the merge (`PR_LOOP_BUILD_FLAGS_FLOOR`) and the approval status
 * (chant#4630), from `CI_RESPOND_FLOOR` and `APPROVAL_STATUS_FLOOR` on
 * {@link ChantProduct}; and the audit log (chant#4632), {@link chantAudit},
 * since plywood calls into it. The apply-job guard (chant#4624), the plan
 * flags (chant#4627), the stale notes (chant#4628), the scheduled Op's
 * identities and `contents: write` (chant#4631) and the merge after apply
 * (chant#4636) are in the pinned chant and need no check.
 */
import type { ChantProduct } from "./chant-product";

/** Whether the installed chant has chant#4629's responses: a refused wave's diff, a failed apply's triage, the description check. */
export function hasChantRespond(chant: Pick<ChantProduct, "CI_RESPOND_FLOOR"> | undefined): boolean {
  return typeof chant?.CI_RESPOND_FLOOR === "string";
}

/** Whether the installed chant's `build --pr-loop` takes the responses and the decide service (`PR_LOOP_BUILD_FLAGS_FLOOR`). */
export function hasChantPrLoopFlags(chant: Pick<ChantProduct, "PR_LOOP_BUILD_FLAGS_FLOOR"> | undefined): boolean {
  return typeof chant?.PR_LOOP_BUILD_FLAGS_FLOOR === "string";
}

/** Whether the installed chant has chant#4630's approval status, `<product>/approval` on a pull request's head. */
export function hasChantApprovalStatus(chant: Pick<ChantProduct, "APPROVAL_STATUS_FLOOR"> | undefined): boolean {
  return typeof chant?.APPROVAL_STATUS_FLOOR === "string";
}

/** Whether the installed chant posts that status for `pull-request` waves too, which are plywood's (chant#4630 ruling). */
export function hasChantPullRequestApprovalStatus(chant: Pick<ChantProduct, "APPROVAL_STATUS_PULL_REQUEST_FLOOR"> | undefined): boolean {
  return typeof chant?.APPROVAL_STATUS_PULL_REQUEST_FLOOR === "string";
}

/** One drifted attribute and who changed it (chant `Attribution`, `@intentius/chant/ci-audit`). */
export interface ChantAttribution {
  member: string;
  address: string;
  path: string;
  actor?: string;
  source: string;
  detail: string;
}

/** The part of `@intentius/chant/ci-audit` (chant#4632) `plywood drift` calls. */
export interface ChantAudit {
  parseAuditLogSetting(text: string): { cloud: string; region?: string } | { error: string };
  attributeDrift(doc: { records: unknown[] }, options?: { auditLogs?: Record<string, unknown> }): Promise<{ attributions: ChantAttribution[]; notes: string[] }>;
  routeAttributions(attributions: readonly ChantAttribution[]): { lines: string[] };
}

let audit: Promise<ChantAudit> | undefined;

/** chant's audit-log reads (chant#4632), loaded on first use. */
export function chantAudit(): Promise<ChantAudit> {
  audit ??= import("@intentius/chant/ci-audit").then((m) => m as unknown as ChantAudit);
  return audit;
}

/** Tests stand in chant's audit-log reads; `reset` goes back to the real import. */
export function setChantAuditForTests(fake: ChantAudit | "reset"): void {
  audit = fake === "reset" ? undefined : Promise.resolve(fake);
}
