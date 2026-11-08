/**
 * The exit codes plywood leaves with. plywood owns no table: every code is
 * chant's (INTENTIUS/chant#4553), passed through unchanged.
 */
import { CHANT_EXIT } from "@intentius/chant/exit-codes";

export type ExitName = keyof typeof CHANT_EXIT;

export type ExitTable = Readonly<Record<ExitName, number>>;

/** chant's exit-code table. */
export const EXIT: ExitTable = CHANT_EXIT;
