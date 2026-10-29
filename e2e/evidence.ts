/**
 * EVIDENCE.md, the repository's evidence page, rendered from the same data
 * the harness checks: the scenarios in e2e/scenarios (each with its claim id
 * and BREAK arm), the plunge features in e2e/plunge-claims.ts, and the rows
 * the bench recorded on its claims ledger (e2e-claims/v1). The published
 * docs site does not show any of it; each release updates this file
 * (AGENTS.md, Releasing) with `just e2e render`.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ClaimRow, Scenario } from "./harness";
import { PLUNGE_CLAIMS_DATA } from "./plunge-claims";
import { SCENARIO_CLAIMS, readScenario } from "./scenarios";

/** Where the page lives. */
export const evidenceFile = (root: string): string => join(root, "EVIDENCE.md");

const cell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();

function status(row: ClaimRow | undefined): string {
  if (!row) return "not recorded yet";
  if (row.plain === "pass" && row.break === "caught") return "recorded, passing";
  return `last run: plain ${row.plain}, break ${row.break}`;
}

/** The page, as text. `rows` are the recorded rows, newest last; the latest row per scenario counts. */
export function renderEvidence(rows: readonly ClaimRow[], scenarios: Readonly<Record<string, Scenario>> = readAll()): string {
  const latest = new Map<string, ClaimRow>();
  for (const r of rows) latest.set(r.scenario, r);
  const out: string[] = [];
  out.push(
    "# Evidence",
    "",
    "What plywood has been checked against, and how. Updated with each release (see Releasing in AGENTS.md). The page is rendered by `just e2e render` from the scenario files in `e2e/scenarios`, the plunge list in `e2e/plunge-claims.ts` and the rows the bench recorded; do not edit the tables by hand.",
    "",
    "## How it is verified",
    "",
    "Each scenario runs on the e2e bench (`just e2e`), on chant's e2e harness: a local Forgejo, a runner and the floci emulator, with no real cloud. A scenario runs twice. The plain arm must pass. The BREAK arm changes one thing so the claim should fail, and the scenario counts only if the check catches it. A row is recorded only when the run's scan for real-cloud credentials was clean, and it names the commit, date, engine and floci digest it ran on.",
    "",
    "## Scenarios",
    "",
    "| Scenario | Claim | What it checks | What the BREAK arm changes | Status | Commit | Date |",
    "|---|---|---|---|---|---|---|",
  );
  for (const id of Object.keys(SCENARIO_CLAIMS).sort()) {
    const s = scenarios[id];
    const r = latest.get(id);
    out.push(`| \`${id}\` | \`${SCENARIO_CLAIMS[id]}\` | ${cell(s?.title ?? "")} | ${cell(s?.break?.note ?? "")} | ${status(r)} | ${r ? `\`${r.productCommit.slice(0, 12)}\`` : ""} | ${r?.date ?? ""} |`);
  }
  out.push(
    "",
    "`pulumi-cloud/token` is a real-account run by the maintainer and stays out of the harness.",
    "",
    "## plunge features",
    "",
    "plywood's `engine: plunge` features rest on runs recorded on [plunge's evidence page](https://github.com/INTENTIUS/plunge/blob/main/EVIDENCE.md). A feature with no run listed waits on a plunge release.",
    "",
    "| Feature | What it says | Run on plunge's page | Waits on |",
    "|---|---|---|---|",
  );
  for (const c of PLUNGE_CLAIMS_DATA) out.push(`| \`${c.id}\` | ${cell(c.says)} | ${c.row ? cell(c.row) : ""} | ${c.waits ? cell(c.waits) : ""} |`);
  out.push("");
  return out.join("\n");
}

function readAll(): Record<string, Scenario> {
  return Object.fromEntries(Object.keys(SCENARIO_CLAIMS).map((id) => [id, readScenario(id)]));
}

/** Write the page. */
export function writeEvidence(root: string, rows: readonly ClaimRow[]): void {
  writeFileSync(evidenceFile(root), renderEvidence(rows));
}
