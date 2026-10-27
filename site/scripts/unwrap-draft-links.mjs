// Runs after `astro build` (npm run build), before the link checks. A
// production build leaves draft pages out, so a published page's link to a
// draft would lead nowhere. This keeps the link's text and drops the <a>, in
// every built .html file. Only links to known draft pages change; a link to a
// page that does not exist at all stays, and check-links.mjs fails on it.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE, draftPaths, sitePath } from '../src/lib/pages.mjs';

const dist = fileURLToPath(new URL('../dist', import.meta.url));
const drafts = draftPaths();
const files = [];
const walk = (dir) => {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (name.endsWith('.html')) files.push(p);
	}
};
walk(dist);

const ANCHOR = /<a\b([^>]*?)\shref="([^"]*)"([^>]*)>([\s\S]*?)<\/a>/g;
let changed = 0;
for (const file of files) {
	const html = readFileSync(file, 'utf8');
	const out = html.replace(ANCHOR, (whole, pre, href, post, inner) => {
		const local = href.startsWith(`${BASE}/`) || href.startsWith(`https://intentius.io${BASE}/`);
		const path = href.replace(/^https:\/\/intentius\.io/, '');
		if (!local || !drafts.has(sitePath(path))) return whole;
		changed++;
		return `<span class="pw-unlinked">${inner}</span>`;
	});
	if (out !== html) writeFileSync(file, out);
}
console.log(`unwrap: ${changed} link(s) to draft pages kept as text across ${files.length} built pages`);
