/**
 * The exit codes plywood leaves with. plywood owns no table: every code is
 * chant's (INTENTIUS/chant#4553), passed through unchanged.
 *
 * chant 0.124.54, the pinned release, has no exported table yet. The table
 * is imported on first use and checked for the codes plywood reads; when the
 * installed chant lacks it, FALLBACK_EXIT stands in. Its numbers are the ones
 * ruled on chant#4553 (moved is 4, a policy denial is 7, a usage or config
 * error is 1), so a chant that carries the table changes nothing a caller
 * sees. chant#4624 added 9, `misplaced`: a job guard refused a job that ran
 * outside its forge environment, branch or runner. A table from a chant
 * before it has no `misplaced`, and 9 stands in, so plywood passes the code
 * through on either.
 *
 * The `import()` carries a `@ts-ignore` so this compiles against a chant
 * without the subpath; scripts/build-cli.mjs stands in a module that throws
 * for a subpath the installed chant lacks, so the bundle builds either way.
 */

export type ExitName =
  | "done"
  | "failed"
  | "drift"
  | "waiting"
  | "moved"
  | "held"
  | "superseded"
  | "denied"
  | "declined"
  | "misplaced";

export type ExitTable = Readonly<Record<ExitName, number>>;

export const FALLBACK_EXIT: ExitTable = Object.freeze({
  done: 0,
  failed: 1,
  drift: 2,
  waiting: 3,
  moved: 4,
  held: 5,
  superseded: 6,
  denied: 7,
  declined: 8,
  misplaced: 9,
});

/** The names chant's table has carried since chant#4553; `misplaced` came later (chant#4624). */
const NAMES = (Object.keys(FALLBACK_EXIT) as ExitName[]).filter((n) => n !== "misplaced");

/** True when `t` has a whole-number code for every name plywood reads; `misplaced` may be left out. */
export function isExitTable(t: unknown): t is ExitTable {
  if (!t || typeof t !== "object") return false;
  const r = t as Record<string, unknown>;
  return NAMES.every((n) => Number.isInteger(r[n])) && (r.misplaced === undefined || Number.isInteger(r.misplaced));
}

/** `t` with chant#4624's `misplaced` filled from FALLBACK_EXIT when a chant before it left it out. */
export function withMisplaced(t: ExitTable): ExitTable {
  return Number.isInteger((t as Partial<ExitTable>).misplaced) ? t : Object.freeze({ ...t, misplaced: FALLBACK_EXIT.misplaced });
}

let cached: Promise<{ table: ExitTable; source: "chant" | "fallback" }> | undefined;

/**
 * chant's exit-code table when the installed chant exports one as
 * `CHANT_EXIT` from `@intentius/chant/exit-codes`, else FALLBACK_EXIT.
 * `source` says which, for `plywood --version --json`.
 */
export function exitCodes(): Promise<{ table: ExitTable; source: "chant" | "fallback" }> {
  cached ??= (async () => {
    try {
      // @ts-ignore: the subpath is missing from chant 0.124.54 (chant#4553).
      const m: unknown = await import("@intentius/chant/exit-codes");
      const table = (m as { CHANT_EXIT?: unknown }).CHANT_EXIT;
      if (isExitTable(table)) return { table: withMisplaced(table), source: "chant" as const };
    } catch {
      // The installed chant has no table: use the fallback.
    }
    return { table: FALLBACK_EXIT, source: "fallback" as const };
  })();
  return cached;
}
