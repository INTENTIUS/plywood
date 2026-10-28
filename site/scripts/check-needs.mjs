// Runs before `astro build` (npm run build) and fails it when a page's
// `needs:` and `draft:` disagree (ruling 2). A page whose feature waits on an
// open issue lists it under `needs:` and is a draft, so the dev server shows it
// and a production build leaves it out. A draft with no needs, or needs on a
// published page, fails. A need is chant#<n>, plunge#<n>, plywood#<n>, or
// TBD-<slug> for a gap with no issue filed. When an issue closes, take it off
// every page; a page with none left drops `draft: true` and publishes. A
// published page names no issue in its text (`chant#12`, `INTENTIUS/plywood#3`
// or an issue URL): status lives in issues and release notes.
//
//   node scripts/check-needs.mjs            # the check
//   node scripts/check-needs.mjs --list     # every need, with its pages
//   node scripts/check-needs.mjs --closed   # each need whose issue closed, with its pages (reads gh)
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { docPages } from '../src/lib/pages.mjs';

const NEED = /^((chant|plunge|plywood)#\d+|TBD-[a-z0-9-]+)$/;
const ISSUE_REF = /\b(?:INTENTIUS\/)?(?:chant|plunge|plywood|terragucci|choudoufu)#\d+\b|github\.com\/INTENTIUS\/[\w.-]+\/(?:issues|pull)\/\d+/g;
const pages = docPages();
const problems = [];
const byNeed = new Map();
for (const p of pages) {
	if (p.draft && p.needs.length === 0) problems.push(`${p.file}: draft: true with no needs`);
	if (!p.draft && p.needs.length > 0) problems.push(`${p.file}: needs ${p.needs.join(', ')} but is not a draft`);
	if (!p.draft) {
		const body = readFileSync(p.file, 'utf8').replace(/^---\n[\s\S]*?\n---/, '');
		for (const m of body.matchAll(ISSUE_REF)) problems.push(`${p.file}: a published page names an issue (${m[0]}); status lives in issues and release notes`);
	}
	for (const n of p.needs) {
		if (!NEED.test(n)) problems.push(`${p.file}: need "${n}" is not chant#<n>, plunge#<n>, plywood#<n> or TBD-<slug>`);
		if (!byNeed.has(n)) byNeed.set(n, []);
		byNeed.get(n).push(p.id || 'index');
	}
}
if (process.argv.includes('--list')) {
	for (const [n, ids] of [...byNeed].sort()) console.log(`${n}: ${ids.length} page(s)\n  ${ids.join('\n  ')}`);
}
if (process.argv.includes('--closed')) {
	// A need closes when its issue does; TBD-<slug> needs have no issue to read.
	let closed = 0;
	for (const [n, ids] of [...byNeed].sort()) {
		const m = /^(chant|plunge|plywood)#(\d+)$/.exec(n);
		if (!m) continue;
		let state;
		try {
			state = execFileSync('gh', ['issue', 'view', m[2], '-R', `INTENTIUS/${m[1]}`, '--json', 'state', '-q', '.state'], { encoding: 'utf8' }).trim();
		} catch (e) {
			problems.push(`${n}: gh could not read the issue (${e.message.split('\n')[0]})`);
			continue;
		}
		if (state !== 'CLOSED') continue;
		closed++;
		console.log(`${n} closed: take it off ${ids.length} page(s)\n  ${ids.join('\n  ')}`);
	}
	console.log(`needs: ${closed} closed need(s)`);
}
for (const p of problems) console.error(`needs: ${p}`);
if (problems.length) process.exit(1);
const drafts = pages.filter((p) => p.draft).length;
console.log(`needs: ${pages.length} pages, ${pages.length - drafts} published, ${drafts} drafts waiting on ${byNeed.size} need(s)`);
