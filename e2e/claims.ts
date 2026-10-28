/**
 * plywood's claim rows: a scenario's plain and BREAK runs recorded through
 * the harness (`recordClaimRow`, which refuses unless the no-real-cloud scan
 * was CLEAN) as an `e2e-claim` run record on a ledger in the bench's state
 * directory, and rendered (`renderClaims`, e2e-claims/v1) into
 * site/src/data/claims.json, the file the site's claims check and pages
 * read (plywood#22). The site holds rendered rows only; nobody edits them by
 * hand.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendRunRecord, readRunLedger } from "@intentius/chant/lifecycle/run-ledger";
import type { ClaimRow, ClaimRun, ClaimsDoc, HarnessModule, LedgerRecord, Scenario, SafeRunInstance } from "./harness";
import { sh } from "./ports";

export const PRODUCT = "plywood";

/** The site file the rows are rendered into. */
export const claimsFile = (root: string): string => join(root, "site", "src", "data", "claims.json");

/** The ledger the rows are recorded on: a git repository in the state directory. */
export const claimsLedger = (state: string): string => join(state, "claims-ledger");

async function ensureLedger(dir: string): Promise<void> {
  mkdirSync(dir, { recursive: true });
  await sh("git", ["init", "-q", "-b", "main", dir]);
}

/** Record one claim run, then render every row into the site file. Returns the row. */
export async function recordAndRender(o: {
  h: HarnessModule;
  root: string;
  state: string;
  scenario: Scenario;
  run: ClaimRun;
  safe: Pick<SafeRunInstance, "scan">;
  engine: { binary: string; version: string };
  productCommit: string;
  chant: string;
  scanDirs?: string[];
}): Promise<{ row: ClaimRow; doc: ClaimsDoc }> {
  const verdict = o.safe.scan(o.scanDirs);
  const row = o.h.claimRow({ scenario: o.scenario, productCommit: o.productCommit, engine: o.engine, verdicts: o.run.verdicts, at: new Date(), floci: o.h.FLOCI_DIGEST, chant: o.chant });
  const ledger = claimsLedger(o.state);
  await ensureLedger(ledger);
  // recordClaimRow throws on a scan that was not CLEAN, and nothing is written.
  await o.h.recordClaimRow({ row, run: o.run, verdict, gitSha: o.productCommit, append: async (input) => void (await appendRunRecord(input as never, { cwd: ledger })) });
  const doc = await renderFromLedger(o.h, o.root, o.state);
  return { row, doc };
}

/** Render the ledger's rows into site/src/data/claims.json. */
export async function renderFromLedger(h: HarnessModule, root: string, state: string): Promise<ClaimsDoc> {
  const ledger = claimsLedger(state);
  await ensureLedger(ledger);
  const { records } = await readRunLedger("local", h.CLAIM_OP, { cwd: ledger });
  const doc = h.renderClaims(PRODUCT, h.claimRowsOf(records as unknown as LedgerRecord[]));
  writeFileSync(claimsFile(root), `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/** Problems with a rendered claims document, as the site build reads it (site/scripts/check-claims.mjs holds the same rules). */
export function claimsProblems(doc: unknown, scenarios: Readonly<Record<string, string>>): string[] {
  const out: string[] = [];
  const d = doc as Partial<ClaimsDoc>;
  if (d.product !== PRODUCT) out.push(`product is ${String(d.product)}, not ${PRODUCT}`);
  if (!Array.isArray(d.rows)) return [...out, "rows is not a list"];
  d.rows.forEach((r, i) => {
    const at = `rows[${i}] (${r?.scenario ?? "?"})`;
    if (!/^[0-9a-f]{40}$/.test(r?.productCommit ?? "")) out.push(`${at}: no run commit (productCommit, 40 hex)`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.date ?? "")) out.push(`${at}: no run date (YYYY-MM-DD)`);
    if (r?.safeRun !== "CLEAN") out.push(`${at}: the run's scan is not CLEAN`);
    if (scenarios[r?.scenario] === undefined) out.push(`${at}: no plywood scenario ${r?.scenario}`);
    else if (scenarios[r.scenario] !== r.claim) out.push(`${at}: claim ${r.claim} is not ${scenarios[r.scenario]}`);
  });
  return out;
}
