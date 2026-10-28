// Runs before `astro build` (npm run build) and fails it when a page credits
// plunge with a claim plunge's claims page cannot back: a <WithPlunge> with no
// `claim`, a claim id src/data/plunge-claims.ts does not list, or a listed
// claim whose `row` names a run plunge's claims page does not have.
//
// plunge's page is read from PLUNGE_CLAIMS_MD (a path to plunge's
// site/src/content/docs/claims.md) when it is set, else from plunge's main
// branch on GitHub. A page that cannot be read fails the check: the build
// never credits a claim it could not check.
//
//   node scripts/check-claims.mjs
import { readFileSync } from 'node:fs';
import { PLUNGE_CLAIMS_DATA, PLUNGE_CLAIM_IDS } from '../src/data/plunge-claims.ts';
import { docPages } from '../src/lib/pages.mjs';

const RAW = 'https://raw.githubusercontent.com/INTENTIUS/plunge/main/site/src/content/docs/claims.md';
const problems = [];

for (const p of docPages()) {
	const src = readFileSync(p.file, 'utf8');
	for (const m of src.matchAll(/<WithPlunge\b([^>]*)\/?>/g)) {
		const claim = /\bclaim="([^"]*)"/.exec(m[1]);
		if (!claim) problems.push(`${p.file}: <WithPlunge> names no claim; add claim="<id>" from src/data/plunge-claims.ts`);
		else if (!PLUNGE_CLAIM_IDS.has(claim[1])) problems.push(`${p.file}: claim "${claim[1]}" is not in src/data/plunge-claims.ts`);
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

for (const p of problems) console.error(`claims: ${p}`);
if (problems.length) process.exit(1);
console.log(`claims: ${PLUNGE_CLAIMS_DATA.length} plunge claims, ${PLUNGE_CLAIMS_DATA.filter((c) => c.row).length} with a recorded run on plunge's page`);
