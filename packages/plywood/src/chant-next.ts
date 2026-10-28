/**
 * The chant parity features newer than the pin (chant#4624 to #4636), each
 * reached through a feature-detect with a fallback, as AGENTS.md asks:
 *
 *   checkJob          chant#4624  `@intentius/chant/ci-job-guard`: the
 *                                 apply-job guard chant's op-wave generators
 *                                 write first in each job, and `chant ci
 *                                 check-job` (`plywood ci check-job`)
 *   planFlags         chant#4627  `pr-plan --refresh` and
 *                                 `--target-dependents` (`PLAN_FLAG_ARGS`
 *                                 on `@intentius/chant/components/capability`)
 *   staleNotes        chant#4628  the stale marking of a note when the
 *                                 target branch moves (`markStaleNotes` on
 *                                 `@intentius/chant/pr-post`)
 *   scheduledOpCloud  chant#4631  cloud identities, and an update job, on
 *                                 a scheduled Op (`@intentius/chant/scheduled-op-cloud`)
 *   applyMerge        chant#4636  `pr-apply --merge auto` (`@intentius/chant/pr-merge`)
 *
 * The responses (chant#4629), the build's flags for them and the merge
 * (`PR_LOOP_BUILD_FLAGS_FLOOR`) and the approval status (chant#4630) are read
 * off the ci-product entry plywood already loads (`CI_RESPOND_FLOOR`,
 * `APPROVAL_STATUS_FLOOR` on {@link ChantProduct}), and the audit log
 * (chant#4632) is {@link chantAudit}, since plywood calls into it.
 *
 * Each subpath the 0.124.55 pin lacks is in `CHANT_NEXT`
 * (scripts/chant-exports.mjs), so the bundle builds on the pin and the
 * import throws there; `pr-post` and `components/capability` are in the pin
 * without the new export, and the check reads the export.
 */
import type { ChantProduct } from "./chant-product";

export interface ChantNext {
  checkJob: boolean;
  planFlags: boolean;
  staleNotes: boolean;
  scheduledOpCloud: boolean;
  applyMerge: boolean;
}

const NONE: ChantNext = { checkJob: false, planFlags: false, staleNotes: false, scheduledOpCloud: false, applyMerge: false };

async function has(load: () => Promise<unknown>, name: string, type: "function" | "object" = "function"): Promise<boolean> {
  try {
    const m = (await load()) as Record<string, unknown>;
    return typeof m[name] === type;
  } catch {
    return false;
  }
}

let detected: Promise<ChantNext> | undefined;

/** Which of the parity features the installed chant has. */
export function chantNext(): Promise<ChantNext> {
  detected ??= (async () => ({
    // @ts-ignore: the subpath is missing from chant 0.124.55 (chant#4624).
    checkJob: await has(() => import("@intentius/chant/ci-job-guard"), "checkJob"),
    planFlags: await has(() => import("@intentius/chant/components/capability"), "PLAN_FLAG_ARGS", "object"),
    staleNotes: await has(() => import("@intentius/chant/pr-post"), "markStaleNotes"),
    // @ts-ignore: the subpath is missing from chant 0.124.55 (chant#4631).
    scheduledOpCloud: await has(() => import("@intentius/chant/scheduled-op-cloud"), "assertScheduledOpCloud"),
    // @ts-ignore: the subpath is missing from chant 0.124.55 (chant#4636).
    applyMerge: await has(() => import("@intentius/chant/pr-merge"), "mergeAfterApply"),
  }))();
  return detected;
}

/**
 * Tests say which features chant has; a key left out is missing, so a
 * test reads the same against the pin and a local chant. `reset` goes back
 * to the real imports.
 */
export function setChantNextForTests(has: Partial<ChantNext> | "reset"): void {
  detected = has === "reset" ? undefined : Promise.resolve({ ...NONE, ...has });
}

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

let audit: Promise<ChantAudit | undefined> | undefined;

/** chant's audit-log reads (chant#4632), or undefined when the installed chant lacks them. */
export function chantAudit(): Promise<ChantAudit | undefined> {
  audit ??= (async () => {
    try {
      // @ts-ignore: the subpath is missing from chant 0.124.55 (chant#4632).
      const m = (await import("@intentius/chant/ci-audit")) as Record<string, unknown>;
      return typeof m.attributeDrift === "function" && typeof m.routeAttributions === "function" && typeof m.parseAuditLogSetting === "function" ? (m as unknown as ChantAudit) : undefined;
    } catch {
      return undefined;
    }
  })();
  return audit;
}

/** Tests stand in chant's audit-log reads, or none; `reset` goes back to the real import. */
export function setChantAuditForTests(fake: ChantAudit | undefined | "reset"): void {
  audit = fake === "reset" ? undefined : Promise.resolve(fake);
}
