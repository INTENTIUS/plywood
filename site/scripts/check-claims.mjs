// Runs before `astro build` (npm run build) and fails it when a page credits
// plunge with a claim plunge's claims page cannot back: a <WithPlunge> with no
// `claim`, a claim id src/data/plunge-claims.ts does not list, or a listed
// claim whose `row` names a run plunge's claims page does not have. A
// published page credits only a claim with a `row`; a claim with no recorded
// run stays on draft pages.
//
// plunge's page is read from PLUNGE_CLAIMS_MD (a path to plunge's
// site/src/content/docs/claims.md) when it is set, else from plunge's main
// branch on GitHub. A page that cannot be read fails the check: the build
// never credits a claim it could not check.
//
// It also reads src/data/claims.json, plywood's own claim rows (plywood#22),
// which e2e/claims.ts renders from the rows the bench on chant's e2e harness
// recorded (e2e-claims/v1). The build fails on a row with no run commit or
// date, a row whose scan was not CLEAN, and a row whose scenario or claim is
// not one of e2e/scenarios. Nobody writes a row by hand.
//
//   node scripts/check-claims.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PLUNGE_CLAIMS_DATA, PLUNGE_CLAIM_IDS } from '../src/data/plunge-claims.ts';
const RECORDED = new Set(PLUNGE_CLAIMS_DATA.filter((c) => c.row !== undefined).map((c) => c.id));
import { docPages } from '../src/lib/pages.mjs';

const RAW = 'https://raw.githubusercontent.com/INTENTIUS/plunge/main/site/src/content/docs/claims.md';
const problems = [];

for (const p of docPages()) {
	const src = readFileSync(p.file, 'utf8');
	for (const m of src.matchAll(/<WithPlunge\b([^>]*)\/?>/g)) {
		const claim = /\bclaim="([^"]*)"/.exec(m[1]);
		if (!claim) problems.push(`${p.file}: <WithPlunge> names no claim; add claim="<id>" from src/data/plunge-claims.ts`);
		else if (!PLUNGE_CLAIM_IDS.has(claim[1])) problems.push(`${p.file}: claim "${claim[1]}" is not in src/data/plunge-claims.ts`);
		else if (!p.draft && !RECORDED.has(claim[1])) problems.push(`${p.file}: a published page credits claim "${claim[1]}", which has no recorded run on plunge's claims page`);
	}
}

async function claimsPage() {
	if (process.env.PLUNGE_CLAIMS_MD) return readFileSync(process.env.PLUNGE_CLAIMS_MD, 'utf8');
	const res = await fetch(RAW);
	if (!res.ok) throw new Error(`${RAW} answered ${res.status}`);
	return res.text();
}

let page;
try {
	page = await claimsPage();
} catch (e) {
	problems.push(`plunge's claims page could not be read (${e.message}); set PLUNGE_CLAIMS_MD to plunge's site/src/content/docs/claims.md`);
}
if (page !== undefined) {
	const firstCells = page
		.split('\n')
		.filter((l) => l.startsWith('| ') && !/^\|\s*(Run|-+)\s*\|/.test(l))
		.map((l) => l.slice(2).split(' | ')[0].trim());
	for (const c of PLUNGE_CLAIMS_DATA) {
		if (c.row === undefined) {
			if (!c.waits) problems.push(`src/data/plunge-claims.ts: ${c.id} has no row and says nothing under waits`);
			continue;
		}
		if (!firstCells.some((cell) => cell.startsWith(c.row))) problems.push(`src/data/plunge-claims.ts: ${c.id}'s row "${c.row}" is not a run on plunge's claims page`);
	}
}

// plywood's own rows, rendered from the harness's ledger records.
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCENARIOS = join(REPO, 'e2e', 'scenarios');
const scenarioClaims = new Map(
	readdirSync(SCENARIOS)
		.filter((f) => f.endsWith('.json'))
		.map((f) => JSON.parse(readFileSync(join(SCENARIOS, f), 'utf8')))
		.map((s) => [s.id, s.claim]),
);
const OWN = 'src/data/claims.json';
let own;
try {
	own = JSON.parse(readFileSync(join(REPO, 'site', OWN), 'utf8'));
} catch (e) {
	problems.push(`${OWN} could not be read (${e.message})`);
}
if (own !== undefined) {
	if (own.product !== 'plywood' || own.contract !== 1 || !Array.isArray(own.rows)) problems.push(`${OWN} is not plywood's e2e-claims/v1 document`);
	for (const [i, r] of (Array.isArray(own.rows) ? own.rows : []).entries()) {
		const at = `${OWN} rows[${i}] (${r?.scenario ?? '?'})`;
		if (!/^[0-9a-f]{40}$/.test(r?.productCommit ?? '')) problems.push(`${at}: no run commit (productCommit)`);
		if (!/^\d{4}-\d{2}-\d{2}$/.test(r?.date ?? '')) problems.push(`${at}: no run date`);
		if (r?.safeRun !== 'CLEAN') problems.push(`${at}: its run's no-real-cloud scan is not CLEAN`);
		if (!scenarioClaims.has(r?.scenario)) problems.push(`${at}: no scenario ${r?.scenario} in e2e/scenarios`);
		else if (scenarioClaims.get(r.scenario) !== r.claim) problems.push(`${at}: claim ${r.claim} is not ${scenarioClaims.get(r.scenario)}, the scenario's`);
	}
}

for (const p of problems) console.error(`claims: ${p}`);
if (problems.length) process.exit(1);
console.log(`claims: ${PLUNGE_CLAIMS_DATA.length} plunge claims, ${PLUNGE_CLAIMS_DATA.filter((c) => c.row).length} with a recorded run on plunge's page; ${own?.rows?.length ?? 0} plywood rows from the harness`);
