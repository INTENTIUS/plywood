/**
 * The chant parity features plywood reads off the ci-product entry it
 * already loads: the responses (chant#4629), the build's flags for them and
 * the merge (`PR_LOOP_BUILD_FLAGS_FLOOR`) and the approval status
 * (chant#4630), from `CI_RESPOND_FLOOR` and `APPROVAL_STATUS_FLOOR` on
 * {@link ChantProduct}; and the audit log (chant#4632), {@link chantAudit},
 * since plywood calls into it. The apply-job guard (chant#4624), the plan
 * flags (chant#4627), the stale notes (chant#4628), the scheduled Op's
 * identities and `contents: write` (chant#4631) and the merge after apply
 * (chant#4636) are in the pinned chant and need no check. The waves spec's
 * `approvals.preview` (0.124.59) is read off `@intentius/chant/op`.
 */
import type { ChantProduct, ForgeKind } from "./chant-product";

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

let wavePreview: Promise<boolean> | undefined;

/**
 * Whether the installed chant takes `approvals.preview` in an Op waves spec
 * (chant 0.124.59): a merged wave applies the plans its pull request
 * previewed, or exits 4. `@intentius/chant/op` exports the first release as
 * `OP_WAVES_PREVIEW_FLOOR`.
 */
export function hasChantWavePreview(): Promise<boolean> {
  wavePreview ??= (async () => {
    try {
      // @ts-ignore: older chants lack the export (chant 0.124.59).
      const m: Record<string, unknown> = await import("@intentius/chant/op");
      return typeof m.OP_WAVES_PREVIEW_FLOOR === "string";
    } catch {
      return false;
    }
  })();
  return wavePreview;
}

/** Tests say whether the installed chant takes `approvals.preview`; `reset` goes back to the real import. */
export function setChantWavePreviewForTests(has: boolean | "reset"): void {
  wavePreview = has === "reset" ? undefined : Promise.resolve(has);
}

/** The variable chant's review reader takes the job's forge token from on GitHub and Forgejo (`reviewSourceFromEnv`). */
export const WAVE_TOKEN_VARIABLE = "GITHUB_TOKEN";

/** The token chant's review reader looks for on GitLab: a project access token with `read_api` (a CI/CD variable the repository holds). */
export const GITLAB_READ_TOKEN = "CHANT_FORGE_TOKEN";

/**
 * `spec` with `approvals.preview: true`, so a merged wave applies what its
 * pull request previewed or refuses with exit 4. The deciding job reads the
 * merged pull request from the forge, so on GitHub and Forgejo each wave also
 * gets the job's own token as `GITHUB_TOKEN` (GitHub's workflow already
 * carries `pull-requests: read` for it, and Forgejo's job token reads pull
 * requests with no scope to ask for). On GitLab the job reads the project's
 * `CHANT_FORGE_TOKEN` variable, which needs `read_api`; plywood init says so.
 * A spec that already says `approvals.preview` keeps its value, and a variable
 * a wave already sets is kept.
 */
export function withWavePreview(spec: Record<string, unknown>, forge: ForgeKind): Record<string, unknown> {
  const approvals = spec.approvals && typeof spec.approvals === "object" && !Array.isArray(spec.approvals) ? (spec.approvals as Record<string, unknown>) : {};
  const next = approvals.preview !== undefined ? spec : { ...spec, approvals: { ...approvals, preview: true } };
  if (forge === "gitlab" || (next.approvals as Record<string, unknown>).preview !== true || !Array.isArray(next.waves)) return next;
  const waves = (next.waves as Array<Record<string, unknown>>).map((w) => ({
    ...w,
    variables: { [WAVE_TOKEN_VARIABLE]: "${{ github.token }}", ...((w.variables as Record<string, string> | undefined) ?? {}) },
  }));
  return { ...next, waves };
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
