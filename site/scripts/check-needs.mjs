// Runs before `astro build` (npm run build) and fails it when a page's
// `needs:` and `draft:` disagree (ruling 2). A page whose feature waits on an
// open issue lists it under `needs:` and is a draft, so the dev server shows it
// and a production build leaves it out. A draft with no needs, or needs on a
// published page, fails. A need is chant#<n>, plunge#<n>, plywood#<n>, or
// TBD-<slug> for a gap with no issue filed. When an issue closes, take it off
// every page; a page with none left drops `draft: true` and publishes.
//
//   node scripts/check-needs.mjs           # the check
//   node scripts/check-needs.mjs --list    # every need, with its pages
import { docPages } from '../src/lib/pages.mjs';

const NEED = /^((chant|plunge|plywood)#\d+|TBD-[a-z0-9-]+)$/;
const pages = docPages();
const problems = [];
const byNeed = new Map();
for (const p of pages) {
	if (p.draft && p.needs.length === 0) problems.push(`${p.file}: draft: true with no needs`);
	if (!p.draft && p.needs.length > 0) problems.push(`${p.file}: needs ${p.needs.join(', ')} but is not a draft`);
	for (const n of p.needs) {
		if (!NEED.test(n)) problems.push(`${p.file}: need "${n}" is not chant#<n>, plunge#<n>, plywood#<n> or TBD-<slug>`);
		if (!byNeed.has(n)) byNeed.set(n, []);
		byNeed.get(n).push(p.id || 'index');
	}
}
if (process.argv.includes('--list')) {
	for (const [n, ids] of [...byNeed].sort()) console.log(`${n}: ${ids.length} page(s)\n  ${ids.join('\n  ')}`);
}
for (const p of problems) console.error(`needs: ${p}`);
if (problems.length) process.exit(1);
const drafts = pages.filter((p) => p.draft).length;
console.log(`needs: ${pages.length} pages, ${pages.length - drafts} published, ${drafts} drafts waiting on ${byNeed.size} need(s)`);
