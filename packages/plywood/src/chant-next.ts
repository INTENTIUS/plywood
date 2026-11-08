/**
 * The chant parity pieces plywood fills in its own words: the waves spec's
 * `approvals.preview` (chant 0.124.59) with the token each wave reads the
 * merged pull request with, and the audit log (chant#4632), {@link chantAudit},
 * since plywood calls into it.
 */
import type { ForgeKind } from "./chant-product";

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
